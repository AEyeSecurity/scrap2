import path from 'node:path';
import { promises as fs } from 'node:fs';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import type { Logger } from 'pino';
import { ensureAuthenticated } from './auth';
import { configureContext } from './browser';
import { selectDepositRowIndex, type DepositRowCandidate } from './deposit-match';
import type { AppConfig, BalanceJobRequest, BalanceJobResult, JobExecutionResult, JobStepResult } from './types';

const USERS_FILTER_INPUT_SELECTOR = 'input[placeholder*="Jugador/Agente" i]';
const USERS_APPLY_FILTER_SELECTOR =
  'button:has-text("Aceptar filtro"), button:has-text("Aplicar"), button:has-text("Filtrar"), button:has-text("Buscar")';
const USERS_ROW_SELECTOR = '.users-table-item';
const USERS_USERNAME_SELECTOR = '.role-bar__user-block11, .ellipsis-text, .role-bar__user-block1, .users-table-item__user-info';
const NON_RETRYABLE_LOGIN_ERROR_REGEX =
  /usuario no autorizado|contrase(?:n|\u00f1)a\s+no\s+corregida|credenciales incorrectas|password/i;
const BALANCE_TOKEN_REGEX = /-?\d{1,3}(?:\.\d{3})*(?:,\d{2})|-?\d+(?:,\d{2})|-?\d{1,3}(?:\.\d{3})+/g;

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

