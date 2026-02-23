import path from 'node:path';
import { promises as fs } from 'node:fs';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import type { Logger } from 'pino';
import { ensureAuthenticated } from './auth';
import { configureContext } from './browser';
import { normalizeDepositText, selectDepositRowIndex, type DepositRowCandidate } from './deposit-match';
import type {
  AppConfig,
  DepositJobRequest,
  FundsTransactionOperation,
  JobExecutionResult,
  JobStepResult
} from './types';

const USERS_FILTER_INPUT_SELECTOR = 'input[placeholder*="Jugador/Agente" i]';
const USERS_ROW_SELECTOR = '.users-table-item';
const USERS_USERNAME_SELECTOR = '.role-bar__user-block11, .ellipsis-text, .role-bar__user-block1, .users-table-item__user-info';
const USERS_APPLY_FILTER_SELECTOR =
  'button:has-text("Aceptar filtro"), button:has-text("Aplicar"), button:has-text("Filtrar"), button:has-text("Buscar")';
const USER_ACTION_SELECTOR = 'div.users-table-item__button, a.button-desktop, a, button, [role="button"]';
const USER_ACTION_CLICKABLE_SELECTOR = 'a.button-desktop, a, button, [role="button"]';
const NON_RETRYABLE_LOGIN_ERROR_REGEX =
  /usuario no autorizado|contrase(?:n|\u00f1)a\s+no\s+corregida|credenciales incorrectas|password/i;
const FUNDS_AMOUNT_INPUT_SELECTOR =
  'input[name="amount"], input[type="number"], input[placeholder*="cantidad" i], input[aria-label*="cantidad" i]';
const TOTAL_AMOUNT_TEXT_REGEX = /\btoda\b/i;
const ACTION_LINK_BY_OPERATION: Record<FundsTransactionOperation, string> = {
  carga: 'a[href*="/users/deposit/"]',
  descarga: 'a[href*="/users/withdraw/"]',
  descarga_total: 'a[href*="/users/withdraw/"]'
};
const ACTION_TEXT_BY_OPERATION: Record<FundsTransactionOperation, RegExp> = {
  carga: /dep[oó]sito/i,
  descarga: /retiro/i,
  descarga_total: /retiro/i
};
const SUBMIT_TEXT_BY_OPERATION: Record<FundsTransactionOperation, RegExp> = {
  carga: /dep[oó]sito/i,
  descarga: /retiro/i,
  descarga_total: /retiro/i
};
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
const SUCCESS_MESSAGE_BY_OPERATION: Record<FundsTransactionOperation, RegExp> = {
  carga: /depositad[oa]|acreditad[oa]|transferencia realizada|correctamente|exito|success|completad[oa]/i,
  descarga: /retirad[oa]|debitad[oa]|transferencia realizada|correctamente|exito|success|completad[oa]/i,
  descarga_total: /retirad[oa]|debitad[oa]|transferencia realizada|correctamente|exito|success|completad[oa]/i
};
const ERROR_MESSAGE_REGEX =
  /saldo insuficiente|error|fall[oó]|fallid[oa]|invalido|invalid|no se pudo|incorrect[oa]|rechazad[oa]/i;

interface OperationStepNames {
  openAction: string;
  waitOperationPage: string;
  amountAction: string;
  clickSubmit: string;
  verifyResult: string;
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
      amountAction: '06-click-total-amount',
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

async function findFirstEnabledVisibleInLocator(locator: Locator, timeoutMs: number, pollingMs: number): Promise<Locator> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const count = await locator.count();
    for (let i = 0; i < count; i += 1) {
      const candidate = locator.nth(i);
      const isVisible = await candidate.isVisible().catch(() => false);
      if (!isVisible) {
        continue;
      }

      const isDisabled = await candidate.isDisabled().catch(() => false);
      if (!isDisabled) {
        return candidate;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollingMs));
  }

  throw new Error('No enabled visible element found in locator');
}

async function clickLocator(locator: Locator, timeoutMs: number): Promise<void> {
  await locator.scrollIntoViewIfNeeded({ timeout: timeoutMs }).catch(() => undefined);
  try {
    await locator.click({ timeout: timeoutMs });
  } catch {
    await locator.click({ timeout: timeoutMs, force: true });
  }
}

