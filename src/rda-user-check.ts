import type { Locator, Page } from 'playwright';
import type { Logger } from 'pino';
import { ensureAuthenticated } from './auth';
import { configureContext, launchChromiumBrowser } from './browser';
import {
  hasCompactUsernameMatch,
  hasExactUsernameMatch,
  normalizeDepositText,
  selectDepositRowIndex,
  type DepositRowCandidate
} from './deposit-match';
import { formatRdaUserNotFoundMessage } from './rda-user-error';
import { resolveSiteAppConfig } from './site-profile';
import type { AppConfig } from './types';

type RdaUserCheckErrorCode = 'NOT_FOUND' | 'AMBIGUOUS' | 'INTERNAL';

const USERS_FILTER_INPUT_SELECTOR = 'input[placeholder*="Jugador/Agente" i]';
const USERS_ROW_SELECTOR = '.users-table-item';
const USERS_USERNAME_SELECTOR = '.role-bar__user-block11, .ellipsis-text, .role-bar__user-block1, .users-table-item__user-info';
const USERS_APPLY_FILTER_SELECTOR =
  'button:has-text("Aceptar filtro"), button:has-text("Aplicar"), button:has-text("Filtrar"), button:has-text("Buscar")';
const USERS_DEPOSIT_ACTION_SELECTOR = 'a[href*="/users/deposit/"], a.button-desktop, button, [role="button"]';
const DEPOSIT_ACTION_TEXT_REGEX = /dep[o\u00f3]sito/i;

export interface AssertRdaUserExistsInput {
  usuario: string;
  agente: string;
  contrasenaAgente: string;
  appConfig: AppConfig;
  logger: Logger;
}

