import { promises as fs } from 'node:fs';
import type { BrowserContext, Page } from 'playwright';
import type { Logger } from 'pino';
import type { AppConfig, ResolvedCredentials } from './types';

interface AuthSessionOptions {
  persistSession?: boolean;
  storageStatePath?: string;
}

async function firstVisibleSelector(page: Page, selectors: string[], timeoutMs: number): Promise<string | null> {
  const startedAt = Date.now();
  const maxWaitMs = Math.max(250, timeoutMs);

  while (Date.now() - startedAt < maxWaitMs) {
    for (const selector of selectors) {
      const visible = await page
        .locator(selector)
        .first()
        .isVisible()
        .catch(() => false);
      if (visible) {
        return selector;
      }
    }

    await page.waitForTimeout(80);
  }

  return null;
}

async function hasLoginForm(page: Page, cfg: AppConfig): Promise<boolean> {
  const loginUrl = new URL(cfg.loginPath, `${cfg.baseUrl}/`);
  let currentPath = '';

  try {
    currentPath = new URL(page.url()).pathname.toLowerCase();
  } catch {
    currentPath = page.url().toLowerCase();
  }

  const loginPath = loginUrl.pathname.toLowerCase();
  if (!currentPath.includes(loginPath)) {
    return false;
  }

  const usernameSelector = await firstVisibleSelector(page, cfg.selectors.username, 500);
  const passwordSelector = await firstVisibleSelector(page, cfg.selectors.password, 500);
  return Boolean(usernameSelector && passwordSelector);
}

async function waitForAuthenticatedState(page: Page, cfg: AppConfig): Promise<void> {
  const tasks: Array<Promise<unknown>> = [];
  const authTransitionTimeoutMs = Math.min(cfg.timeoutMs, 15_000);

  tasks.push(
    page.waitForURL(
      (url) => {
        return !url.pathname.toLowerCase().includes('login');
      },
      { timeout: authTransitionTimeoutMs }
    )
  );

  if (cfg.selectors.success) {
    tasks.push(
      page.locator(cfg.selectors.success).first().waitFor({ state: 'visible', timeout: authTransitionTimeoutMs })
    );
  }

  tasks.push(page.waitForLoadState('networkidle', { timeout: Math.min(authTransitionTimeoutMs, 7_500) }));

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
  const selectorDiscoveryTimeoutMs = Math.min(cfg.timeoutMs, 8_000);
  const loginUrl = new URL(cfg.loginPath, `${cfg.baseUrl}/`).toString();
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: cfg.timeoutMs });

  const hasForm = await hasLoginForm(page, cfg);
  if (!hasForm) {
    logger.info('Session already authenticated, skipping login');
    return;
  }

  const usernameSelector = await firstVisibleSelector(page, cfg.selectors.username, selectorDiscoveryTimeoutMs);
  const passwordSelector = await firstVisibleSelector(page, cfg.selectors.password, selectorDiscoveryTimeoutMs);
  const submitSelector = await firstVisibleSelector(page, cfg.selectors.submit, selectorDiscoveryTimeoutMs);

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
