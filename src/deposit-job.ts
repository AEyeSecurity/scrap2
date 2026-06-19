import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { BrowserContext, Locator, Page } from 'playwright';
import type { Logger } from 'pino';
import { runAsnDepositJob } from './asn-funds-job';
import { ensureAuthenticated } from './auth';
import { acquireFundsSessionLease } from './funds-session-pool';
import {
  fetchRdaPaymentAgents,
  resolveRdaUserByApi,
  submitRdaPayment,
  type ResolvedRdaUser
} from './rda-user-api';
import { translateRdaJobError } from './rda-user-error';
import type {
  AppConfig,
  DepositJobRequest,
  FundsTransactionOperation,
  JobExecutionResult,
  JobStepResult,
  RdaFundsOperationResult
} from './types';

const NON_RETRYABLE_LOGIN_ERROR_REGEX =
  /usuario no autorizado|contrase(?:n|\u00f1)a\s+no\s+corregida|credenciales incorrectas|password/i;
const FUNDS_AMOUNT_INPUT_SELECTOR =
  'input[name="amount"], input[type="number"], input[placeholder*="cantidad" i], input[aria-label*="cantidad" i]';
const TARGET_PATH_BY_OPERATION: Record<FundsTransactionOperation, string> = {
  carga: '/users/deposit',
  descarga: '/users/withdraw',
  descarga_total: '/users/withdraw'
};
const TARGET_HEADING_BY_OPERATION: Record<FundsTransactionOperation, RegExp> = {
  carga: /dep[oó]sito/i,
  descarga: /retiro/i,
  descarga_total: /retiro/i
};

interface OperationStepNames {
  openAction: string;
  waitOperationPage: string;
  amountAction: string;
  clickSubmit: string;
  verifyResult: string;
}

interface FundsOutcomeSnapshot {
  userBalanceBefore: UserBalanceSnapshot | null;
  userId: string | null;
}

interface UserBalanceSnapshot {
  saldoTexto: string;
  saldoNumero: number;
}

function getOperationStepNames(operation: FundsTransactionOperation): OperationStepNames {
  if (operation === 'carga') {
    return {
      openAction: '04-open-user-deposit',
      waitOperationPage: '05-wait-deposit-page',
      amountAction: '06-fill-amount',
      clickSubmit: '07-click-deposit-submit',
      verifyResult: '08-verify-deposit-result'
    };
  }

  if (operation === 'descarga_total') {
    return {
      openAction: '04-open-user-withdraw',
      waitOperationPage: '05-wait-withdraw-page',
      amountAction: '06-fill-total-amount',
      clickSubmit: '07-click-withdraw-submit',
      verifyResult: '08-verify-withdraw-result'
    };
  }

  return {
    openAction: '04-open-user-withdraw',
    waitOperationPage: '05-wait-withdraw-page',
    amountAction: '06-fill-amount',
    clickSubmit: '07-click-withdraw-submit',
    verifyResult: '08-verify-withdraw-result'
  };
}

function sanitizeFileName(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
}