export class RdaUserCheckError extends Error {
  constructor(
    public readonly code: RdaUserCheckErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'RdaUserCheckError';
  }
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

async function findUsersFilterInput(page: Page, timeoutMs: number): Promise<Locator> {
  try {
    return await findFirstVisibleLocator(page, USERS_FILTER_INPUT_SELECTOR, timeoutMs);
  } catch {
    return findFirstVisibleLocator(
      page,
      'xpath=//*[contains(translate(normalize-space(.), "JUGADOR/AGENTE", "jugador/agente"), "jugador/agente")]/following::input[1]',
      timeoutMs
    );
  }
}

async function clickLocator(locator: Locator, timeoutMs: number): Promise<void> {
  await locator.scrollIntoViewIfNeeded({ timeout: timeoutMs }).catch(() => undefined);
  try {
    await locator.click({ timeout: timeoutMs });
  } catch {
    await locator.click({ timeout: timeoutMs, force: true });
  }
}

async function countVisibleInLocator(locator: Locator): Promise<number> {
  const count = await locator.count();
  let visible = 0;
  for (let i = 0; i < count; i += 1) {
    if (await locator.nth(i).isVisible().catch(() => false)) {
      visible += 1;
    }
  }
  return visible;
}

function getDepositActions(scope: { locator: (selector: string) => Locator }): Locator {
  return scope.locator(USERS_DEPOSIT_ACTION_SELECTOR).filter({ hasText: DEPOSIT_ACTION_TEXT_REGEX });
}

async function collectRowCandidates(page: Page): Promise<DepositRowCandidate[]> {
  const rows = page.locator(USERS_ROW_SELECTOR);
  const count = await rows.count();
  const candidates: DepositRowCandidate[] = [];

  for (let i = 0; i < count; i += 1) {
    const row = rows.nth(i);
    if (!(await row.isVisible().catch(() => false))) {
      continue;
    }

    const usernamesRaw = await row.locator(USERS_USERNAME_SELECTOR).allInnerTexts().catch(() => []);
    const usernames = usernamesRaw.map((value) => value.trim()).filter(Boolean);
    const rowTextRaw = await row.innerText().catch(() => '');
    const hasAction = (await countVisibleInLocator(getDepositActions(row))) > 0;

    candidates.push({
      index: i,
      hasAction,
      usernames,
      normalizedText: normalizeDepositText(rowTextRaw)
    });
  }

  return candidates;
}

async function countUniqueVisibleDepositAction(page: Page): Promise<number> {
  return countVisibleInLocator(getDepositActions(page));
}

function candidatesContainUsername(candidates: DepositRowCandidate[], username: string): boolean {
  return candidates.some(
    (candidate) =>
      candidate.usernames.some((value) => hasExactUsernameMatch(value, username) || hasCompactUsernameMatch(value, username)) ||
      hasExactUsernameMatch(candidate.normalizedText, username) ||
      hasCompactUsernameMatch(candidate.normalizedText, username)
  );
}

async function waitForRdaUserMatch(page: Page, username: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  let lastError = formatRdaUserNotFoundMessage(username);

  while (Date.now() - startedAt < timeoutMs) {
    const candidates = await collectRowCandidates(page);
    try {
      selectDepositRowIndex(candidates, username);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (/Multiple exact matches|Multiple compact matches/i.test(lastError)) {
        throw new RdaUserCheckError('AMBIGUOUS', `Se encontraron multiples coincidencias para el usuario ${username}`);
      }
    }

    const uniqueVisibleActionCount = await countUniqueVisibleDepositAction(page);
    if (uniqueVisibleActionCount === 1 && candidates.length <= 1) {
      return;
    }
    if (uniqueVisibleActionCount > 1 && candidatesContainUsername(candidates, username)) {
      throw new RdaUserCheckError('AMBIGUOUS', `Se encontraron multiples coincidencias para el usuario ${username}`);
    }

    await page.waitForTimeout(120);
  }

  throw new RdaUserCheckError('NOT_FOUND', formatRdaUserNotFoundMessage(username), { cause: new Error(lastError) });
}

export async function assertRdaUserExists(input: AssertRdaUserExistsInput): Promise<void> {
  const rdaConfig = resolveSiteAppConfig(input.appConfig, 'RdA');
  const runtimeConfig: AppConfig = {
    ...rdaConfig,
    headless: true,
    debug: false,
    slowMo: 0,
    timeoutMs: Math.min(Math.max(rdaConfig.timeoutMs, 8_000), 20_000),
    blockResources: true
  };

  const browser = await launchChromiumBrowser(runtimeConfig, input.logger);
  const context = await browser.newContext({
    baseURL: runtimeConfig.baseUrl,
    viewport: { width: 1920, height: 1080 }
  });

  try {
    await configureContext(context, runtimeConfig, input.logger);
    const page = await context.newPage();
    await ensureAuthenticated(
      context,
      page,
      runtimeConfig,
      {
        username: input.agente,
        password: input.contrasenaAgente
      },
      input.logger,
      { persistSession: false }
    );

    await page.goto('/users/all', { waitUntil: 'domcontentloaded', timeout: runtimeConfig.timeoutMs });
    const filterInput = await findUsersFilterInput(page, Math.min(runtimeConfig.timeoutMs, 10_000));
    const filterValue = input.usuario.trim().toLowerCase();
    await filterInput.fill('', { timeout: runtimeConfig.timeoutMs });
    await filterInput.fill(filterValue, { timeout: runtimeConfig.timeoutMs });

    const applyFilterButton = await findFirstVisibleLocator(
      page,
      USERS_APPLY_FILTER_SELECTOR,
      Math.min(runtimeConfig.timeoutMs, 4_000)
    ).catch(() => undefined);
    if (applyFilterButton) {
      await clickLocator(applyFilterButton, runtimeConfig.timeoutMs);
    } else {
      await filterInput.press('Enter', { timeout: runtimeConfig.timeoutMs }).catch(() => undefined);
    }

    await waitForRdaUserMatch(page, filterValue, Math.min(runtimeConfig.timeoutMs, 8_000));
  } catch (error) {
    if (error instanceof RdaUserCheckError) {
      throw error;
    }

    throw new RdaUserCheckError('INTERNAL', 'Could not verify RdA user existence', { cause: error as Error });
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}
