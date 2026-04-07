import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { Locator, Page, Response } from 'playwright';
import type { Logger } from 'pino';
import { ensureAuthenticated } from './auth';
import { configureContext, launchChromiumBrowser } from './browser';
import { runCreatePlayerAsnJob } from './create-player-asn';
import {
  buildRemoteApiErrorMessage,
  buildExhaustedUsernameError,
  buildUsernameCandidates,
  extractRemoteApiErrorMessage,
  isGenericRequestFailure,
  isDuplicateUsernameError,
  isPasswordVerificationWarning
} from './create-player-username';
import { hasCompactUsernameMatch } from './deposit-match';
import { resolveSiteAppConfig } from './site-profile';
import type {
  AppConfig,
  CreatePlayerJobRequest,
  JobExecutionResult,
  JobStepResult,
  StepAction
} from './types';

const CREATE_PLAYER_CONFIRM_SELECTOR =
  'div:has-text("crear un jugador con nombre de usuario") button:has-text("Crear jugador"), div:has-text("crear un jugador con nombre de usuario") button:has-text("Registrar"), div:has-text("deseas crear un jugador") button:has-text("Crear jugador"), div:has-text("deseas crear un jugador") button:has-text("Registrar")';
const USERS_FILTER_INPUT_SELECTOR = 'input[placeholder*="Jugador/Agente" i]';
const USERS_APPLY_FILTER_SELECTOR =
  'button:has-text("Aceptar filtro"), button:has-text("Aplicar"), button:has-text("Filtrar"), button:has-text("Buscar")';

const DEFAULT_CREATE_PLAYER_STEPS: StepAction[] = [
  {
    type: 'goto',
    url: '/users/create-player',
    screenshotName: '01-goto-create-player'
  },
  {
    type: 'waitFor',
    selector:
      'input[name="username"], input[name="login"], input[autocomplete="username"], input[placeholder*="usuario" i], input[placeholder*="user" i]',
    screenshotName: '02-wait-username'
  },
  {
    type: 'fill',
    selector:
      'input[name="username"], input[name="login"], input[autocomplete="username"], input[placeholder*="usuario" i], input[placeholder*="user" i]',
    value: '{{newUsername}}',
    screenshotName: '03-fill-username'
  },
  {
    type: 'fill',
    selector: 'input[name="password"], input[type="password"]',
    value: '{{newPassword}}',
    screenshotName: '04-fill-password'
  },
  {
    type: 'fill',
    selector:
      'input[name="password_confirmation"], input[name="passwordConfirm"], input[name="confirmPassword"], input[name*="confirm" i], input[id*="confirm" i], input[placeholder*="confirm" i], input[name*="repet" i], input[placeholder*="repet" i]',
    value: '{{newPassword}}',
    screenshotName: '05-fill-password-confirm'
  },
  {
    type: 'click',
    selector:
      'button[type="submit"], button:has-text("Registrar"), button:has-text("Register"), button:has-text("Create"), button:has-text("Crear"), button:has-text("Nuevo jugador"), button:has-text("Save"), button:has-text("Guardar"), input[type="submit"][value*="Registrar" i], input[type="submit"][value*="Register" i]',
    screenshotName: '06-click-submit'
  },
  {
    type: 'waitFor',
    selector: CREATE_PLAYER_CONFIRM_SELECTOR,
    screenshotName: '07-wait-confirm-submit'
  },
  {
    type: 'click',
    selector: CREATE_PLAYER_CONFIRM_SELECTOR,
    screenshotName: '08-click-confirm-submit'
  }
];

function sanitizeFileName(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
}

function applyVariables(value: string, request: CreatePlayerJobRequest): string {
  return value
    .replaceAll('{{newUsername}}', request.payload.newUsername)
    .replaceAll('{{newPassword}}', request.payload.newPassword)
    .replaceAll('{{loginUsername}}', request.payload.loginUsername)
    .replaceAll('{{loginPassword}}', request.payload.loginPassword);
}