async function findUsersFilterInput(page: Page, timeoutMs: number): Promise<Locator> {
  try {
    return await findFirstVisibleLocator(page, USERS_FILTER_INPUT_SELECTOR, timeoutMs);
  } catch {
    return findFirstVisibleLocator(
      page,
      'xpath=//*[contains(translate(normalize-space(.), "JUGADOR/AGENTE", "jugador/agente"), "jugador/agente")]/following::input[1]',
      timeoutMs
    );
  }
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

async function waitForUsersFilterOutcome(
  page: Page,
  operation: FundsTransactionOperation,
  username: string,
  timeoutMs: number,
  pollingMs: number
): Promise<void> {
  const startedAt = Date.now();
  const userPattern = new RegExp(escapeRegex(username), 'i');
  const noResults = page
    .locator('text=/sin resultados|no se encontraron|sin coincidencias|ningun resultado|no records|no data/i')
    .first();

  while (Date.now() - startedAt < timeoutMs) {
    const visibleActions = await countVisibleInLocator(getOperationActions(page, operation));
    if (visibleActions > 0) {
      return;
    }

    const userVisible = await page
      .getByText(userPattern)
      .first()
      .isVisible()
      .catch(() => false);
    if (userVisible) {
      return;
    }

    const hasNoResults = await noResults.isVisible().catch(() => false);
    if (hasNoResults) {
      return;
    }

    await page.waitForTimeout(pollingMs);
  }

  throw new Error('Users table did not refresh after applying filter');
}

function getOperationActions(
  scope: { locator: (selector: string) => Locator },
  operation: FundsTransactionOperation
): Locator {
  return scope.locator(USER_ACTION_SELECTOR).filter({ hasText: ACTION_TEXT_BY_OPERATION[operation] });
}

async function countVisibleInLocator(locator: Locator): Promise<number> {
  const count = await locator.count();
  let visible = 0;
  for (let i = 0; i < count; i += 1) {
    const candidate = locator.nth(i);
    if (await candidate.isVisible().catch(() => false)) {
      visible += 1;
    }
  }

  return visible;
}

async function findFirstVisibleInLocator(locator: Locator, timeoutMs: number, pollingMs: number): Promise<Locator> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const count = await locator.count();
    for (let i = 0; i < count; i += 1) {
      const candidate = locator.nth(i);
      if (await candidate.isVisible().catch(() => false)) {
        return candidate;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollingMs));
  }

  throw new Error('No visible candidate found in locator');
}

async function collectDepositRowCandidates(
  page: Page,
  operation: FundsTransactionOperation
): Promise<DepositRowCandidate[]> {
  const rows = page.locator(USERS_ROW_SELECTOR);
  const count = await rows.count();
  const candidates: DepositRowCandidate[] = [];

  for (let i = 0; i < count; i += 1) {
    const row = rows.nth(i);
    const isVisible = await row.isVisible().catch(() => false);
    if (!isVisible) {
      continue;
    }

    const usernamesRaw = await row.locator(USERS_USERNAME_SELECTOR).allInnerTexts().catch(() => []);
    const usernames = usernamesRaw.map((value) => value.trim()).filter(Boolean);
    const rowTextRaw = await row.innerText().catch(() => '');
    const hasAction = (await countVisibleInLocator(getOperationActions(row, operation))) > 0;

    candidates.push({
      index: i,
      hasAction,
      usernames,
      normalizedText: normalizeDepositText(rowTextRaw)
    });
  }

  return candidates;
}

async function findDepositActionInRow(
  row: Locator,
  operation: FundsTransactionOperation,
  timeoutMs: number,
  pollingMs: number
): Promise<Locator> {
  const byHref = row.locator(ACTION_LINK_BY_OPERATION[operation]);
  const hrefVisible = await findFirstVisibleInLocator(byHref, timeoutMs, pollingMs).catch(() => undefined);
  if (hrefVisible) {
    return hrefVisible;
  }

  const preferred = row.locator(USER_ACTION_CLICKABLE_SELECTOR).filter({ hasText: ACTION_TEXT_BY_OPERATION[operation] });
  const preferredVisible = await findFirstVisibleInLocator(preferred, timeoutMs, pollingMs).catch(() => undefined);
  if (preferredVisible) {
    return preferredVisible;
  }

  const fallback = row.locator('div.users-table-item__button').filter({ hasText: ACTION_TEXT_BY_OPERATION[operation] });
  return findFirstVisibleInLocator(fallback, timeoutMs, pollingMs);
}

async function findSubmitDepositAction(
  page: Page,
  operation: FundsTransactionOperation,
  timeoutMs: number,
  pollingMs: number
): Promise<Locator> {
  const candidates = page.locator(USER_ACTION_CLICKABLE_SELECTOR).filter({ hasText: SUBMIT_TEXT_BY_OPERATION[operation] });
  return findFirstEnabledVisibleInLocator(candidates, timeoutMs, pollingMs);
}

