import type { Locator, Page } from 'playwright';

async function clickLocator(locator: Locator, timeoutMs: number): Promise<void> {
  await locator.scrollIntoViewIfNeeded({ timeout: timeoutMs }).catch(() => undefined);
  try {
    await locator.click({ timeout: timeoutMs });
  } catch {
    await locator.click({ timeout: timeoutMs, force: true });
  }
}

export async function handleAsnPostLoginContinue(page: Page, timeoutMs: number): Promise<'ok' | 'skipped'> {
  const selector = [
    'button:has-text("Continuar")',
    'a:has-text("Continuar")',
    'input[type="button"][value*="Continuar" i]',
    'input[type="submit"][value*="Continuar" i]',
    'input[type="image"][alt*="Continuar" i]',
    'input[type="image"][title*="Continuar" i]',
    'button:has-text("Continue")',
    'a:has-text("Continue")'
  ].join(', ');
  const startedAt = Date.now();
  let clickedCount = 0;
  const maxClicks = 3;
  let postClickProbeUntil = 0;

  while (Date.now() - startedAt < timeoutMs && clickedCount < maxClicks) {
    const candidates = page.locator(selector);
    const count = await candidates.count().catch(() => 0);
    let clickedInPass = false;

    for (let i = 0; i < count; i += 1) {
      const candidate = candidates.nth(i);
      if (!(await candidate.isVisible().catch(() => false))) {
        continue;
      }

      await clickLocator(candidate, timeoutMs);
      await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => undefined);
      clickedCount += 1;
      clickedInPass = true;
      postClickProbeUntil = Date.now() + 500;
      break;
    }

    if (!clickedInPass && clickedCount > 0) {
      if (Date.now() >= postClickProbeUntil) {
        return 'ok';
      }
      await page.waitForTimeout(50);
      continue;
    }

    await page.waitForTimeout(clickedCount > 0 ? 50 : 100);
  }

  return clickedCount > 0 ? 'ok' : 'skipped';
}