function buildRequestForCandidateUsername(
  request: CreatePlayerJobRequest,
  candidateUsername: string
): CreatePlayerJobRequest {
  return {
    ...request,
    payload: {
      ...request.payload,
      newUsername: candidateUsername
    }
  };
}

function withAttemptPrefix(steps: JobStepResult[], attempt: number): JobStepResult[] {
  return steps.map((step) => ({
    ...step,
    name: `A${attempt}-${step.name}`
  }));
}

function normalizeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extractAttemptContext(error: unknown): { steps: JobStepResult[]; artifactPaths: string[] } {
  if (!error || typeof error !== 'object') {
    return { steps: [], artifactPaths: [] };
  }

  const errorWithContext = error as { steps?: JobStepResult[]; artifactPaths?: string[] };
  return {
    steps: Array.isArray(errorWithContext.steps) ? errorWithContext.steps : [],
    artifactPaths: Array.isArray(errorWithContext.artifactPaths) ? errorWithContext.artifactPaths : []
  };
}

function throwWithCreatePlayerContext(
  baseError: Error,
  steps: JobStepResult[],
  artifactPaths: string[]
): never {
  const wrapped = new Error(baseError.message);
  (wrapped as Error & { steps?: JobStepResult[]; artifactPaths?: string[] }).steps = steps;
  (wrapped as Error & { steps?: JobStepResult[]; artifactPaths?: string[] }).artifactPaths = artifactPaths;
  throw wrapped;
}