function parseEnvBoolean(input: string | undefined): boolean | undefined {
  if (input == null) {
    return undefined;
  }

  const normalized = input.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }

  return undefined;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatMoney(value: number): string {
  return roundMoney(value).toLocaleString('es-AR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function computeAppliedAmount(
  operation: FundsTransactionOperation,
  saldoAntesNumero: number,
  saldoDespuesNumero: number
): number {
  if (operation === 'carga') {
    return roundMoney(saldoDespuesNumero - saldoAntesNumero);
  }

  return roundMoney(saldoAntesNumero - saldoDespuesNumero);
}

async function captureStepScreenshot(page: Page, artifactDir: string, name: string): Promise<string> {
  const safe = sanitizeFileName(name || 'step');
  const filePath = path.join(artifactDir, `${safe}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
}

async function waitBeforeCloseIfHeaded(page: Page, headless: boolean, debug: boolean): Promise<void> {
  const delayMs = Number(process.env.DEPOSIT_DEBUG_CLOSE_DELAY_MS ?? 0);
  if (headless || !debug || !Number.isFinite(delayMs) || delayMs <= 0) {
    return;
  }

  await page.waitForTimeout(delayMs);
}

async function findFirstVisibleLocator(page: Page, selector: string, timeoutMs: number): Promise<Locator> {
  const startedAt = Date.now();
  const locator = page.locator(selector);

  while (Date.now() - startedAt < timeoutMs) {
    const count = await locator.count();
    for (let i = 0; i < count; i += 1) {
      const candidate = locator.nth(i);
      if (await candidate.isVisible().catch(() => false)) {
        return candidate;
      }
    }

    await page.waitForTimeout(100);
  }

  throw new Error(`No visible element found for selector: ${selector}`);
}

async function findDepositAmountInput(page: Page, timeoutMs: number): Promise<Locator> {
  try {
    return await findFirstVisibleLocator(page, FUNDS_AMOUNT_INPUT_SELECTOR, timeoutMs);
  } catch {
    return findFirstVisibleLocator(
      page,
      'xpath=//*[contains(translate(normalize-space(.), "CANTIDAD", "cantidad"), "cantidad")]/following::input[1]',
      timeoutMs
    );
  }
}

function getFundsOperationPath(operation: FundsTransactionOperation, userId: string): string {
  if (operation === 'carga') {
    return `/users/deposit/${userId}`;
  }

  return `/users/withdrawal/${userId}`;
}

async function openFundsOperationPageDirect(
  page: Page,
  operation: FundsTransactionOperation,
  userId: string,
  timeoutMs: number
): Promise<void> {
  await page.goto(getFundsOperationPath(operation, userId), { waitUntil: 'domcontentloaded', timeout: timeoutMs });
}

async function executeActionStep(
  page: Page,
  artifactDir: string,
  stepName: string,
  action: () => Promise<void>,
  captureOnSuccess: boolean
): Promise<JobStepResult> {
  const startedAt = new Date().toISOString();

  try {
    await action();
    const artifactPath = captureOnSuccess ? await captureStepScreenshot(page, artifactDir, stepName) : undefined;
    return {
      name: stepName,
      status: 'ok',
      startedAt,
      finishedAt: new Date().toISOString(),
      artifactPath
    };
  } catch (error) {
    return {
      name: stepName,
      status: 'failed',
      startedAt,
      finishedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function authenticateWithRetry(
  context: BrowserContext,
  page: Page,
  runtimeConfig: AppConfig,
  credentials: { username: string; password: string },
  logger: Logger,
  maxAttempts: number
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await ensureAuthenticated(context, page, runtimeConfig, credentials, logger, { persistSession: false });
      return;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (NON_RETRYABLE_LOGIN_ERROR_REGEX.test(message)) {
        throw (error instanceof Error ? error : new Error(message));
      }
      if (attempt >= maxAttempts) {
        break;
      }

      logger.warn(
        {
          attempt,
          maxAttempts,
          error: message
        },
        'Authentication attempt failed, retrying'
      );
      await page.waitForTimeout(1_500);
    }
  }

  throw (lastError instanceof Error ? lastError : new Error(String(lastError ?? 'Unknown authentication error')));
}

async function waitForDepositPage(
  page: Page,
  operation: FundsTransactionOperation,
  timeoutMs: number,
  pollingMs: number
): Promise<void> {
  const startedAt = Date.now();
  const targetPath = TARGET_PATH_BY_OPERATION[operation];
  const headingRegex = TARGET_HEADING_BY_OPERATION[operation];

  while (Date.now() - startedAt < timeoutMs) {
    if (operation === 'descarga' || operation === 'descarga_total') {
      const withdrawLayoutVisible = await page.locator('.withdrawal__inputs, form').first().isVisible().catch(() => false);
      if (page.url().includes(targetPath) && withdrawLayoutVisible) {
        return;
      }
    }

    if (page.url().includes(targetPath)) {
      return;
    }

    const headingVisible = await page.getByRole('heading', { name: headingRegex }).first().isVisible().catch(() => false);
    if (headingVisible) {
      return;
    }

    await page.waitForTimeout(pollingMs);
  }

  throw new Error(`Operation page did not open for "${operation}" within timeout`);
}

function computeExpectedUserBalance(
  operation: FundsTransactionOperation,
  amount: number | undefined,
  beforeBalance: number | null
): number | null {
  if (beforeBalance == null) {
    return null;
  }

  if (operation === 'carga') {
    if (typeof amount !== 'number') {
      return null;
    }
    return beforeBalance + amount;
  }

  if (operation === 'descarga') {
    if (typeof amount !== 'number') {
      return null;
    }
    return beforeBalance - amount;
  }

  if (operation === 'descarga_total') {
    return 0;
  }

  return null;
}

function createBalanceSnapshot(balance: number): UserBalanceSnapshot {
  const saldoNumero = roundMoney(balance);
  return {
    saldoNumero,
    saldoTexto: formatMoney(saldoNumero)
  };
}

function resolveRequestedRdaAmount(
  operation: FundsTransactionOperation,
  requestAmount: number | undefined,
  beforeBalance: number | null
): number {
  if (operation === 'descarga_total') {
    if (beforeBalance == null) {
      throw new Error('Could not resolve total withdrawal amount before submit');
    }
    return roundMoney(beforeBalance);
  }

  if (typeof requestAmount !== 'number') {
    throw new Error(`cantidad is required for "${operation}" operation`);
  }

  return roundMoney(requestAmount);
}

async function fillAmountInputIfVisible(page: Page, amount: number, timeoutMs: number): Promise<void> {
  const amountInput = await findDepositAmountInput(page, Math.min(timeoutMs, 2_000)).catch(() => undefined);
  if (!amountInput) {
    return;
  }

  await amountInput.fill('', { timeout: Math.min(timeoutMs, 2_000) }).catch(() => undefined);
  await amountInput.fill(String(amount), { timeout: Math.min(timeoutMs, 2_000) }).catch(() => undefined);
  await amountInput.press('Tab', { timeout: Math.min(timeoutMs, 2_000) }).catch(() => undefined);
}

async function submitFundsOperationByApi(
  page: Page,
  operation: FundsTransactionOperation,
  userId: string,
  amount: number,
  timeoutMs: number
): Promise<void> {
  const paymentAgents = await fetchRdaPaymentAgents(page, userId, timeoutMs);
  await submitRdaPayment(
    page,
    {
      userId,
      amount,
      operation: operation === 'carga' ? 0 : 1,
      paymentAgentId: paymentAgents.defaultAgentId
    },
    timeoutMs
  );
}

async function waitForRdaExpectedBalance(
  page: Page,
  username: string,
  agentId: string,
  expectedBalance: number,
  timeoutMs: number,
  pollingMs: number
): Promise<UserBalanceSnapshot> {
  const startedAt = Date.now();
  const expected = roundMoney(expectedBalance);
  let lastBalance: number | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    const resolved = await resolveRdaUserByApi(page, username, Math.max(1_000, Math.min(remainingMs, 5_000)), agentId);
    lastBalance = roundMoney(resolved.user.balance);

    if (Math.abs(lastBalance - expected) < 0.005) {
      return createBalanceSnapshot(lastBalance);
    }

    await page.waitForTimeout(Math.min(pollingMs, Math.max(100, timeoutMs - (Date.now() - startedAt))));
  }

  const lastBalanceText = lastBalance == null ? 'sin lectura final' : formatMoney(lastBalance);
  throw new Error(
    `RdA API balance did not reach expected value for user "${username}" (expected ${formatMoney(expected)}, last ${lastBalanceText})`
  );
}

export async function runDepositJob(request: DepositJobRequest, appConfig: AppConfig, logger: Logger): Promise<JobExecutionResult> {
  if (request.payload.pagina === 'ASN') {
    return runAsnDepositJob(request, appConfig, logger);
  }

  const operation = request.payload.operacion;
  const stepNames = getOperationStepNames(operation);
  const jobLogger = logger.child({ jobId: request.id, jobType: request.jobType, operation });
  const artifactDir = path.join(appConfig.artifactsDir, 'jobs', request.id);
  const runtimeConfig: AppConfig = {
    ...appConfig,
    headless: request.options.headless,
    debug: request.options.debug,
    slowMo: request.options.slowMo,
    timeoutMs: request.options.timeoutMs,
    postLoginWarmupPath: undefined
  };
  const isTurbo = !runtimeConfig.debug && runtimeConfig.slowMo === 0;
  const captureSuccessArtifacts = parseEnvBoolean(process.env.DEPOSIT_CAPTURE_SUCCESS_ARTIFACTS) ?? false;
  const pollingMs = isTurbo ? 100 : 250;
  const depositPageTimeoutMs = isTurbo ? Math.min(runtimeConfig.timeoutMs, 5_000) : runtimeConfig.timeoutMs;
  // RDA withdrawals can redirect back to the authenticated shell a few seconds after submit in Docker.
  // A slightly longer turbo verify window avoids false negatives while keeping the job fast.
  const verifyTimeoutMs = isTurbo
    ? Math.min(runtimeConfig.timeoutMs, operation === 'carga' ? 5_000 : 10_000)
    : runtimeConfig.timeoutMs;

  await fs.mkdir(artifactDir, { recursive: true });
  const lease = await acquireFundsSessionLease(request.payload.agente, runtimeConfig, jobLogger, {
    forceIsolated: request.payload.pagina === 'RdA'
  });
  const context = lease.context;
  const page = lease.page;
  const artifactPaths: string[] = [];
  const steps: JobStepResult[] = [];
  const tracePath = path.join(artifactDir, 'trace.zip');
  const traceFailurePath = path.join(artifactDir, 'trace-failure.zip');
  const screenshotFailurePath = path.join(artifactDir, 'error.png');
  let resolvedRdaUser: ResolvedRdaUser | null = null;
  const fundsSnapshot: FundsOutcomeSnapshot = {
    userBalanceBefore: null,
    userId: null
  };

  let tracingStarted = false;

  try {
    if (runtimeConfig.debug) {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      tracingStarted = true;
    }

    const loginStartedAt = new Date().toISOString();
    await authenticateWithRetry(
      context,
      page,
      runtimeConfig,
      {
        username: request.payload.agente,
        password: request.payload.contrasena_agente
      },
      jobLogger,
      1
    );
    const loginArtifact = captureSuccessArtifacts ? await captureStepScreenshot(page, artifactDir, '00-login') : undefined;
    if (loginArtifact) {
      artifactPaths.push(loginArtifact);
    }
    steps.push({
      name: '00-login',
      status: 'ok',
      startedAt: loginStartedAt,
      finishedAt: new Date().toISOString(),
      ...(loginArtifact ? { artifactPath: loginArtifact } : {})
    });

    const resolveUserStep = await executeActionStep(page, artifactDir, '01-resolve-rda-user', async () => {
      resolvedRdaUser = await resolveRdaUserByApi(page, request.payload.usuario, runtimeConfig.timeoutMs);
      fundsSnapshot.userBalanceBefore = createBalanceSnapshot(resolvedRdaUser.user.balance);
      fundsSnapshot.userId = resolvedRdaUser.user.id;
    }, captureSuccessArtifacts);
    if (resolveUserStep.artifactPath) {
      artifactPaths.push(resolveUserStep.artifactPath);
    }
    steps.push(resolveUserStep);
    if (resolveUserStep.status === 'failed') {
      throw new Error(`Step failed: ${resolveUserStep.name} (${resolveUserStep.error ?? 'unknown error'})`);
    }

    const openDepositStep = await executeActionStep(page, artifactDir, stepNames.openAction, async () => {
      if (!resolvedRdaUser) {
        throw new Error(`RdA user "${request.payload.usuario}" was not resolved before opening operation page`);
      }

      await openFundsOperationPageDirect(page, operation, resolvedRdaUser.user.id, runtimeConfig.timeoutMs);
    }, captureSuccessArtifacts);
    if (openDepositStep.artifactPath) {
      artifactPaths.push(openDepositStep.artifactPath);
    }
    steps.push(openDepositStep);
    if (openDepositStep.status === 'failed') {
      throw new Error(`Step failed: ${openDepositStep.name} (${openDepositStep.error ?? 'unknown error'})`);
    }

    const waitDepositPageStep = await executeActionStep(page, artifactDir, stepNames.waitOperationPage, async () => {
      await waitForDepositPage(page, operation, depositPageTimeoutMs, pollingMs);
    }, captureSuccessArtifacts);
    if (waitDepositPageStep.artifactPath) {
      artifactPaths.push(waitDepositPageStep.artifactPath);
    }
    steps.push(waitDepositPageStep);
    if (waitDepositPageStep.status === 'failed') {
      throw new Error(`Step failed: ${waitDepositPageStep.name} (${waitDepositPageStep.error ?? 'unknown error'})`);
    }

    const amountStep = await executeActionStep(page, artifactDir, stepNames.amountAction, async () => {
      const resolvedAmount = resolveRequestedRdaAmount(
        operation,
        request.payload.cantidad,
        fundsSnapshot.userBalanceBefore?.saldoNumero ?? null
      );
      if (operation === 'descarga_total') {
        await fillAmountInputIfVisible(page, resolvedAmount, runtimeConfig.timeoutMs);
        return;
      }

      const amountInput = await findDepositAmountInput(page, runtimeConfig.timeoutMs);
      await amountInput.fill('', { timeout: runtimeConfig.timeoutMs });
      await amountInput.fill(String(resolvedAmount), { timeout: runtimeConfig.timeoutMs });
      await amountInput.press('Tab', { timeout: Math.min(runtimeConfig.timeoutMs, 2_000) }).catch(() => undefined);
    }, captureSuccessArtifacts);
    if (amountStep.artifactPath) {
      artifactPaths.push(amountStep.artifactPath);
    }
    steps.push(amountStep);
    if (amountStep.status === 'failed') {
      throw new Error(`Step failed: ${amountStep.name} (${amountStep.error ?? 'unknown error'})`);
    }

    const clickDepositStep = await executeActionStep(page, artifactDir, stepNames.clickSubmit, async () => {
      if (!resolvedRdaUser) {
        throw new Error(`RdA user "${request.payload.usuario}" was not resolved before submitting operation`);
      }

      const resolvedAmount = resolveRequestedRdaAmount(
        operation,
        request.payload.cantidad,
        fundsSnapshot.userBalanceBefore?.saldoNumero ?? null
      );
      await submitFundsOperationByApi(page, operation, resolvedRdaUser.user.id, resolvedAmount, runtimeConfig.timeoutMs);
    }, captureSuccessArtifacts);
    if (clickDepositStep.artifactPath) {
      artifactPaths.push(clickDepositStep.artifactPath);
    }
    steps.push(clickDepositStep);
    if (clickDepositStep.status === 'failed') {
      throw new Error(`Step failed: ${clickDepositStep.name} (${clickDepositStep.error ?? 'unknown error'})`);
    }

    const balanceAfterSnapshotRef: { value: UserBalanceSnapshot | null } = { value: null };
    const verifyStep = await executeActionStep(page, artifactDir, stepNames.verifyResult, async () => {
      if (!resolvedRdaUser) {
        throw new Error(`RdA user "${request.payload.usuario}" was not resolved before verifying balance`);
      }

      const expectedBalance = computeExpectedUserBalance(
        operation,
        request.payload.operacion === 'descarga_total' ? undefined : request.payload.cantidad,
        fundsSnapshot.userBalanceBefore?.saldoNumero ?? null
      );
      if (expectedBalance == null) {
        throw new Error(`Could not compute expected balance for "${operation}" operation`);
      }

      balanceAfterSnapshotRef.value = await waitForRdaExpectedBalance(
        page,
        request.payload.usuario,
        resolvedRdaUser.agentId,
        expectedBalance,
        verifyTimeoutMs,
        pollingMs
      );
    }, captureSuccessArtifacts);
    if (verifyStep.artifactPath) {
      artifactPaths.push(verifyStep.artifactPath);
    }
    steps.push(verifyStep);
    if (verifyStep.status === 'failed') {
      throw new Error(`Step failed: ${verifyStep.name} (${verifyStep.error ?? 'unknown error'})`);
    }

    if (captureSuccessArtifacts) {
      const finalArtifact = await captureStepScreenshot(page, artifactDir, '99-final');
      artifactPaths.push(finalArtifact);
      steps.push({
        name: '99-final',
        status: 'ok',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        artifactPath: finalArtifact
      });
    } else {
      steps.push({
        name: '99-final',
        status: 'ok',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString()
      });
    }

    if (tracingStarted) {
      await context.tracing.stop({ path: tracePath });
      artifactPaths.push(tracePath);
      tracingStarted = false;
    }

    await waitBeforeCloseIfHeaded(page, runtimeConfig.headless, runtimeConfig.debug);
    await lease.release();

    let result: RdaFundsOperationResult | undefined;
    const balanceAfterSnapshot = balanceAfterSnapshotRef.value;
    if (fundsSnapshot.userBalanceBefore && balanceAfterSnapshot) {
      const montoAplicado = computeAppliedAmount(
        operation,
        fundsSnapshot.userBalanceBefore.saldoNumero,
        balanceAfterSnapshot.saldoNumero
      );
      const montoSolicitado =
        operation === 'descarga_total'
          ? montoAplicado
          : roundMoney(typeof request.payload.cantidad === 'number' ? request.payload.cantidad : montoAplicado);

      result = {
        kind: 'rda-funds-operation',
        pagina: 'RdA',
        operacion: operation,
        usuario: request.payload.usuario,
        montoSolicitado,
        montoAplicado,
        montoAplicadoTexto: formatMoney(montoAplicado),
        saldoAntesNumero: roundMoney(fundsSnapshot.userBalanceBefore.saldoNumero),
        saldoAntesTexto: fundsSnapshot.userBalanceBefore.saldoTexto,
        saldoDespuesNumero: roundMoney(balanceAfterSnapshot.saldoNumero),
        saldoDespuesTexto: balanceAfterSnapshot.saldoTexto
      };
    }

    return {
      artifactPaths,
      steps,
      result
    };
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = translateRdaJobError(rawMessage, {
      usuario: request.payload.usuario,
      operacion: request.payload.operacion
    });
    jobLogger.error({ error }, 'Deposit job failed');

    try {
      await page.screenshot({ path: screenshotFailurePath, fullPage: true });
      artifactPaths.push(screenshotFailurePath);
    } catch {
      jobLogger.warn('Could not capture deposit failure screenshot');
    }

    if (tracingStarted) {
      try {
        await context.tracing.stop({ path: traceFailurePath });
        artifactPaths.push(traceFailurePath);
      } catch {
        jobLogger.warn('Could not persist deposit failure trace');
      }
    }

    await waitBeforeCloseIfHeaded(page, runtimeConfig.headless, runtimeConfig.debug).catch(() => undefined);
    await lease.invalidate().catch(() => undefined);

    const wrapped = new Error(message);
    (wrapped as Error & { steps?: JobStepResult[]; artifactPaths?: string[] }).steps = steps;
    (wrapped as Error & { steps?: JobStepResult[]; artifactPaths?: string[] }).artifactPaths = artifactPaths;
    throw wrapped;
  }
}
