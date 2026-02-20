import pLimit from 'p-limit';
import pRetry from 'p-retry';
import type { APIRequestContext, Page, Response } from 'playwright';
import type { Logger } from 'pino';
import type { ApiFetchResult, ScraperConfig } from './types';

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function toRelativeEndpoint(url: string, cfg: ScraperConfig): string | null {
  try {
    const parsed = new URL(url);
    if (!parsed.pathname.includes('/api/')) {
      return null;
    }

    const baseOrigin = new URL(cfg.baseUrl).origin;
    if (parsed.origin !== baseOrigin) {
      return null;
    }

    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

function hydrateEndpoint(endpoint: string, cfg: ScraperConfig): string {
  return endpoint
    .replaceAll('{fromDate}', cfg.fromDate ?? '')
    .replaceAll('{toDate}', cfg.toDate ?? '');
}

async function fetchJsonOrText(
  request: APIRequestContext,
  url: string,
  timeoutMs: number
): Promise<{ status: number; body: unknown }> {
  const response = await request.get(url, { timeout: timeoutMs });
  const status = response.status();

  if (isRetryableStatus(status) || status >= 400) {
    throw new Error(`HTTP status ${status} for ${url}`);
  }

  const contentType = response.headers()['content-type'] ?? '';
  if (contentType.includes('application/json')) {
    return { status, body: await response.json() };
  }

  return { status, body: await response.text() };
}

async function fetchEndpoint(
  request: APIRequestContext,
  cfg: ScraperConfig,
  endpoint: string,
  logger: Logger
): Promise<ApiFetchResult> {
  const hydrated = hydrateEndpoint(endpoint, cfg);
  const url = new URL(hydrated, `${cfg.baseUrl}/`).toString();

  const payload = await pRetry(
    async () => {
      logger.debug({ url }, 'Fetching endpoint');
      return fetchJsonOrText(request, url, cfg.timeoutMs);
    },
    {
      retries: cfg.retries,
      onFailedAttempt: (context) => {
        const message =
          context.error instanceof Error ? context.error.message : String(context.error);
        logger.warn(
          {
            url,
            attempt: context.attemptNumber,
            retriesLeft: context.retriesLeft,
            message
          },
          'Endpoint fetch failed, retrying'
        );
      }
    }
  );

  return {
    endpoint: hydrated,
    status: payload.status,
    ok: true,
    body: payload.body,
    fetchedAt: new Date().toISOString()
  };
}

async function discoverEndpoints(page: Page, cfg: ScraperConfig, logger: Logger): Promise<string[]> {
  const discovered = new Set<string>();

  const listener = (response: Response) => {
    if (response.request().method() !== 'GET' || response.status() >= 400) {
      return;
    }

    const relative = toRelativeEndpoint(response.url(), cfg);
    if (relative) {
      discovered.add(relative);
    }
  };

  page.on('response', listener);

  try {
    await page.waitForLoadState('networkidle', { timeout: cfg.timeoutMs }).catch(() => undefined);
    await page.waitForTimeout(2_000);
  } finally {
    page.off('response', listener);
  }

  const endpoints = [...discovered];
  logger.info({ endpoints }, 'Discovered API endpoints from traffic');
  return endpoints;
}

export async function extractApiData(page: Page, cfg: ScraperConfig, logger: Logger): Promise<ApiFetchResult[]> {
  const configured = cfg.apiEndpoints;
  const discovered = configured.length === 0 ? await discoverEndpoints(page, cfg, logger) : [];

  const endpoints = [...new Set([...configured, ...discovered])];
  if (endpoints.length === 0) {
    logger.warn('No API endpoints configured or discovered. Extraction will be empty.');
    return [];
  }

  const limiter = pLimit(cfg.concurrency);
  const request = page.context().request;

  const tasks = endpoints.map((endpoint) =>
    limiter(async () => {
      return fetchEndpoint(request, cfg, endpoint, logger);
    })
  );

  return Promise.all(tasks);
}
