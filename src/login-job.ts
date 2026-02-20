import path from 'node:path';
import { promises as fs } from 'node:fs';
import { chromium } from 'playwright';
import type { Logger } from 'pino';
import { ensureAuthenticated } from './auth';
import { configureContext } from './browser';
import type { AppConfig, JobExecutionResult, JobStepResult, LoginJobRequest } from './types';

async function captureStepScreenshot(
  page: { screenshot: (options: { path: string; fullPage: boolean }) => Promise<unknown> },
  pathName: string
): Promise<string> {
  await page.screenshot({ path: pathName, fullPage: true });
  return pathName;
}

export async function runLoginJob(request: LoginJobRequest, appConfig: AppConfig, logger: Logger): Promise<JobExecutionResult> {
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
  const screenshotFinalPath = path.join(artifactDir, 'final.png');

  let tracingStarted = false;
  try {
    if (runtimeConfig.debug) {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      tracingStarted = true;
    }

    const loginStartedAt = new Date().toISOString();
    await ensureAuthenticated(context, page, runtimeConfig, request.payload, jobLogger, {
      persistSession: false
    });
    const loginStep: JobStepResult = {
      name: 'login',
      status: 'ok',
      startedAt: loginStartedAt,
      finishedAt: new Date().toISOString()
    };

    try {
      loginStep.artifactPath = await captureStepScreenshot(page, screenshotFinalPath);
      artifactPaths.push(screenshotFinalPath);
    } catch {
      jobLogger.warn('Could not capture final login screenshot');
    }

    steps.push(loginStep);

    if (tracingStarted) {
      await context.tracing.stop({ path: tracePath });
      artifactPaths.push(tracePath);
      tracingStarted = false;
    }

    await context.close();
    await browser.close();
    return { artifactPaths, steps };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    jobLogger.error({ error }, 'Login job failed');

    steps.push({
      name: 'login',
      status: 'failed',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      error: message
    });

    try {
      await page.screenshot({ path: screenshotFailurePath, fullPage: true });
      artifactPaths.push(screenshotFailurePath);
    } catch {
      jobLogger.warn('Could not capture login job screenshot');
    }

    if (tracingStarted) {
      try {
        await context.tracing.stop({ path: traceFailurePath });
        artifactPaths.push(traceFailurePath);
      } catch {
        jobLogger.warn('Could not persist login job trace');
      }
    }

    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);

    const wrapped = new Error(message);
    (wrapped as Error & { steps?: JobStepResult[]; artifactPaths?: string[] }).steps = steps;
    (wrapped as Error & { steps?: JobStepResult[]; artifactPaths?: string[] }).artifactPaths = artifactPaths;
    throw wrapped;
  }
}
