import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { Logger } from 'pino';
import type { AppConfig } from './types';
import { configureContext } from './browser';

export interface FundsSessionLease {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  release: () => Promise<void>;
  invalidate: () => Promise<void>;
  reused: boolean;
  pooled: boolean;
}

interface FundsSessionEntry {
  cacheKey: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  createdAt: number;
  lastUsedAt: number;
}

const entries = new Map<string, FundsSessionEntry>();
const locks = new Map<string, Promise<void>>();

function parseEnvBoolean(input: string | undefined): boolean | undefined {
  if (input == null) return undefined;
  const normalized = input.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return undefined;
}

function getPoolEnabled(): boolean {
  return parseEnvBoolean(process.env.FUNDS_SESSION_CACHE_ENABLED) ?? true;
}

function getPoolTtlMs(): number {
  const raw = Number(process.env.FUNDS_SESSION_TTL_MS ?? 10 * 60 * 1000);
  return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60 * 1000;
}

function getPoolMaxAgents(): number {
  const raw = Number(process.env.FUNDS_SESSION_MAX_AGENTS ?? 8);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 8;
}

function isTurboLike(cfg: AppConfig): boolean {
  return !cfg.debug && cfg.slowMo === 0;
}

function buildCacheKey(agent: string, cfg: AppConfig): string {
  return [
    agent.trim().toLowerCase(),
    cfg.baseUrl,
    `h=${cfg.headless ? 1 : 0}`,
    `br=${cfg.blockResources ? 1 : 0}`
  ].join('|');
}

async function closeEntry(entry: FundsSessionEntry): Promise<void> {
  await entry.context.close().catch(() => undefined);
  await entry.browser.close().catch(() => undefined);
}

async function isEntryUsable(entry: FundsSessionEntry): Promise<boolean> {
  if (entry.page.isClosed()) {
    return false;
  }
  try {
    // Triggers if the page/context/browser was torn down.
    void entry.page.url();
    return true;
  } catch {
    return false;
  }
}

async function evictExpiredEntries(logger: Logger): Promise<void> {
  const now = Date.now();
  const ttlMs = getPoolTtlMs();
  for (const [key, entry] of entries) {
    if (now - entry.lastUsedAt <= ttlMs) {
      continue;
    }
    entries.delete(key);
    logger.debug({ key }, 'Evicting expired funds session');
    await closeEntry(entry);
  }
}

async function evictOldestIfNeeded(logger: Logger): Promise<void> {
  const maxAgents = getPoolMaxAgents();
  if (entries.size < maxAgents) {
    return;
  }

  let oldestKey: string | null = null;
  let oldestTs = Number.POSITIVE_INFINITY;
  for (const [key, entry] of entries) {
    if (entry.lastUsedAt < oldestTs) {
      oldestTs = entry.lastUsedAt;
      oldestKey = key;
    }
  }

  if (!oldestKey) {
    return;
  }

  const oldest = entries.get(oldestKey);
  if (!oldest) {
    return;
  }

  entries.delete(oldestKey);
  logger.debug({ key: oldestKey }, 'Evicting oldest funds session to respect pool size');
  await closeEntry(oldest);
}

async function createSession(cacheKey: string, cfg: AppConfig, logger: Logger): Promise<FundsSessionEntry> {
  const browser = await chromium.launch({
    headless: cfg.headless,
    slowMo: cfg.slowMo,
    args: cfg.headless ? undefined : ['--start-maximized']
  });

  const context = await browser.newContext({
    baseURL: cfg.baseUrl,
    viewport: cfg.headless ? { width: 1920, height: 1080 } : null
  });

  await configureContext(context, cfg, logger);
  const page = await context.newPage();
  const now = Date.now();
  return {
    cacheKey,
    browser,
    context,
    page,
    createdAt: now,
    lastUsedAt: now
  };
}

export async function acquireFundsSessionLease(
  agent: string,
  cfg: AppConfig,
  logger: Logger
): Promise<FundsSessionLease> {
  const poolingAllowed = getPoolEnabled() && isTurboLike(cfg);
  if (!poolingAllowed) {
    const entry = await createSession(`isolated:${Date.now()}`, cfg, logger);
    return {
      browser: entry.browser,
      context: entry.context,
      page: entry.page,
      pooled: false,
      reused: false,
      release: async () => {
        await closeEntry(entry);
      },
      invalidate: async () => {
        await closeEntry(entry);
      }
    };
  }

  const cacheKey = buildCacheKey(agent, cfg);
  const previous = locks.get(cacheKey) ?? Promise.resolve();
  let unlock!: () => void;
  const hold = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const queuePromise = previous.then(() => hold);
  locks.set(cacheKey, queuePromise);

  await previous;

  await evictExpiredEntries(logger);
  let entry = entries.get(cacheKey);
  let reused = false;

  if (entry) {
    const usable = await isEntryUsable(entry);
    if (!usable) {
      entries.delete(cacheKey);
      await closeEntry(entry);
      entry = undefined;
    }
  }

  if (!entry) {
    await evictOldestIfNeeded(logger);
    entry = await createSession(cacheKey, cfg, logger);
    entries.set(cacheKey, entry);
    logger.debug({ cacheKey }, 'Created pooled funds session');
  } else {
    reused = true;
    entry.lastUsedAt = Date.now();
    entry.context.setDefaultTimeout(cfg.timeoutMs);
    entry.context.setDefaultNavigationTimeout(cfg.timeoutMs);
    logger.debug({ cacheKey }, 'Reusing pooled funds session');
  }

  let released = false;
  const finishLock = (): void => {
    unlock();
    if (locks.get(cacheKey) === queuePromise) {
      locks.delete(cacheKey);
    }
  };

  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    const current = entries.get(cacheKey);
    if (current) {
      current.lastUsedAt = Date.now();
    }
    finishLock();
  };

  const invalidate = async (): Promise<void> => {
    if (released) return;
    released = true;
    const current = entries.get(cacheKey);
    if (current) {
      entries.delete(cacheKey);
      await closeEntry(current);
    }
    finishLock();
  };

  return {
    browser: entry.browser,
    context: entry.context,
    page: entry.page,
    pooled: true,
    reused,
    release,
    invalidate
  };
}
