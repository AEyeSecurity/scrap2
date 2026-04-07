import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { Locator, Page } from 'playwright';
import type { Logger } from 'pino';
import { ensureAuthenticated } from './auth';
import { parseBalanceNumber } from './balance-job';
import { configureContext, launchChromiumBrowser } from './browser';
import { translateRdaJobError } from './rda-user-error';
import { resolveSiteAppConfig } from './site-profile';
import type { AppConfig, JobExecutionResult, JobStepResult, RdaReportJobRequest, RdaReportJobResult } from './types';

const RDA_DEPOSITO_TOTAL_LABEL_REGEX = /dep[o\u00f3]sito\s+total/i;
const RDA_MONEY_REGEX = /-?\$?\s*\d{1,3}(?:\.\d{3})*,\d{2}|-?\$?\s*\d+,\d{2}|-?\$?\s*\d+/;

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

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeSearchText(value: string): string {
  return normalizeSpaces(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export function parseRdaDepositoTotalNumber(rawValue: string): number {
  return parseBalanceNumber(rawValue);
}

export function extractRdaDepositoTotalFromText(pageText: string): string | null {
  const normalized = normalizeSpaces(pageText);
  const match = normalized.match(
    /dep[o\u00f3]sito\s+total\s+(-?\$?\s*\d{1,3}(?:\.\d{3})*,\d{2}|-?\$?\s*\d+,\d{2}|-?\$?\s*\d+)/i
  );
  return match?.[1]?.trim() ?? null;
}

async function captureStepScreenshot(page: Page, artifactDir: string, name: string): Promise<string> {
  const filePath = path.join(artifactDir, `${sanitizeFileName(name)}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
}

async function waitBeforeCloseIfHeaded(page: Page, headless: boolean, debug: boolean): Promise<void> {
  if (headless || !debug) {
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
      ...(artifactPath ? { artifactPath } : {})
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

async function readRdaDepositoTotal(page: Page): Promise<string> {
  const byCard = await page.evaluate(
    ({ labelSource, moneySource }) => {
      const labelRegex = new RegExp(labelSource, 'i');
      const moneyRegex = new RegExp(moneySource);
      const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
      const doc = (globalThis as any).document;
      const candidates: any[] = Array.from(
        doc.querySelectorAll('.cash-report-total-desktop__item, .cash-report-total-mobile__item, [class*="cash-report-total"]')
      );

      for (const element of candidates) {
        const text = normalize(element.innerText || element.textContent || '');
        if (!labelRegex.test(text)) {
          continue;
        }

        const valueElement = element.querySelector('[class*="value"], .ellipsis-text');
        const valueText = normalize(valueElement?.innerText || valueElement?.textContent || '');
        const valueMatch = valueText.match(moneyRegex);
        if (valueMatch?.[0]) {
          return valueMatch[0].trim();
        }

        const textMatch = text.match(moneyRegex);
        if (textMatch?.[0]) {
          return textMatch[0].trim();
        }
      }

      return null;
    },
    { labelSource: RDA_DEPOSITO_TOTAL_LABEL_REGEX.source, moneySource: RDA_MONEY_REGEX.source }
  );

  if (typeof byCard === 'string' && byCard.trim()) {
    return byCard.trim();
  }

  const bodyText = await page.locator('body').innerText().catch(() => '');
  const byText = extractRdaDepositoTotalFromText(bodyText);
  if (byText) {
    return byText;
  }

  throw new Error(`Could not find visible "Deposito total" value. Text sample: ${normalizeSpaces(bodyText).slice(0, 240)}`);
}

export async function runRdaReportJob(
  request: RdaReportJobRequest,
  appConfig: AppConfig,
  logger: Logger
): Promise<JobExecutionResult> {
  if (request.payload.pagina !== 'RdA') {
    throw new Error('RdA report job only supports pagina=RdA');
  }

  const jobLogger = logger.child({
    jobId: request.id,
    jobType: request.jobType,
    operation: request.payload.operacion,
    pagina: request.payload.pagina
  });
  const artifactDir = path.join(appConfig.artifactsDir, 'jobs', request.id);
  const siteConfig = resolveSiteAppConfig(appConfig, 'RdA');
  const runtimeConfig: AppConfig = {
    ...siteConfig,
    headless: request.options.headless,
    debug: request.options.debug,
    slowMo: request.options.slowMo,
    timeoutMs: request.options.timeoutMs,
    blockResources: false
  };
  const captureSuccessArtifacts = parseEnvBoolean(process.env.REPORT_CAPTURE_SUCCESS_ARTIFACTS) ?? false;

  await fs.mkdir(artifactDir, { recursive: true });

  const browser = await launchChromiumBrowser(runtimeConfig, jobLogger);
  const context = await browser.newContext({
    baseURL: runtimeConfig.baseUrl,
    viewport: runtimeConfig.headless ? { width: 1920, height: 1080 } : null,
    recordVideo: runtimeConfig.debug ? { dir: path.join(artifactDir, 'video') } : undefined
  });
  await configureContext(context, runtimeConfig, jobLogger);

  const page = await context.newPage();
  const artifactPaths: string[] = [];
  const steps: JobStepResult[] = [];
  const tracePath = path.join(artifactDir, 'trace.zip');
  const traceFailurePath = path.join(artifactDir, 'trace-failure.zip');
  const screenshotFailurePath = path.join(artifactDir, 'error.png');
  let tracingStarted = false;
  let resultPayload: RdaReportJobResult | undefined;

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
        username: request.payload.agente,
        password: request.payload.contrasena_agente
      },
      jobLogger,
      { persistSession: false }
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

    const targetPath = `/financial-reports/cash?role=0&user=${encodeURIComponent(request.payload.usuario.trim().toLowerCase())}`;
    const gotoStep = await executeActionStep(
      page,
      artifactDir,
      '01-goto-cash-report',
      async () => {
        await page.goto(targetPath, { waitUntil: 'domcontentloaded', timeout: runtimeConfig.timeoutMs });
        await findFirstVisibleLocator(page, 'text=/Dep[o\\u00f3]sitos\\s+y\\s+retiros|Dep[o\\u00f3]sito\\s+total/i', runtimeConfig.timeoutMs);
      },
      captureSuccessArtifacts
    );
    if (gotoStep.artifactPath) {
      artifactPaths.push(gotoStep.artifactPath);
    }
    steps.push(gotoStep);
    if (gotoStep.status === 'failed') {
      throw new Error(`Step failed: ${gotoStep.name} (${gotoStep.error ?? 'unknown error'})`);
    }

    const readStep = await executeActionStep(
      page,
      artifactDir,
      '02-read-deposito-total',
      async () => {
        const depositoTotalTexto = normalizeSpaces(await readRdaDepositoTotal(page));
        const depositoTotalNumero = parseRdaDepositoTotalNumber(depositoTotalTexto);
        resultPayload = {
          kind: 'rda-reporte-deposito-total',
          pagina: 'RdA',
          usuario: request.payload.usuario,
          depositoTotalTexto,
          depositoTotalNumero,
          cargadoTexto: depositoTotalTexto,
          cargadoNumero: depositoTotalNumero,
          cargadoHoyTexto: '0,00',
          cargadoHoyNumero: 0
        };
      },
      captureSuccessArtifacts
    );
    if (readStep.artifactPath) {
      artifactPaths.push(readStep.artifactPath);
    }
    steps.push(readStep);
    if (readStep.status === 'failed') {
      throw new Error(`Step failed: ${readStep.name} (${readStep.error ?? 'unknown error'})`);
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

    if (!resultPayload) {
      throw new Error('RdA report result was not captured');
    }

    return {
      artifactPaths,
      steps,
      result: resultPayload
    };
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = translateRdaJobError(rawMessage, { usuario: request.payload.usuario, operacion: 'reporte' });
    jobLogger.error({ error }, 'RdA report job failed');

    try {
      await page.screenshot({ path: screenshotFailurePath, fullPage: true });
      artifactPaths.push(screenshotFailurePath);
    } catch {
      jobLogger.warn('Could not capture RdA report failure screenshot');
    }

    if (tracingStarted) {
      try {
        await context.tracing.stop({ path: traceFailurePath });
        artifactPaths.push(traceFailurePath);
      } catch {
        jobLogger.warn('Could not persist RdA report failure trace');
      }
    }

    await waitBeforeCloseIfHeaded(page, runtimeConfig.headless, runtimeConfig.debug).catch(() => undefined);
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);

    throw new Error(message, { cause: error instanceof Error ? error : undefined });
  }
}
