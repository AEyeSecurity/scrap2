import { promises as fs } from 'node:fs';
import type { BrowserContext, Page } from 'playwright';
import type { Logger } from 'pino';
import type { AppConfig, ResolvedCredentials } from './types';

interface AuthSessionOptions {
  persistSession?: boolean;
  storageStatePath?: string;
}

async function firstVisibleSelector(page: Page, selectors: string[], timeoutMs: number): Promise<string | null> {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: 'visible', timeout: Math.min(timeoutMs, 2_500) });
      return selector;
    } catch {
      // ignore and continue
    }
  }

  return null;
}

async function hasLoginForm(page: Page, cfg: AppConfig): Promise<boolean> {
  const usernameSelector = await firstVisibleSelector(page, cfg.selectors.username, 2_500);
  const passwordSelector = await firstVisibleSelector(page, cfg.selectors.password, 2_500);
  return Boolean(usernameSelector && passwordSelector);
}

async function waitForAuthenticatedState(page: Page, cfg: AppConfig): Promise<void> {
  const tasks: Array<Promise<unknown>> = [];

  tasks.push(
    page.waitForURL(
      (url) => {
        return !url.pathname.toLowerCase().includes('login');
      },
      { timeout: cfg.timeoutMs }
    )
  );

  if (cfg.selectors.success) {
    tasks.push(page.locator(cfg.selectors.success).first().waitFor({ state: 'visible', timeout: cfg.timeoutMs }));
  }

  tasks.push(page.waitForLoadState('networkidle', { timeout: cfg.timeoutMs }));

  await Promise.any(tasks);

  if (cfg.selectors.error) {
    const errorLocator = page.locator(cfg.selectors.error).first();
    if (await errorLocator.isVisible().catch(() => false)) {
      const errorText = (await errorLocator.textContent())?.trim() || 'login error detected';
      throw new Error(errorText);
    }
  }

  if (await hasLoginForm(page, cfg)) {
    throw new Error('Authentication did not complete: login form is still visible');
  }
}

export async function ensureAuthenticated(
  context: BrowserContext,
  page: Page,
  cfg: AppConfig,
  credentials: ResolvedCredentials,
  logger: Logger,
  sessionOptions: AuthSessionOptions = {}
): Promise<void> {
  const persistSession = sessionOptions.persistSession ?? true;
  const storageStatePath = sessionOptions.storageStatePath ?? cfg.storageStatePath;
  const loginUrl = new URL(cfg.loginPath, `${cfg.baseUrl}/`).toString();
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: cfg.timeoutMs });

  const hasForm = await hasLoginForm(page, cfg);
  if (!hasForm) {
    logger.info('Session already authenticated, skipping login');
    return;
  }

  const usernameSelector = await firstVisibleSelector(page, cfg.selectors.username, cfg.timeoutMs);
  const passwordSelector = await firstVisibleSelector(page, cfg.selectors.password, cfg.timeoutMs);
  const submitSelector = await firstVisibleSelector(page, cfg.selectors.submit, cfg.timeoutMs);

  if (!usernameSelector || !passwordSelector || !submitSelector) {
    throw new Error('Could not locate login form selectors. Override selector env vars.');
  }

  logger.info({ usernameSelector, passwordSelector, submitSelector }, 'Logging in');

  await page.locator(usernameSelector).first().fill(credentials.username, { timeout: cfg.timeoutMs });
  await page.locator(passwordSelector).first().fill(credentials.password, { timeout: cfg.timeoutMs });

  await Promise.all([
    waitForAuthenticatedState(page, cfg),
    page.locator(submitSelector).first().click({ timeout: cfg.timeoutMs })
  ]);

  if (persistSession) {
    await fs.mkdir(cfg.artifactsDir, { recursive: true });
    await context.storageState({ path: storageStatePath });
    logger.info({ storageStatePath }, 'Login successful and session persisted');
  } else {
    logger.info('Login successful');
  }
}