async function clickTotalAmountAction(page: Page, timeoutMs: number, pollingMs: number): Promise<void> {
  const totalCandidates = page.locator(USER_ACTION_CLICKABLE_SELECTOR).filter({ hasText: TOTAL_AMOUNT_TEXT_REGEX });
  const totalButton = await findFirstEnabledVisibleInLocator(totalCandidates, timeoutMs, pollingMs).catch(() => undefined);
  if (!totalButton) {
    throw new Error('Could not find enabled "Toda" button for total withdraw');
  }

  await clickLocator(totalButton, timeoutMs);

  const amountInput = await findDepositAmountInput(page, Math.min(timeoutMs, 2_000)).catch(() => undefined);
  if (amountInput) {
    const value = (await amountInput.inputValue().catch(() => '')).trim();
    if (!/[1-9]/.test(value)) {
      throw new Error('Total withdraw did not populate a non-zero amount after clicking "Toda"');
    }
  }
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

async function findUniqueUserDepositButton(
  page: Page,
  operation: FundsTransactionOperation,
  username: string,
  timeoutMs: number,
  pollingMs: number
): Promise<Locator> {
  const startedAt = Date.now();
  let lastError = `Could not find an actionable row for user "${username}"`;
  const rows = page.locator(USERS_ROW_SELECTOR);

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const candidates = await collectDepositRowCandidates(page, operation);
      const selectedIndex = selectDepositRowIndex(candidates, username);
      const selectedRow = rows.nth(selectedIndex);
      return await findDepositActionInRow(selectedRow, operation, pollingMs * 2, pollingMs);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await page.waitForTimeout(pollingMs);
  }

  throw new Error(lastError);
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

async function waitForUserVisibleInDepositPage(
  page: Page,
  username: string,
  timeoutMs: number,
  pollingMs: number
): Promise<boolean> {
  const startedAt = Date.now();
  const pattern = new RegExp(escapeRegex(username), 'i');

  while (Date.now() - startedAt < timeoutMs) {
    const visible = await page
      .getByText(pattern)
      .first()
      .isVisible()
      .catch(() => false);
    if (visible) {
      return true;
    }

    await page.waitForTimeout(pollingMs);
  }

  return false;
}

async function waitForDepositResult(
  page: Page,
  operation: FundsTransactionOperation,
  submittedUrl: string,
  timeoutMs: number,
  pollingMs: number
): Promise<{ state: 'success' | 'error' | 'unknown'; reason: string }> {
  const startedAt = Date.now();
  const targetPath = TARGET_PATH_BY_OPERATION[operation];
  const successMessage = page.locator('body').getByText(SUCCESS_MESSAGE_BY_OPERATION[operation]).first();
  const errorMessage = page.locator('body').getByText(ERROR_MESSAGE_REGEX).first();

  while (Date.now() - startedAt < timeoutMs) {
    if (await errorMessage.first().isVisible().catch(() => false)) {
      const text = (await errorMessage.first().innerText().catch(() => '')).trim();
      return { state: 'error', reason: text || `Error message detected after ${operation} submit` };
    }

    if (await successMessage.first().isVisible().catch(() => false)) {
      const text = (await successMessage.first().innerText().catch(() => '')).trim();
      return { state: 'success', reason: text || `Success message detected after ${operation} submit` };
    }

    const currentUrl = page.url();
    if (currentUrl !== submittedUrl && !currentUrl.includes(targetPath)) {
      return { state: 'success', reason: `URL changed after submit: ${currentUrl}` };
    }

    await page.waitForTimeout(pollingMs);
  }

  return { state: 'unknown', reason: `No clear success signal detected after ${operation} submit` };
}

async function verifyDepositResultStep(
  page: Page,
  operation: FundsTransactionOperation,
  artifactDir: string,
  stepName: string,
  submittedUrl: string,
  timeoutMs: number,
  pollingMs: number,
  captureOnSuccess: boolean
): Promise<JobStepResult> {
  const startedAt = new Date().toISOString();

  try {
    const outcome = await waitForDepositResult(page, operation, submittedUrl, timeoutMs, pollingMs);
    const artifactPath = captureOnSuccess ? await captureStepScreenshot(page, artifactDir, stepName) : undefined;

    if (outcome.state === 'success') {
      return {
        name: stepName,
        status: 'ok',
        startedAt,
        finishedAt: new Date().toISOString(),
        artifactPath
      };
    }

    return {
      name: stepName,
      status: 'failed',
      startedAt,
      finishedAt: new Date().toISOString(),
      artifactPath,
      error: outcome.reason
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

export async function runDepositJob(request: DepositJobRequest, appConfig: AppConfig, logger: Logger): Promise<JobExecutionResult> {
  const operation = request.payload.operacion;
  const stepNames = getOperationStepNames(operation);
  const jobLogger = logger.child({ jobId: request.id, jobType: request.jobType, operation });
  const artifactDir = path.join(appConfig.artifactsDir, 'jobs', request.id);
  const runtimeConfig: AppConfig = {
    ...appConfig,
    headless: request.options.headless,
    debug: request.options.debug,
    slowMo: request.options.slowMo,
    timeoutMs: request.options.timeoutMs
  };
  const isTurbo = !runtimeConfig.debug && runtimeConfig.slowMo === 0;
  const captureSuccessArtifacts = parseEnvBoolean(process.env.DEPOSIT_CAPTURE_SUCCESS_ARTIFACTS) ?? false;
  const pollingMs = isTurbo ? 100 : 250;
  const filterOutcomeTimeoutMs = isTurbo ? Math.min(runtimeConfig.timeoutMs, 4_000) : Math.min(runtimeConfig.timeoutMs, 10_000);
  const depositSearchTimeoutMs = isTurbo ? Math.min(runtimeConfig.timeoutMs, 5_000) : runtimeConfig.timeoutMs;
  const depositPageTimeoutMs = isTurbo ? Math.min(runtimeConfig.timeoutMs, 5_000) : runtimeConfig.timeoutMs;
  const verifyTimeoutMs = isTurbo ? Math.min(runtimeConfig.timeoutMs, 5_000) : runtimeConfig.timeoutMs;

  await fs.mkdir(artifactDir, { recursive: true });

  const browser = await chromium.launch({
    headless: runtimeConfig.headless,
    slowMo: runtimeConfig.slowMo,
    args: runtimeConfig.headless ? undefined : ['--start-maximized']
  });

  const context = await browser.newContext({
    baseURL: runtimeConfig.baseUrl,
    viewport: runtimeConfig.headless ? { width: 1920, height: 1080 } : null,
    recordVideo: runtimeConfig.debug
      ? {
          dir: path.join(artifactDir, 'video')
        }
      : undefined
  });

  await configureContext(context, runtimeConfig, jobLogger);

  const page = await context.newPage();
  const artifactPaths: string[] = [];
  const steps: JobStepResult[] = [];
  const tracePath = path.join(artifactDir, 'trace.zip');
  const traceFailurePath = path.join(artifactDir, 'trace-failure.zip');
  const screenshotFailurePath = path.join(artifactDir, 'error.png');
  let usersFilterInput: Locator | undefined;

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
      2
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

    const gotoUsersStep = await executeActionStep(page, artifactDir, '01-goto-users-all', async () => {
      await page.goto('/users/all', { waitUntil: 'domcontentloaded', timeout: runtimeConfig.timeoutMs });
      usersFilterInput = await findUsersFilterInput(page, Math.min(runtimeConfig.timeoutMs, isTurbo ? 4_000 : 10_000));
    }, captureSuccessArtifacts);
    if (gotoUsersStep.artifactPath) {
      artifactPaths.push(gotoUsersStep.artifactPath);
    }
    steps.push(gotoUsersStep);
    if (gotoUsersStep.status === 'failed') {
      throw new Error(`Step failed: ${gotoUsersStep.name} (${gotoUsersStep.error ?? 'unknown error'})`);
    }

    const filterValue = request.payload.usuario.trim().toLowerCase();
    const fillFilterStep = await executeActionStep(page, artifactDir, '02-fill-user-filter', async () => {
      const filterInput = usersFilterInput ?? (await findUsersFilterInput(page, runtimeConfig.timeoutMs));
      usersFilterInput = filterInput;
      await filterInput.fill('', { timeout: runtimeConfig.timeoutMs });
      await filterInput.fill(filterValue, { timeout: runtimeConfig.timeoutMs });
    }, captureSuccessArtifacts);
    if (fillFilterStep.artifactPath) {
      artifactPaths.push(fillFilterStep.artifactPath);
    }
    steps.push(fillFilterStep);
    if (fillFilterStep.status === 'failed') {
      throw new Error(`Step failed: ${fillFilterStep.name} (${fillFilterStep.error ?? 'unknown error'})`);
    }

    const applyFilterStep = await executeActionStep(page, artifactDir, '03-apply-user-filter', async () => {
      const applyFilterButton = await findFirstVisibleLocator(
        page,
        USERS_APPLY_FILTER_SELECTOR,
        isTurbo ? Math.min(runtimeConfig.timeoutMs, 2_000) : runtimeConfig.timeoutMs
      ).catch(() => undefined);
      if (applyFilterButton) {
        await clickLocator(applyFilterButton, runtimeConfig.timeoutMs);
      } else {
        const filterInput = usersFilterInput ?? (await findUsersFilterInput(page, runtimeConfig.timeoutMs));
        await filterInput.press('Enter', { timeout: runtimeConfig.timeoutMs }).catch(() => undefined);
      }
      await waitForUsersFilterOutcome(page, operation, request.payload.usuario, filterOutcomeTimeoutMs, pollingMs);
    }, captureSuccessArtifacts);
    if (applyFilterStep.artifactPath) {
      artifactPaths.push(applyFilterStep.artifactPath);
    }
    steps.push(applyFilterStep);
    if (applyFilterStep.status === 'failed') {
      throw new Error(`Step failed: ${applyFilterStep.name} (${applyFilterStep.error ?? 'unknown error'})`);
    }

    const openDepositStep = await executeActionStep(page, artifactDir, stepNames.openAction, async () => {
      const depositButton = await findUniqueUserDepositButton(
        page,
        operation,
        request.payload.usuario,
        depositSearchTimeoutMs,
        pollingMs
      );
      await clickLocator(depositButton, runtimeConfig.timeoutMs);
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
      const userVisible = await waitForUserVisibleInDepositPage(
        page,
        request.payload.usuario,
        depositPageTimeoutMs,
        pollingMs
      );
      if (!userVisible) {
        throw new Error(`User "${request.payload.usuario}" is not visible in ${operation} target panel`);
      }
    }, captureSuccessArtifacts);
    if (waitDepositPageStep.artifactPath) {
      artifactPaths.push(waitDepositPageStep.artifactPath);
    }
    steps.push(waitDepositPageStep);
    if (waitDepositPageStep.status === 'failed') {
      throw new Error(`Step failed: ${waitDepositPageStep.name} (${waitDepositPageStep.error ?? 'unknown error'})`);
    }

    const amountStep = await executeActionStep(page, artifactDir, stepNames.amountAction, async () => {
      if (operation === 'descarga_total') {
        await clickTotalAmountAction(page, runtimeConfig.timeoutMs, pollingMs);
        return;
      }

      if (typeof request.payload.cantidad !== 'number') {
        throw new Error(`cantidad is required for "${operation}" operation`);
      }

      const amountInput = await findDepositAmountInput(page, runtimeConfig.timeoutMs);
      await amountInput.fill('', { timeout: runtimeConfig.timeoutMs });
      await amountInput.fill(String(request.payload.cantidad), { timeout: runtimeConfig.timeoutMs });
    }, captureSuccessArtifacts);
    if (amountStep.artifactPath) {
      artifactPaths.push(amountStep.artifactPath);
    }
    steps.push(amountStep);
    if (amountStep.status === 'failed') {
      throw new Error(`Step failed: ${amountStep.name} (${amountStep.error ?? 'unknown error'})`);
    }

    const submittedUrl = page.url();
    const clickDepositStep = await executeActionStep(page, artifactDir, stepNames.clickSubmit, async () => {
      const submitButton = await findSubmitDepositAction(page, operation, runtimeConfig.timeoutMs, pollingMs);
      await clickLocator(submitButton, runtimeConfig.timeoutMs);
    }, captureSuccessArtifacts);
    if (clickDepositStep.artifactPath) {
      artifactPaths.push(clickDepositStep.artifactPath);
    }
    steps.push(clickDepositStep);
    if (clickDepositStep.status === 'failed') {
      throw new Error(`Step failed: ${clickDepositStep.name} (${clickDepositStep.error ?? 'unknown error'})`);
    }

    const verifyStep = await verifyDepositResultStep(
      page,
      operation,
      artifactDir,
      stepNames.verifyResult,
      submittedUrl,
      verifyTimeoutMs,
      pollingMs,
      captureSuccessArtifacts
    );
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
    await context.close();
    await browser.close();

    return {
      artifactPaths,
      steps
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);

    const wrapped = new Error(message);
    (wrapped as Error & { steps?: JobStepResult[]; artifactPaths?: string[] }).steps = steps;
    (wrapped as Error & { steps?: JobStepResult[]; artifactPaths?: string[] }).artifactPaths = artifactPaths;
    throw wrapped;
  }
}
