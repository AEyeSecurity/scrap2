import type { Page } from 'playwright';
import type { Logger } from 'pino';
import { formatAsnUserNotFoundMessage } from './asn-user-error';
import { ensureAuthenticated } from './auth';
import { configureContext, launchChromiumBrowser } from './browser';
import { resolveSiteAppConfig } from './site-profile';
import type { AppConfig } from './types';

type AsnUserCheckErrorCode = 'NOT_FOUND' | 'INTERNAL';

const ASN_USER_NOT_FOUND_REGEX = /usuario no existe|jugador no existe|no existe el usuario|no existe el jugador|sin resultados/i;

export interface AssertAsnUserExistsInput {
  usuario: string;
  agente: string;
  contrasenaAgente: string;
  appConfig: AppConfig;
  logger: Logger;
}

export class AsnUserCheckError extends Error {
  constructor(
    public readonly code: AsnUserCheckErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'AsnUserCheckError';
  }
}

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractVisibleJugadorUsername(text: string): string | null {
  const match = text.match(/jugador\s*:\s*([a-z0-9][a-z0-9._-]{0,63})/i);
  return match?.[1] ? normalizeUsername(match[1]) : null;
}

async function userExistsInAsnPage(page: Page, usuario: string, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  const expected = normalizeUsername(usuario);
  const expectedLineRegex = new RegExp(`\\bjugador\\s*:\\s*${escapeRegex(expected)}\\b`, 'i');

  while (Date.now() - startedAt < timeoutMs) {
    const bodyText = normalizeSpaces(await page.locator('body').innerText().catch(() => ''));
    if (!bodyText) {
      await page.waitForTimeout(120);
      continue;
    }

    if (ASN_USER_NOT_FOUND_REGEX.test(bodyText)) {
      return false;
    }

    if (expectedLineRegex.test(bodyText)) {
      return true;
    }

    const extracted = extractVisibleJugadorUsername(bodyText);
    if (extracted) {
      return extracted === expected;
    }

    await page.waitForTimeout(120);
  }

  return false;
}

export async function assertAsnUserExists(input: AssertAsnUserExistsInput): Promise<void> {
  const asnConfig = resolveSiteAppConfig(input.appConfig, 'ASN');
  const runtimeConfig: AppConfig = {
    ...asnConfig,
    headless: true,
    debug: false,
    slowMo: 0,
    timeoutMs: Math.min(Math.max(asnConfig.timeoutMs, 8_000), 20_000),
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

    const userPath = `/NewAdmin/JugadoresCD.php?usr=${encodeURIComponent(input.usuario)}`;
    await page.goto(userPath, { waitUntil: 'domcontentloaded', timeout: runtimeConfig.timeoutMs });
    const exists = await userExistsInAsnPage(page, input.usuario, Math.min(runtimeConfig.timeoutMs, 8_000));

    if (!exists) {
      throw new AsnUserCheckError('NOT_FOUND', formatAsnUserNotFoundMessage(input.usuario));
    }
  } catch (error) {
    if (error instanceof AsnUserCheckError) {
      throw error;
    }

    throw new AsnUserCheckError('INTERNAL', 'Could not verify ASN user existence', { cause: error as Error });
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}
