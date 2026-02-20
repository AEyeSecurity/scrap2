import { promises as fs } from 'node:fs';
import { chromium } from 'playwright';
import type { Logger } from 'pino';
import { ensureAuthenticated } from './auth';
import { configureContext } from './browser';
import { extractApiData } from './extract';
import { normalizeApiResults } from './normalize';
import { writeOutputs } from './output';
import type { RunConfig, RunMetadata } from './types';

export async function runScraper(cfg: RunConfig, logger: Logger): Promise<RunMetadata> {
  const startedAt = new Date();
  const errors: string[] = [];
  await fs.mkdir(cfg.artifactsDir, { recursive: true });

  const browser = await chromium.launch({
    headless: cfg.headless,
    slowMo: cfg.slowMo,
    args: cfg.headless ? undefined : ['--start-maximized']
  });

  const storageState =
    cfg.reuseSession && (await fs.access(cfg.storageStatePath).then(() => true).catch(() => false))
      ? cfg.storageStatePath
      : undefined;
  if (cfg.reuseSession && !storageState) {
    logger.debug({ storageStatePath: cfg.storageStatePath }, 'No stored session found, using fresh context');
  }

  const context = await browser.newContext({
    baseURL: cfg.baseUrl,
    viewport: cfg.headless ? undefined : null,
    storageState,
    recordVideo: cfg.debug
      ? {
          dir: `${cfg.artifactsDir}/video`
        }
      : undefined
  });

  await configureContext(context, cfg, logger);

  const page = await context.newPage();

  let tracingStarted = false;
  try {
    if (cfg.debug) {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      tracingStarted = true;
    }

    await ensureAuthenticated(
      context,
      page,
      cfg,
      { username: cfg.username, password: cfg.password },
      logger,
      { persistSession: true, storageStatePath: cfg.storageStatePath }
    );
    const apiResults = await extractApiData(page, cfg, logger);
    const normalized = normalizeApiResults(apiResults);

    const endedAt = new Date();
    const meta = await writeOutputs(cfg.outputDir, normalized, {
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: endedAt.getTime() - startedAt.getTime(),
      records: normalized.length,
      apiCalls: apiResults.length,
      retries: cfg.retries,
      errors
    });

    logger.info({ records: normalized.length, apiCalls: apiResults.length }, 'Scraping finished');

    if (tracingStarted) {
      await context.tracing.stop({ path: `${cfg.artifactsDir}/trace.zip` });
      tracingStarted = false;
    }

    await context.close();
    await browser.close();

    return meta;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    logger.error({ error }, 'Scraping failed');

    try {
      const screenshotPath = `${cfg.artifactsDir}/error-${Date.now()}.png`;
      await page.screenshot({ path: screenshotPath, fullPage: true });
      logger.info({ screenshotPath }, 'Saved failure screenshot');
    } catch {
      logger.warn('Could not capture failure screenshot');
    }

    if (tracingStarted) {
      try {
        await context.tracing.stop({ path: `${cfg.artifactsDir}/trace-failure.zip` });
      } catch {
        logger.warn('Could not write failure trace');
      }
    }

    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);

    throw error;
  }
}
