import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { BrowserContext, Page } from 'playwright';
import type { Logger } from 'pino';
import { runAsnBalanceJob } from './asn-funds-job';
import { ensureAuthenticated } from './auth';
import { acquireFundsSessionLease } from './funds-session-pool';
import { formatRdaMoney, resolveRdaUserByApi, roundRdaMoney } from './rda-user-api';
import { translateRdaJobError } from './rda-user-error';
import type { AppConfig, BalanceJobRequest, BalanceJobResult, JobExecutionResult, JobStepResult } from './types';

const NON_RETRYABLE_LOGIN_ERROR_REGEX =
  /usuario no autorizado|contrase(?:n|\u00f1)a\s+no\s+corregida|credenciales incorrectas|password/i;

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

export async function runBalanceJob(request: BalanceJobRequest, appConfig: AppConfig, logger: Logger): Promise<JobExecutionResult> {
  if (request.payload.pagina === 'ASN') {
    return runAsnBalanceJob(request, appConfig, logger);
  }

  const jobLogger = logger.child({ jobId: request.id, jobType: request.jobType, operation: request.payload.operacion });
  const artifactDir = path.join(appConfig.artifactsDir, 'jobs', request.id);
  const runtimeConfig: AppConfig = {
    ...appConfig,
    headless: request.options.headless,
    debug: request.options.debug,
    slowMo: request.options.slowMo,
    timeoutMs: request.options.timeoutMs,
    postLoginWarmupPath: undefined
  };
  const captureSuccessArtifacts = parseEnvBoolean(process.env.BALANCE_CAPTURE_SUCCESS_ARTIFACTS) ?? false;

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

    let balanceResult: BalanceJobResult | undefined;
    const resolveUserStep = await executeActionStep(
      page,
      artifactDir,
      '01-resolve-rda-user',
      async () => {
        const resolved = await resolveRdaUserByApi(page, request.payload.usuario, runtimeConfig.timeoutMs);
        const saldoNumero = roundRdaMoney(resolved.user.balance);
        balanceResult = {
          kind: 'balance',
          pagina: 'RdA',
          operacion: 'consultar_saldo',
          usuario: request.payload.usuario,
          saldoTexto: formatRdaMoney(saldoNumero),
          saldoNumero
        };
      },
      captureSuccessArtifacts
    );
    if (resolveUserStep.artifactPath) {
      artifactPaths.push(resolveUserStep.artifactPath);
    }
    steps.push(resolveUserStep);
    if (resolveUserStep.status === 'failed') {
      throw new Error(`Step failed: ${resolveUserStep.name} (${resolveUserStep.error ?? 'unknown error'})`);
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
    await lease.release();

    if (!balanceResult) {
      throw new Error('Balance result was not captured');
    }

    return {
      artifactPaths,
      steps,
      result: balanceResult
    };
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = translateRdaJobError(rawMessage, {
      usuario: request.payload.usuario,
      operacion: request.payload.operacion
    });
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
    await lease.invalidate().catch(() => undefined);

    const wrapped = new Error(message);
    (wrapped as Error & { steps?: JobStepResult[]; artifactPaths?: string[] }).steps = steps;
    (wrapped as Error & { steps?: JobStepResult[]; artifactPaths?: string[] }).artifactPaths = artifactPaths;
    throw wrapped;
  }
}
