import type { Locator, Page } from 'playwright';

const CONTINUE_SELECTORS = [
  'button:has-text("Continuar")',
  'a:has-text("Continuar")',
  'input[type="button"][value*="Continuar" i]',
  'input[type="submit"][value*="Continuar" i]',
  'input[type="image"][alt*="Continuar" i]',
  'input[type="image"][title*="Continuar" i]',
  'button:has-text("Continue")',
  'a:has-text("Continue")'
];

const AUTHENTICATED_SHELL_SELECTORS = [
  'text=/Bienvenido/i',
  'text=/Administraci[oó]n/i',
  'text=/Usuarios|Mis estad[ií]sticas|Reportes financieros|Informes de jugadores|Finanzas/i',
  'a:has-text("Jugadores")',
  'a:has-text("Usuarios")'
];

const MIN_PROBE_WINDOW_MS = 1_200;
const AUTHENTICATED_STABLE_WINDOW_MS = 200;
const POLL_WHEN_SETTLED_MS = 40;
const POLL_WHEN_PENDING_MS = 90;

async function clickLocator(locator: Locator, timeoutMs: number): Promise<void> {
  await locator.scrollIntoViewIfNeeded({ timeout: timeoutMs }).catch(() => undefined);
  try {
    await locator.click({ timeout: timeoutMs });
  } catch {
    await locator.click({ timeout: timeoutMs, force: true });
  }
}

function isLikelyAuthenticatedAsnPath(page: Page): boolean {
  try {
    const pathname = new URL(page.url()).pathname.toLowerCase();
    return pathname.includes('/newadmin/') && !pathname.includes('login');
  } catch {
    return false;
  }
}

async function hasVisibleSelector(page: Page, selectors: string[]): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      if (await locator.nth(i).isVisible().catch(() => false)) {
        return true;
      }
    }
  }

  return false;
}

async function findFirstVisibleCandidate(page: Page, selectors: string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const candidate = locator.nth(i);
      if (await candidate.isVisible().catch(() => false)) {
        return candidate;
      }
    }
  }

  return null;
}

async function hasAsnAuthenticatedShell(page: Page): Promise<boolean> {
  if (isLikelyAuthenticatedAsnPath(page)) {
    return true;
  }

  return hasVisibleSelector(page, AUTHENTICATED_SHELL_SELECTORS);
}

export async function handleAsnPostLoginContinue(page: Page, timeoutMs: number): Promise<'ok' | 'skipped'> {
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(timeoutMs, MIN_PROBE_WINDOW_MS);
  const clickTimeoutMs = Math.max(500, Math.min(timeoutMs, 1_200));
  let attemptedClick = false;
  let authenticatedSince: number | null = null;

  while (Date.now() < deadline) {
    const authenticated = await hasAsnAuthenticatedShell(page);
    if (authenticated) {
      authenticatedSince ??= Date.now();
    } else {
      authenticatedSince = null;
    }

    const candidate = await findFirstVisibleCandidate(page, CONTINUE_SELECTORS);
    if (!candidate) {
      if (
        authenticatedSince != null &&
        Date.now() - authenticatedSince >= AUTHENTICATED_STABLE_WINDOW_MS
      ) {
        return attemptedClick ? 'ok' : 'skipped';
      }

      await page.waitForTimeout(authenticated ? POLL_WHEN_SETTLED_MS : POLL_WHEN_PENDING_MS);
      continue;
    }

    attemptedClick = true;
    try {
      await clickLocator(candidate, clickTimeoutMs);
      await page.waitForLoadState('domcontentloaded', { timeout: clickTimeoutMs }).catch(() => undefined);
      authenticatedSince = null;
    } catch {
      if (await hasAsnAuthenticatedShell(page)) {
        return 'ok';
      }
    }

    if (await hasAsnAuthenticatedShell(page)) {
      return 'ok';
    }

    await page.waitForTimeout(POLL_WHEN_PENDING_MS);
  }

  return (await hasAsnAuthenticatedShell(page)) || attemptedClick ? 'ok' : 'skipped';
}