export function parseBalanceNumber(rawValue: string): number {
  const compact = rawValue.trim().replace(/\s+/g, '').replace(/[^0-9,.-]/g, '');
  if (!/[0-9]/.test(compact)) {
    throw new Error(`Could not parse balance value "${rawValue}"`);
  }

  const sign = compact.startsWith('-') ? '-' : '';
  const unsigned = compact.replace(/-/g, '');
  let normalized: string;

  if (unsigned.includes(',') && unsigned.includes('.')) {
    if (unsigned.lastIndexOf(',') > unsigned.lastIndexOf('.')) {
      normalized = unsigned.replace(/\./g, '').replace(/,/g, '.');
    } else {
      normalized = unsigned.replace(/,/g, '');
    }
  } else if (unsigned.includes(',')) {
    const parts = unsigned.split(',');
    const decimalPart = parts.pop() ?? '';
    const integerPart = parts.join('') || '0';
    normalized = `${integerPart}.${decimalPart}`;
  } else if (unsigned.includes('.')) {
    const parts = unsigned.split('.');
    const decimalCandidate = parts[parts.length - 1] ?? '';
    if (parts.length === 2 && decimalCandidate.length <= 2) {
      normalized = unsigned;
    } else if (decimalCandidate.length <= 2 && parts.length > 2) {
      normalized = `${parts.slice(0, -1).join('')}.${decimalCandidate}`;
    } else {
      normalized = parts.join('');
    }
  } else {
    normalized = unsigned;
  }

  const parsed = Number(`${sign}${normalized}`);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Could not parse balance value "${rawValue}"`);
  }

  return parsed;
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
        throw error instanceof Error ? error : new Error(message);
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

async function collectBalanceRowCandidates(page: Page): Promise<DepositRowCandidate[]> {
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

    candidates.push({
      index: i,
      hasAction: true,
      usernames,
      normalizedText: rowTextRaw
    });
  }

  return candidates;
}

async function findUniqueUserRow(page: Page, username: string, timeoutMs: number, pollingMs: number): Promise<Locator> {
  const startedAt = Date.now();
  let lastError = `Could not find a unique row for user "${username}"`;
  const rows = page.locator(USERS_ROW_SELECTOR);

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const candidates = await collectBalanceRowCandidates(page);
      const selectedIndex = selectDepositRowIndex(candidates, username);
      return rows.nth(selectedIndex);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await page.waitForTimeout(pollingMs);
  }

  throw new Error(lastError);
}

function extractBalanceTextFromRowText(rowText: string): string {
  const matches = rowText.match(BALANCE_TOKEN_REGEX) ?? [];
  if (matches.length === 0) {
    throw new Error('Could not extract balance token from user row');
  }

  return matches[0]?.trim() ?? '';
}

export async function runBalanceJob(request: BalanceJobRequest, appConfig: AppConfig, logger: Logger): Promise<JobExecutionResult> {
  const jobLogger = logger.child({ jobId: request.id, jobType: request.jobType, operation: request.payload.operacion });
  const artifactDir = path.join(appConfig.artifactsDir, 'jobs', request.id);
  const runtimeConfig: AppConfig = {
    ...appConfig,
    headless: request.options.headless,
    debug: request.options.debug,
    slowMo: request.options.slowMo,
    timeoutMs: request.options.timeoutMs
  };
  const isTurbo = !runtimeConfig.debug && runtimeConfig.slowMo === 0;
  const captureSuccessArtifacts = parseEnvBoolean(process.env.BALANCE_CAPTURE_SUCCESS_ARTIFACTS) ?? false;
  const pollingMs = isTurbo ? 100 : 250;
  const userSearchTimeoutMs = isTurbo ? Math.min(runtimeConfig.timeoutMs, 5_000) : runtimeConfig.timeoutMs;

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
  let targetRow: Locator | undefined;

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

    const gotoUsersStep = await executeActionStep(
      page,
      artifactDir,
      '01-goto-users-all',
      async () => {
        await page.goto('/users/all', { waitUntil: 'domcontentloaded', timeout: runtimeConfig.timeoutMs });
        usersFilterInput = await findUsersFilterInput(page, Math.min(runtimeConfig.timeoutMs, isTurbo ? 4_000 : 10_000));
      },
      captureSuccessArtifacts
    );
    if (gotoUsersStep.artifactPath) {
      artifactPaths.push(gotoUsersStep.artifactPath);
    }
    steps.push(gotoUsersStep);
    if (gotoUsersStep.status === 'failed') {
      throw new Error(`Step failed: ${gotoUsersStep.name} (${gotoUsersStep.error ?? 'unknown error'})`);
    }

    const filterValue = request.payload.usuario.trim().toLowerCase();
    const fillFilterStep = await executeActionStep(
      page,
      artifactDir,
      '02-fill-user-filter',
      async () => {
        const filterInput = usersFilterInput ?? (await findUsersFilterInput(page, runtimeConfig.timeoutMs));
        usersFilterInput = filterInput;
        await filterInput.fill('', { timeout: runtimeConfig.timeoutMs });
        await filterInput.fill(filterValue, { timeout: runtimeConfig.timeoutMs });
      },
      captureSuccessArtifacts
    );
    if (fillFilterStep.artifactPath) {
      artifactPaths.push(fillFilterStep.artifactPath);
    }
    steps.push(fillFilterStep);
    if (fillFilterStep.status === 'failed') {
      throw new Error(`Step failed: ${fillFilterStep.name} (${fillFilterStep.error ?? 'unknown error'})`);
    }

    const applyFilterStep = await executeActionStep(
      page,
      artifactDir,
      '03-apply-user-filter',
      async () => {
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
      },
      captureSuccessArtifacts
    );
    if (applyFilterStep.artifactPath) {
      artifactPaths.push(applyFilterStep.artifactPath);
    }
    steps.push(applyFilterStep);
    if (applyFilterStep.status === 'failed') {
      throw new Error(`Step failed: ${applyFilterStep.name} (${applyFilterStep.error ?? 'unknown error'})`);
    }

    const findRowStep = await executeActionStep(
      page,
      artifactDir,
      '04-find-user-row',
      async () => {
        targetRow = await findUniqueUserRow(page, request.payload.usuario, userSearchTimeoutMs, pollingMs);
      },
      captureSuccessArtifacts
    );
    if (findRowStep.artifactPath) {
      artifactPaths.push(findRowStep.artifactPath);
    }
    steps.push(findRowStep);
    if (findRowStep.status === 'failed') {
      throw new Error(`Step failed: ${findRowStep.name} (${findRowStep.error ?? 'unknown error'})`);
    }

    let balanceResult: BalanceJobResult | undefined;
    const readBalanceStep = await executeActionStep(
      page,
      artifactDir,
      '05-read-balance',
      async () => {
        if (!targetRow) {
          throw new Error('Target user row was not resolved');
        }
        const rowText = await targetRow.innerText({ timeout: runtimeConfig.timeoutMs });
        const saldoTexto = extractBalanceTextFromRowText(rowText);
        const saldoNumero = parseBalanceNumber(saldoTexto);
        balanceResult = {
          kind: 'balance',
          usuario: request.payload.usuario,
          saldoTexto,
          saldoNumero
        };
      },
      captureSuccessArtifacts
    );
    if (readBalanceStep.artifactPath) {
      artifactPaths.push(readBalanceStep.artifactPath);
    }
    steps.push(readBalanceStep);
    if (readBalanceStep.status === 'failed') {
      throw new Error(`Step failed: ${readBalanceStep.name} (${readBalanceStep.error ?? 'unknown error'})`);
    }

    steps.push({
      name: '99-final',
      status: 'ok',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString()
    });

    if (tracingStarted) {
      await context.tracing.stop({ path: tracePath });
      artifactPaths.push(tracePath);
      tracingStarted = false;
    }

    await waitBeforeCloseIfHeaded(page, runtimeConfig.headless, runtimeConfig.debug);
    await context.close();
    await browser.close();

    if (!balanceResult) {
      throw new Error('Balance result was not captured');
    }

    return {
      artifactPaths,
      steps,
      result: balanceResult
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    jobLogger.error({ error }, 'Balance job failed');

    try {
      await page.screenshot({ path: screenshotFailurePath, fullPage: true });
      artifactPaths.push(screenshotFailurePath);
    } catch {
      jobLogger.warn('Could not capture balance failure screenshot');
    }

    if (tracingStarted) {
      try {
        await context.tracing.stop({ path: traceFailurePath });
        artifactPaths.push(traceFailurePath);
      } catch {
        jobLogger.warn('Could not persist balance failure trace');
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
