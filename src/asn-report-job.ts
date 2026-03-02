import path from 'node:path';
import { promises as fs } from 'node:fs';
import { chromium, type Locator, type Page } from 'playwright';
import type { Logger } from 'pino';
import { ensureAuthenticated } from './auth';
import { parseBalanceNumber } from './balance-job';
import { configureContext } from './browser';
import { resolveSiteAppConfig } from './site-profile';
import type { AppConfig, AsnReportJobRequest, AsnReportJobResult, JobExecutionResult, JobStepResult } from './types';

type AsnCdRow = {
  label: string;
  cargado: string;
  descargado: string;
  resultado: string;
};

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

export function getBuenosAiresMonthToken(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(now);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  if (!year || !month) {
    throw new Error('Could not compute current month token');
  }

  return `${year}-${month}`;
}

export function pickAsnMonthTotalCargadoRow(rows: AsnCdRow[], monthToken: string): AsnCdRow | null {
  const expected = normalizeSpaces(`TOTAL del mes ${monthToken}`).toLowerCase();
  for (const row of rows) {
    const label = normalizeSpaces(row.label).toLowerCase();
    if (label.includes(expected)) {
      return row;
    }
  }
  return null;
}

export function parseAsnReportCargadoNumber(rawValue: string): number {
  return parseBalanceNumber(rawValue);
}

export function extractAsnMonthTotalCargadoFromText(pageText: string, monthToken: string): string | null {
  const escapedMonth = monthToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(
    `TOTAL\\s+del\\s+mes\\s+${escapedMonth}\\s+(-?\\d{1,3}(?:\\.\\d{3})*,\\d{2}|-?\\d+,\\d{2}|-?\\d+)`,
    'i'
  );
  const match = pageText.match(regex);
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

async function clickLocator(locator: Locator, timeoutMs: number): Promise<void> {
  await locator.scrollIntoViewIfNeeded({ timeout: timeoutMs }).catch(() => undefined);
  try {
    await locator.click({ timeout: timeoutMs });
  } catch {
    await locator.click({ timeout: timeoutMs, force: true });
  }
}

async function tryHandleAsnContinue(page: Page, timeoutMs: number): Promise<'ok' | 'skipped'> {
  const selector = [
    'button:has-text("Continuar")',
    'a:has-text("Continuar")',
    'input[type="button"][value*="Continuar" i]',
    'input[type="submit"][value*="Continuar" i]',
    'button:has-text("Continue")',
    'a:has-text("Continue")'
  ].join(', ');
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const candidates = page.locator(selector);
    const count = await candidates.count().catch(() => 0);

    for (let i = 0; i < count; i += 1) {
      const candidate = candidates.nth(i);
      if (!(await candidate.isVisible().catch(() => false))) {
        continue;
      }

      await clickLocator(candidate, timeoutMs);
      await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => undefined);
      return 'ok';
    }

    await page.waitForTimeout(100);
  }

  return 'skipped';
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

async function readAsnCdRows(page: Page): Promise<AsnCdRow[]> {
  return page.evaluate(() => {
    const doc = (globalThis as { document?: unknown }).document as
      | { querySelectorAll: (selector: string) => unknown[] }
      | undefined;
    if (!doc) {
      return [];
    }

    const rows = Array.from(doc.querySelectorAll('tr') ?? []);
    const mapped: AsnCdRow[] = [];
    for (const row of rows) {
      const cells = Array.from(((row as { querySelectorAll?: (selector: string) => unknown[] }).querySelectorAll?.('td,th') ??
        []) as unknown[]).map((cell) =>
        (String((cell as { textContent?: unknown }).textContent ?? '')).replace(/\s+/g, ' ').trim()
      );
      if (cells.length < 2) {
        continue;
      }
      const label = cells[0] ?? '';
      const cargado = cells[1] ?? '';
      const descargado = cells[2] ?? '';
      const resultado = cells[3] ?? '';
      if (!label && !cargado && !descargado && !resultado) {
        continue;
      }
      mapped.push({ label, cargado, descargado, resultado });
    }
    return mapped;
  });
}

async function scrollAsnCdGrid(page: Page): Promise<boolean> {
  const movedByDom = await page.evaluate(() => {
    const doc = (globalThis as { document?: unknown }).document as
      | { querySelectorAll: (selector: string) => unknown[] }
      | undefined;
    const win = (globalThis as { window?: unknown }).window as
      | { scrollY: number; scrollBy: (x: number, y: number) => void }
      | undefined;
    if (!doc || !win) {
      return false;
    }

    const candidates = Array.from(doc.querySelectorAll('div, section, main, tbody') ?? []);
    for (const candidate of candidates) {
      const element = candidate as {
        scrollHeight?: number;
        clientHeight?: number;
        scrollTop?: number;
      };
      if ((element.scrollHeight ?? 0) <= (element.clientHeight ?? 0) + 5) {
        continue;
      }
      const previousTop = element.scrollTop ?? 0;
      const nextTop = Math.min(previousTop + 220, element.scrollHeight ?? previousTop);
      element.scrollTop = nextTop;
      if ((element.scrollTop ?? 0) !== previousTop) {
        return true;
      }
    }

    const previousWindowTop = win.scrollY;
    win.scrollBy(0, 220);
    return win.scrollY !== previousWindowTop;
  });

  await page.mouse.wheel(0, 280).catch(() => undefined);
  return movedByDom;
}

