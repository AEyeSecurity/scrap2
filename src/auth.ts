import { promises as fs } from 'node:fs';
import type { BrowserContext, Locator, Page } from 'playwright';
import type { Logger } from 'pino';
import type { AppConfig, ResolvedCredentials } from './types';

interface AuthSessionOptions {
  persistSession?: boolean;
  storageStatePath?: string;
}

interface VisibleControl {
  selector: string;
  locator: Locator;
}

const FALLBACK_AUTH_ERROR_TEXT =
  /usuario no autorizado|no autorizado|contrase(?:n|\u00f1)a\s+no\s+corregida|credenciales incorrectas/i;
const AUTHENTICATED_UI_TEXT = /mis estad[i\u00ed]sticas|usuarios|reportes financieros|informes de jugadores|finanzas/i;
const LOGIN_SUBMIT_DELAY_MS = 1_500;

function isLoginPath(page: Page): boolean {
  try {
    return new URL(page.url()).pathname.toLowerCase().includes('login');
  } catch {
    return true;
  }
}

async function firstVisibleControl(page: Page, selectors: string[], timeoutMs: number): Promise<VisibleControl | null> {
  const startedAt = Date.now();
  const pollingMs = 100;

  while (Date.now() - startedAt < timeoutMs) {
    for (const selector of selectors) {
      const locator = page.locator(selector);
      const count = await locator.count();
      for (let i = 0; i < count; i += 1) {
        const candidate = locator.nth(i);
        if (await candidate.isVisible().catch(() => false)) {
          return { selector, locator: candidate };
        }
      }
    }

    await page.waitForTimeout(pollingMs);
  }

  return null;
}

async function hasLoginForm(page: Page, cfg: AppConfig): Promise<boolean> {
  const usernameControl = await firstVisibleControl(page, cfg.selectors.username, 250);
  const passwordControl = await firstVisibleControl(page, cfg.selectors.password, 250);
  return Boolean(usernameControl && passwordControl);
}

async function readVisibleAuthError(page: Page, cfg: AppConfig): Promise<string | null> {
  if (cfg.selectors.error) {
    const configured = page.locator(cfg.selectors.error).first();
    if (await configured.isVisible().catch(() => false)) {
      return (await configured.textContent())?.trim() || 'login error detected';
    }
  }

  const fallback = page.locator('body').getByText(FALLBACK_AUTH_ERROR_TEXT).first();
  if (await fallback.isVisible().catch(() => false)) {
    return (await fallback.textContent())?.trim() || 'login error detected';
  }

  return null;
}

async function hasAuthenticatedShell(page: Page): Promise<boolean> {
  return page.locator('body').getByText(AUTHENTICATED_UI_TEXT).first().isVisible().catch(() => false);
}

async function waitForAuthenticatedState(page: Page, cfg: AppConfig): Promise<void> {
  const startedAt = Date.now();
  const pollingMs = 100;
  const stableWindowMs = 500;
  let successSince: number | null = null;
  let lastAuthError: string | null = null;

  while (Date.now() - startedAt < cfg.timeoutMs) {
    if (cfg.selectors.success) {
      const successVisible = await page.locator(cfg.selectors.success).first().isVisible().catch(() => false);
      if (successVisible) {
        if (successSince == null) {
          successSince = Date.now();
        }
      } else if (successSince != null) {
        successSince = null;
      }
    }

    const loginFormVisible = await hasLoginForm(page, cfg);
    const authenticatedShellVisible = await hasAuthenticatedShell(page);
    const authenticatedSignal = (!isLoginPath(page) || authenticatedShellVisible) && !loginFormVisible;
    if (authenticatedSignal) {
      if (successSince == null) {
        successSince = Date.now();
      }
    } else if (successSince != null) {
      successSince = null;
    }

    if (successSince != null && Date.now() - successSince >= stableWindowMs) {
      return;
    }

    const authError = await readVisibleAuthError(page, cfg);
    if (authError) {
      lastAuthError = authError;
    }

    await page.waitForTimeout(pollingMs);
  }

  if (lastAuthError) {
    throw new Error(lastAuthError);
  }

  const authError = await readVisibleAuthError(page, cfg);
  if (authError) {
    const loginFormVisible = await hasLoginForm(page, cfg);
    const authenticatedShellVisible = await hasAuthenticatedShell(page);
    if (loginFormVisible && !authenticatedShellVisible) {
      throw new Error(authError);
    }
  }

  if (await hasLoginForm(page, cfg)) {
    throw new Error('Authentication did not complete: login form is still visible');
  }

  throw new Error('Authentication did not complete before timeout');
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

  const loginFormVisible = await hasLoginForm(page, cfg);
  const authenticatedShellVisible = await hasAuthenticatedShell(page);
  if ((!isLoginPath(page) || authenticatedShellVisible) && !loginFormVisible) {
    logger.info('Session already authenticated, skipping login');
    return;
  }

  const usernameControl = await firstVisibleControl(page, cfg.selectors.username, cfg.timeoutMs);
  const passwordControl = await firstVisibleControl(page, cfg.selectors.password, cfg.timeoutMs);
  const submitControl = await firstVisibleControl(page, cfg.selectors.submit, cfg.timeoutMs);

  if (!usernameControl || !passwordControl || !submitControl) {
    throw new Error('Could not locate login form selectors. Override selector env vars.');
  }

  logger.info(
    {
      usernameSelector: usernameControl.selector,
      passwordSelector: passwordControl.selector,
      submitSelector: submitControl.selector
    },
    'Logging in'
  );

  await usernameControl.locator.fill(credentials.username, { timeout: cfg.timeoutMs });
  await passwordControl.locator.fill(credentials.password, { timeout: cfg.timeoutMs });
  await page.waitForTimeout(cfg.loginSubmitDelayMs ?? LOGIN_SUBMIT_DELAY_MS);

  await Promise.all([
    waitForAuthenticatedState(page, cfg),
    (async () => {
      try {
        await submitControl.locator.click({ timeout: cfg.timeoutMs });
      } catch {
        await passwordControl.locator.press('Enter', { timeout: cfg.timeoutMs });
      }
    })()
  ]);

  if (cfg.postLoginWarmupPath && (await hasAuthenticatedShell(page))) {
    await page.goto(cfg.postLoginWarmupPath, { waitUntil: 'domcontentloaded', timeout: cfg.timeoutMs }).catch(() => undefined);
  }

  if (persistSession) {
    await fs.mkdir(cfg.artifactsDir, { recursive: true });
    await context.storageState({ path: storageStatePath });
    logger.info({ storageStatePath }, 'Login successful and session persisted');
  } else {
    logger.info('Login successful');
  }
}