async function captureStepScreenshot(page: Page, artifactDir: string, name: string): Promise<string> {
  const safe = sanitizeFileName(name || 'step');
  const filePath = path.join(artifactDir, `${safe}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
}

async function waitBeforeCloseIfHeaded(page: Page, headless: boolean): Promise<void> {
  if (headless) {
    return;
  }

  await page.waitForTimeout(15_000);
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function waitForCreatePlayerResult(
  page: Page,
  timeoutMs: number
): Promise<{ state: 'success' | 'error' | 'unknown'; reason: string }> {
  const startedAt = Date.now();
  const successMessage = page.locator('text=/cread[oa]|registrad[oa]|correctamente|success|exito/i').first();
  const errorMessage = page
    .locator('text=/ya existe|error|fall[oó]|fallid[oa]|invalido|invalid|no se pudo|incorrect[oa]/i')
    .first();

  while (Date.now() - startedAt < timeoutMs) {
    const currentUrl = page.url();
    if (!currentUrl.includes('/users/create-player')) {
      return { state: 'success', reason: `URL changed after submit: ${currentUrl}` };
    }

    if (await errorMessage.isVisible().catch(() => false)) {
      const text = (await errorMessage.innerText().catch(() => '')).trim();
      return { state: 'error', reason: text || 'Error message detected after submit' };
    }

    if (await successMessage.isVisible().catch(() => false)) {
      const text = (await successMessage.innerText().catch(() => '')).trim();
      return { state: 'success', reason: text || 'Success message detected after submit' };
    }

    await page.waitForTimeout(250);
  }

  return { state: 'unknown', reason: 'No clear success signal detected after submit' };
}

async function verifyCreatePlayerStep(
  page: Page,
  artifactDir: string,
  timeoutMs: number
): Promise<JobStepResult> {
  const startedAt = new Date().toISOString();
  const stepName = '09-verify-create-player-result';

  try {
    const outcome = await waitForCreatePlayerResult(page, timeoutMs);
    const artifactPath = await captureStepScreenshot(page, artifactDir, stepName);

    if (outcome.state === 'error') {
      return {
        name: stepName,
        status: 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        artifactPath,
        error: outcome.reason
      };
    }

    if (outcome.state === 'unknown') {
      return {
        name: stepName,
        status: 'skipped',
        startedAt,
        finishedAt: new Date().toISOString(),
        artifactPath
      };
    }

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

async function waitForUsernameVisibleInList(page: Page, username: string, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  const usernamePattern = new RegExp(escapeRegex(username), 'i');
  const fallbackPrefix = username.slice(0, Math.min(12, username.length));
  const prefixPattern = new RegExp(escapeRegex(fallbackPrefix), 'i');

  while (Date.now() - startedAt < timeoutMs) {
    const exactVisible = await page
      .getByText(usernamePattern)
      .first()
      .isVisible()
      .catch(() => false);
    if (exactVisible) {
      return true;
    }

    if (fallbackPrefix.length >= 8) {
      const partialVisible = await page
        .locator('[class*="user" i], [class*="usuario" i], div, span, td')
        .filter({ hasText: prefixPattern })
        .first()
        .isVisible()
        .catch(() => false);
      if (partialVisible) {
        return true;
      }
    }

    const rowTexts = await page
      .locator('.users-table-item')
      .evaluateAll((nodes) => nodes.map((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim()))
      .catch(() => []);
    if (rowTexts.some((value) => hasCompactUsernameMatch(value, username))) {
      return true;
    }

    await page.waitForTimeout(250);
  }

  return false;
}

async function verifyUserListedStep(
  page: Page,
  artifactDir: string,
  username: string,
  timeoutMs: number
): Promise<JobStepResult> {
  const startedAt = new Date().toISOString();
  const stepName = '10-verify-user-listed';

  try {
    await page.goto('/users/all', { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    const filterInput = await findUsersFilterInput(page, timeoutMs);
    await filterInput.fill('', { timeout: timeoutMs });
    await filterInput.fill(username, { timeout: timeoutMs });

    const applyFilterButton = await findFirstVisibleLocator(page, USERS_APPLY_FILTER_SELECTOR, timeoutMs);
    await applyFilterButton.scrollIntoViewIfNeeded({ timeout: timeoutMs }).catch(() => undefined);
    await applyFilterButton.click({ timeout: timeoutMs }).catch(async () => {
      await applyFilterButton.click({ timeout: timeoutMs, force: true });
    });

    await page.waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 10_000) }).catch(() => undefined);
    const userVisible = await waitForUsernameVisibleInList(page, username, timeoutMs);
    const artifactPath = await captureStepScreenshot(page, artifactDir, stepName);

    if (!userVisible) {
      return {
        name: stepName,
        status: 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        artifactPath,
        error: `User "${username}" not found in users list after creation`
      };
    }

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

async function executeStep(
  page: Page,
  step: StepAction,
  index: number,
  artifactDir: string,
  request: CreatePlayerJobRequest,
  defaultTimeoutMs: number
): Promise<JobStepResult> {
  const startedAt = new Date().toISOString();
  const stepName = step.screenshotName || `${String(index + 1).padStart(2, '0')}-${step.type}`;
  const timeoutMs = step.timeoutMs ?? defaultTimeoutMs;

  try {
    if (step.type === 'goto') {
      if (!step.url) {
        throw new Error('goto step requires url');
      }
      const url = applyVariables(step.url, request);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    } else if (step.type === 'waitFor') {
      if (!step.selector) {
        throw new Error('waitFor step requires selector');
      }
      await findFirstVisibleLocator(page, step.selector, timeoutMs);
    } else if (step.type === 'fill') {
      if (!step.selector) {
        throw new Error('fill step requires selector');
      }
      if (typeof step.value !== 'string') {
        throw new Error('fill step requires value');
      }
      const value = applyVariables(step.value, request);
      const locator = await findFirstVisibleLocator(page, step.selector, timeoutMs);
      await locator.fill(value, { timeout: timeoutMs });
    } else if (step.type === 'click') {
      if (!step.selector) {
        throw new Error('click step requires selector');
      }
      const locator = await findFirstVisibleLocator(page, step.selector, timeoutMs);
      await locator.scrollIntoViewIfNeeded({ timeout: timeoutMs }).catch(() => undefined);
      try {
        await locator.click({ timeout: timeoutMs });
      } catch {
        await locator.click({ timeout: timeoutMs, force: true });
      }
    } else {
      const exhaustive: never = step.type;
      throw new Error(`Unsupported step type: ${exhaustive}`);
    }

    const artifactPath = await captureStepScreenshot(page, artifactDir, stepName);
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

type RdaAttemptOutcome =
  | { status: 'success'; steps: JobStepResult[]; artifactPaths: string[] }
  | { status: 'duplicate'; steps: JobStepResult[]; artifactPaths: string[]; error: string };

interface RdaCreatePlayerApiFailure {
  httpStatus: number;
  apiStatus?: number;
  errorMessage?: string | null;
}

function isRdaCreatePlayerApiResponse(response: Response): boolean {
  if (response.request().method() !== 'POST') {
    return false;
  }

  try {
    const parsed = new URL(response.url());
    return parsed.pathname === '/api/agent_admin/user/';
  } catch {
    return false;
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  const rawBody = await response.text();
  if (!rawBody) {
    return null;
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
}

function extractApiStatus(body: unknown): number | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }

  const value = (body as { status?: unknown }).status;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function createRdaCreatePlayerApiCapture() {
  let latestFailure: RdaCreatePlayerApiFailure | null = null;
  const pending = new Set<Promise<void>>();

  const listener = (response: Response) => {
    if (!isRdaCreatePlayerApiResponse(response)) {
      return;
    }

    const task = (async () => {
      const body = await readResponseBody(response);
      latestFailure = {
        httpStatus: response.status(),
        apiStatus: extractApiStatus(body),
        errorMessage:
          extractRemoteApiErrorMessage(body) ??
          (typeof body === 'string' && body.trim().length > 0 ? body.trim() : null)
      };
    })();

    pending.add(task);
    void task.finally(() => {
      pending.delete(task);
    });
  };

  return {
    listener,
    async flush(): Promise<RdaCreatePlayerApiFailure | null> {
      if (pending.size > 0) {
        await Promise.allSettled([...pending]);
      }

      return latestFailure;
    }
  };
}

function resolveRdaCreatePlayerFailureMessage(
  currentMessage: string,
  apiFailure: RdaCreatePlayerApiFailure | null
): string {
  const remoteMessage = apiFailure ? buildRemoteApiErrorMessage(apiFailure) : null;
  return remoteMessage ?? currentMessage;
}

function canFallbackToUserLookup(message: string): boolean {
  return isPasswordVerificationWarning(message);
}

async function executeRdaCreateAttempt(
  page: Page,
  request: CreatePlayerJobRequest,
  artifactDir: string,
  timeoutMs: number
): Promise<RdaAttemptOutcome> {
  const steps: JobStepResult[] = [];
  const artifactPaths: string[] = [];
  const apiCapture = createRdaCreatePlayerApiCapture();

  page.on('response', apiCapture.listener);

  try {
    const stepsToRun = request.payload.stepsOverride?.length ? request.payload.stepsOverride : DEFAULT_CREATE_PLAYER_STEPS;
    for (let i = 0; i < stepsToRun.length; i += 1) {
      const result = await executeStep(page, stepsToRun[i] as StepAction, i, artifactDir, request, timeoutMs);
      if (result.artifactPath) {
        artifactPaths.push(result.artifactPath);
      }
      steps.push(result);

      if (result.status === 'failed') {
        throw new Error(`Step failed: ${result.name} (${result.error ?? 'unknown error'})`);
      }
    }

    const verifyResult = await verifyCreatePlayerStep(page, artifactDir, timeoutMs);
    if (verifyResult.artifactPath) {
      artifactPaths.push(verifyResult.artifactPath);
    }
    const apiFailure = await apiCapture.flush();
    const resolvedVerifyError = verifyResult.error
      ? resolveRdaCreatePlayerFailureMessage(verifyResult.error, apiFailure)
      : null;
    if (resolvedVerifyError) {
      verifyResult.error = resolvedVerifyError;
    }
    if (verifyResult.status === 'skipped' && apiFailure) {
      verifyResult.status = 'failed';
      verifyResult.error = resolveRdaCreatePlayerFailureMessage(
        verifyResult.error ?? 'No clear success signal detected after submit',
        apiFailure
      );
    }
    steps.push(verifyResult);
    const verifyResultError = verifyResult.error ?? '';
    const allowUserLookupFallback =
      verifyResult.status === 'failed' && canFallbackToUserLookup(verifyResultError);

    if (verifyResult.status === 'failed' && !allowUserLookupFallback) {
      if (isDuplicateUsernameError(verifyResult.error ?? '')) {
        return {
          status: 'duplicate',
          steps,
          artifactPaths,
          error: verifyResult.error ?? 'Duplicate username detected'
        };
      }
      throw new Error(`Step failed: ${verifyResult.name} (${verifyResult.error ?? 'unknown error'})`);
    }

    const verifyListedResult = await verifyUserListedStep(page, artifactDir, request.payload.newUsername, timeoutMs);
    if (verifyListedResult.artifactPath) {
      artifactPaths.push(verifyListedResult.artifactPath);
    }
    if (allowUserLookupFallback && verifyListedResult.status === 'ok') {
      verifyResult.status = 'skipped';
      verifyResult.error = `${verifyResultError} (ignored because user was found in users list)`;
    }
    if (allowUserLookupFallback && verifyListedResult.status === 'failed') {
      verifyListedResult.error = `${verifyResultError}; ${verifyListedResult.error ?? 'User not found after create-player fallback verification'}`;
    }
    steps.push(verifyListedResult);
    if (verifyListedResult.status === 'failed') {
      throw new Error(`Step failed: ${verifyListedResult.name} (${verifyListedResult.error ?? 'unknown error'})`);
    }

    const finalArtifact = await captureStepScreenshot(page, artifactDir, '99-final');
    artifactPaths.push(finalArtifact);
    steps.push({
      name: '99-final',
      status: 'ok',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      artifactPath: finalArtifact
    });

    return { status: 'success', steps, artifactPaths };
  } catch (error) {
    const apiFailure = await apiCapture.flush();
    const resolvedMessage = resolveRdaCreatePlayerFailureMessage(normalizeErrorMessage(error), apiFailure);
    throwWithCreatePlayerContext(new Error(resolvedMessage), steps, artifactPaths);
  } finally {
    page.off('response', apiCapture.listener);
  }
}

export async function runCreatePlayerJob(
  request: CreatePlayerJobRequest,
  appConfig: AppConfig,
  logger: Logger
): Promise<JobExecutionResult> {
  if (request.payload.pagina === 'ASN') {
    return runCreatePlayerAsnJob(request, appConfig, logger);
  }

  const requestedUsername = request.payload.newUsername;
  const candidates = buildUsernameCandidates(requestedUsername, request.payload.pagina);
  const allSteps: JobStepResult[] = [];
  const allArtifactPaths: string[] = [];
  const jobLogger = logger.child({ jobId: request.id, jobType: request.jobType, pagina: request.payload.pagina });
  const artifactDir = path.join(appConfig.artifactsDir, 'jobs', request.id);
  const siteConfig = resolveSiteAppConfig(appConfig, request.payload.pagina);
  const runtimeConfig: AppConfig = {
    ...siteConfig,
    headless: request.options.headless,
    debug: request.options.debug,
    slowMo: request.options.slowMo,
    timeoutMs: request.options.timeoutMs
  };

  await fs.mkdir(artifactDir, { recursive: true });

  const browser = await launchChromiumBrowser(runtimeConfig, jobLogger);

  const context = await browser.newContext({
    baseURL: runtimeConfig.baseUrl,
    viewport: runtimeConfig.headless ? undefined : null,
    recordVideo: runtimeConfig.debug
      ? {
          dir: path.join(artifactDir, 'video')
        }
      : undefined
  });

  await configureContext(context, runtimeConfig, jobLogger);
  const page = await context.newPage();
  const tracePath = path.join(artifactDir, 'trace.zip');
  const traceFailurePath = path.join(artifactDir, 'trace-failure.zip');
  const screenshotFailurePath = path.join(artifactDir, 'error.png');
  let tracingStarted = false;

  try {
    if (runtimeConfig.debug) {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      tracingStarted = true;
    }

    const loginStartedAt = new Date().toISOString();
    await ensureAuthenticated(
      context,
      page,
      runtimeConfig,
      {
        username: request.payload.loginUsername,
        password: request.payload.loginPassword
      },
      jobLogger,
      { persistSession: false }
    );
    const loginArtifact = await captureStepScreenshot(page, artifactDir, '00-login');
    allArtifactPaths.push(loginArtifact);
    allSteps.push({
      name: '00-login',
      status: 'ok',
      startedAt: loginStartedAt,
      finishedAt: new Date().toISOString(),
      artifactPath: loginArtifact
    });

    for (let i = 0; i < candidates.length; i += 1) {
      const attemptNumber = i + 1;
      const candidateUsername = candidates[i] as string;
      const attemptRequest = buildRequestForCandidateUsername(request, candidateUsername);

      try {
        const outcome = await executeRdaCreateAttempt(page, attemptRequest, artifactDir, runtimeConfig.timeoutMs);
        allSteps.push(...withAttemptPrefix(outcome.steps, attemptNumber));
        allArtifactPaths.push(...outcome.artifactPaths);

        if (outcome.status === 'success') {
          if (tracingStarted) {
            await context.tracing.stop({ path: tracePath });
            allArtifactPaths.push(tracePath);
            tracingStarted = false;
          }

          await waitBeforeCloseIfHeaded(page, runtimeConfig.headless);
          await context.close();
          await browser.close();

          return {
            artifactPaths: allArtifactPaths,
            steps: allSteps,
            result: {
              kind: 'create-player',
              pagina: request.payload.pagina,
              requestedUsername,
              createdUsername: candidateUsername,
              createdPassword: request.payload.newPassword,
              attempts: attemptNumber
            }
          };
        }

        if (outcome.status === 'duplicate') {
          continue;
        }
      } catch (error) {
        const message = normalizeErrorMessage(error);
        const contextData = extractAttemptContext(error);
        allSteps.push(...withAttemptPrefix(contextData.steps, attemptNumber));
        allArtifactPaths.push(...contextData.artifactPaths);

        if (isDuplicateUsernameError(message) && !isGenericRequestFailure(message)) {
          continue;
        }

        throwWithCreatePlayerContext(new Error(message), allSteps, allArtifactPaths);
      }
    }

    throw buildExhaustedUsernameError(requestedUsername, candidates);
  } catch (error) {
    const message = normalizeErrorMessage(error);
    jobLogger.error({ error }, 'Create-player job failed');

    try {
      await page.screenshot({ path: screenshotFailurePath, fullPage: true });
      allArtifactPaths.push(screenshotFailurePath);
    } catch {
      jobLogger.warn('Could not capture create-player failure screenshot');
    }

    if (tracingStarted) {
      try {
        await context.tracing.stop({ path: traceFailurePath });
        allArtifactPaths.push(traceFailurePath);
      } catch {
        jobLogger.warn('Could not persist create-player failure trace');
      }
    }

    await waitBeforeCloseIfHeaded(page, runtimeConfig.headless).catch(() => undefined);
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);

    throwWithCreatePlayerContext(new Error(message), allSteps, allArtifactPaths);
  }
}
