import path from 'node:path';
import { promises as fs } from 'node:fs';
import { chromium, type Page } from 'playwright';
import type { Logger } from 'pino';
import { ensureAuthenticated } from './auth';
import { configureContext } from './browser';
import type {
  AppConfig,
  CreatePlayerJobRequest,
  JobExecutionResult,
  JobStepResult,
  StepAction
} from './types';

const CREATE_PLAYER_CONFIRM_SELECTOR =
  '[role="dialog"] button:has-text("Crear jugador"), [role="dialog"] button:has-text("Registrar"), .modal.show button:has-text("Crear jugador"), .modal.show button:has-text("Registrar"), .swal2-container button:has-text("Crear jugador"), .swal2-container button:has-text("Registrar"), .swal-modal button:has-text("Crear jugador"), .swal-modal button:has-text("Registrar"), .swal-overlay--show-modal button:has-text("Crear jugador"), .swal-overlay--show-modal button:has-text("Registrar")';

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

async function waitForCreatePlayerResult(
  page: Page,
  timeoutMs: number
): Promise<{ ok: boolean; reason: string }> {
  const startedAt = Date.now();
  const successMessage = page.locator('text=/cread[oa]|registrad[oa]|correctamente|success|exito/i').first();
  const errorMessage = page
    .locator('text=/ya existe|error|fall[oó]|fallid[oa]|invalido|invalid|no se pudo|incorrect[oa]/i')
    .first();

  while (Date.now() - startedAt < timeoutMs) {
    const currentUrl = page.url();
    if (!currentUrl.includes('/users/create-player')) {
      return { ok: true, reason: `URL changed after submit: ${currentUrl}` };
    }

    if (await errorMessage.isVisible().catch(() => false)) {
      const text = (await errorMessage.innerText().catch(() => '')).trim();
      return { ok: false, reason: text || 'Error message detected after submit' };
    }

    if (await successMessage.isVisible().catch(() => false)) {
      const text = (await successMessage.innerText().catch(() => '')).trim();
      return { ok: true, reason: text || 'Success message detected after submit' };
    }

    await page.waitForTimeout(250);
  }

  return { ok: false, reason: 'No clear success signal detected after submit' };
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

    if (!outcome.ok) {
      return {
        name: stepName,
        status: 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        artifactPath,
        error: outcome.reason
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
      await page.locator(step.selector).first().waitFor({ state: 'visible', timeout: timeoutMs });
    } else if (step.type === 'fill') {
      if (!step.selector) {
        throw new Error('fill step requires selector');
      }
      if (typeof step.value !== 'string') {
        throw new Error('fill step requires value');
      }
      const value = applyVariables(step.value, request);
      const locator = page.locator(step.selector).first();
      await locator.waitFor({ state: 'visible', timeout: timeoutMs });
      await locator.fill(value, { timeout: timeoutMs });
    } else if (step.type === 'click') {
      if (!step.selector) {
        throw new Error('click step requires selector');
      }
      const locator = page.locator(step.selector).first();
      await locator.waitFor({ state: 'visible', timeout: timeoutMs });
      await locator.click({ timeout: timeoutMs });
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

export async function runCreatePlayerJob(
  request: CreatePlayerJobRequest,
  appConfig: AppConfig,
  logger: Logger
): Promise<JobExecutionResult> {
  const jobLogger = logger.child({ jobId: request.id, jobType: request.jobType });
  const artifactDir = path.join(appConfig.artifactsDir, 'jobs', request.id);
  const runtimeConfig: AppConfig = {
    ...appConfig,
    headless: request.options.headless,
    debug: request.options.debug,
    slowMo: request.options.slowMo,
    timeoutMs: request.options.timeoutMs
  };

  await fs.mkdir(artifactDir, { recursive: true });

  const browser = await chromium.launch({
    headless: runtimeConfig.headless,
    slowMo: runtimeConfig.slowMo,
    args: runtimeConfig.headless ? undefined : ['--start-maximized']
  });

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
  const artifactPaths: string[] = [];
  const steps: JobStepResult[] = [];
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
    artifactPaths.push(loginArtifact);
    steps.push({
      name: '00-login',
      status: 'ok',
      startedAt: loginStartedAt,
      finishedAt: new Date().toISOString(),
      artifactPath: loginArtifact
    });

    const stepsToRun = request.payload.stepsOverride?.length ? request.payload.stepsOverride : DEFAULT_CREATE_PLAYER_STEPS;
    for (let i = 0; i < stepsToRun.length; i += 1) {
      const result = await executeStep(page, stepsToRun[i] as StepAction, i, artifactDir, request, runtimeConfig.timeoutMs);
      if (result.artifactPath) {
        artifactPaths.push(result.artifactPath);
      }
      steps.push(result);

      if (result.status === 'failed') {
        throw new Error(`Step failed: ${result.name} (${result.error ?? 'unknown error'})`);
      }
    }

    const verifyResult = await verifyCreatePlayerStep(page, artifactDir, runtimeConfig.timeoutMs);
    if (verifyResult.artifactPath) {
      artifactPaths.push(verifyResult.artifactPath);
    }
    steps.push(verifyResult);
    if (verifyResult.status === 'failed') {
      throw new Error(`Step failed: ${verifyResult.name} (${verifyResult.error ?? 'unknown error'})`);
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

    if (tracingStarted) {
      await context.tracing.stop({ path: tracePath });
      artifactPaths.push(tracePath);
      tracingStarted = false;
    }

    await waitBeforeCloseIfHeaded(page, runtimeConfig.headless);
    await context.close();
    await browser.close();

    return {
      artifactPaths,
      steps
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    jobLogger.error({ error }, 'Create-player job failed');

    try {
      await page.screenshot({ path: screenshotFailurePath, fullPage: true });
      artifactPaths.push(screenshotFailurePath);
    } catch {
      jobLogger.warn('Could not capture create-player failure screenshot');
    }

    if (tracingStarted) {
      try {
        await context.tracing.stop({ path: traceFailurePath });
        artifactPaths.push(traceFailurePath);
      } catch {
        jobLogger.warn('Could not persist create-player failure trace');
      }
    }

    await waitBeforeCloseIfHeaded(page, runtimeConfig.headless).catch(() => undefined);
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);

    const wrapped = new Error(message);
    (wrapped as Error & { steps?: JobStepResult[]; artifactPaths?: string[] }).steps = steps;
    (wrapped as Error & { steps?: JobStepResult[]; artifactPaths?: string[] }).artifactPaths = artifactPaths;
    throw wrapped;
  }
}