async function waitForAsnMonthTotalCargado(page: Page, monthToken: string, timeoutMs: number): Promise<AsnCdRow> {
  const startedAt = Date.now();
  let lastRowsSnapshot: AsnCdRow[] = [];

  while (Date.now() - startedAt < timeoutMs) {
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const byPageText = extractAsnMonthTotalCargadoFromText(bodyText, monthToken);
    if (byPageText) {
      return {
        label: `TOTAL del mes ${monthToken}`,
        cargado: byPageText,
        descargado: '',
        resultado: ''
      };
    }

    const rows = await readAsnCdRows(page);
    lastRowsSnapshot = rows;
    const match = pickAsnMonthTotalCargadoRow(rows, monthToken);
    if (match) {
      return match;
    }

    await scrollAsnCdGrid(page);
    await page.waitForTimeout(120);
  }

  const lastLabels = lastRowsSnapshot
    .map((row) => normalizeSpaces(row.label))
    .filter(Boolean)
    .slice(0, 20)
    .join(' | ');
  throw new Error(
    `Could not find row "TOTAL del mes ${monthToken}" in ASN Cargas y Descargas table. Last labels: ${lastLabels}`
  );
}

export async function runAsnReportJob(
  request: AsnReportJobRequest,
  appConfig: AppConfig,
  logger: Logger
): Promise<JobExecutionResult> {
  if (request.payload.pagina !== 'ASN') {
    throw new Error('ASN report job only supports pagina=ASN');
  }

  const jobLogger = logger.child({
    jobId: request.id,
    jobType: request.jobType,
    operation: request.payload.operacion,
    pagina: request.payload.pagina
  });
  const artifactDir = path.join(appConfig.artifactsDir, 'jobs', request.id);
  const siteConfig = resolveSiteAppConfig(appConfig, 'ASN');
  const runtimeConfig: AppConfig = {
    ...siteConfig,
    headless: request.options.headless,
    debug: request.options.debug,
    slowMo: request.options.slowMo,
    timeoutMs: request.options.timeoutMs,
    blockResources: false
  };
  const isTurbo = !runtimeConfig.debug && runtimeConfig.slowMo === 0;
  const captureSuccessArtifacts = parseEnvBoolean(process.env.REPORT_CAPTURE_SUCCESS_ARTIFACTS) ?? false;

  await fs.mkdir(artifactDir, { recursive: true });

  const browser = await chromium.launch({
    headless: runtimeConfig.headless,
    slowMo: runtimeConfig.slowMo,
    args: runtimeConfig.headless ? undefined : ['--start-maximized']
  });
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
  let resultPayload: AsnReportJobResult | undefined;

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

    const continueStartedAt = new Date().toISOString();
    const continueState = await tryHandleAsnContinue(page, isTurbo ? 900 : Math.min(runtimeConfig.timeoutMs, 3_000));
    steps.push({
      name: '01b-continue-intermediate',
      status: continueState === 'ok' ? 'ok' : 'skipped',
      startedAt: continueStartedAt,
      finishedAt: new Date().toISOString()
    });

    const targetPath = `/NewAdmin/JugadoresCD.php?usr=${encodeURIComponent(request.payload.usuario)}`;
    const gotoStep = await executeActionStep(
      page,
      artifactDir,
      '02-goto-user-cd',
      async () => {
        await page.goto(targetPath, { waitUntil: 'domcontentloaded', timeout: runtimeConfig.timeoutMs });
        await findFirstVisibleLocator(page, 'text=/Cargas\\s*y\\s*Descargas|Cargado|TOTAL del mes/i', runtimeConfig.timeoutMs);
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

    const monthToken = getBuenosAiresMonthToken();
    let monthTotalRow: AsnCdRow | undefined;
    const findTotalStep = await executeActionStep(
      page,
      artifactDir,
      '03-find-month-total-row',
      async () => {
        monthTotalRow = await waitForAsnMonthTotalCargado(
          page,
          monthToken,
          isTurbo ? Math.min(runtimeConfig.timeoutMs, 7_000) : Math.min(runtimeConfig.timeoutMs, 12_000)
        );
      },
      captureSuccessArtifacts
    );
    if (findTotalStep.artifactPath) {
      artifactPaths.push(findTotalStep.artifactPath);
    }
    steps.push(findTotalStep);
    if (findTotalStep.status === 'failed') {
      throw new Error(`Step failed: ${findTotalStep.name} (${findTotalStep.error ?? 'unknown error'})`);
    }

    const readStep = await executeActionStep(
      page,
      artifactDir,
      '04-read-cargado-total-mes',
      async () => {
        if (!monthTotalRow) {
          throw new Error('Month total row was not resolved');
        }
        const cargadoTexto = normalizeSpaces(monthTotalRow.cargado);
        const cargadoNumero = parseAsnReportCargadoNumber(cargadoTexto);
        resultPayload = {
          kind: 'asn-reporte-cargado-mes',
          pagina: 'ASN',
          usuario: request.payload.usuario,
          mesActual: monthToken,
          cargadoTexto,
          cargadoNumero
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
      throw new Error('ASN report result was not captured');
    }

    return {
      artifactPaths,
      steps,
      result: resultPayload
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    jobLogger.error({ error }, 'ASN report job failed');

    try {
      await page.screenshot({ path: screenshotFailurePath, fullPage: true });
      artifactPaths.push(screenshotFailurePath);
    } catch {
      jobLogger.warn('Could not capture ASN report failure screenshot');
    }

    if (tracingStarted) {
      try {
        await context.tracing.stop({ path: traceFailurePath });
        artifactPaths.push(traceFailurePath);
      } catch {
        jobLogger.warn('Could not persist ASN report failure trace');
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
