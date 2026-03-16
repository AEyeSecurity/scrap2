import type { Page } from 'playwright';
import type { Logger } from 'pino';
import { formatAsnUserNotFoundMessage } from './asn-user-error';
import { ensureAuthenticated } from './auth';
import { configureContext, launchChromiumBrowser } from './browser';
import { resolveSiteAppConfig } from './site-profile';
import type { AppConfig } from './types';

type AsnUserCheckErrorCode = 'NOT_FOUND' | 'INTERNAL';
type AsnUserProbeStatus = 'FOUND' | 'NOT_FOUND' | 'UNKNOWN';

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
  return (await probeAsnUserInPage(page, usuario, timeoutMs)) === 'FOUND';
}

function isNavigationAbortLike(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ERR_ABORTED|interrupted by another navigation/i.test(message);
}

async function gotoWithSoftAbortHandling(page: Page, path: string, timeoutMs: number): Promise<void> {
  try {
    await page.goto(path, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    return;
  } catch (error) {
    if (!isNavigationAbortLike(error)) {
      throw error;
    }

    await page.waitForLoadState('domcontentloaded', { timeout: Math.min(timeoutMs, 2_000) }).catch(() => undefined);
  }
}

async function probeAsnUserInPage(page: Page, usuario: string, timeoutMs: number): Promise<AsnUserProbeStatus> {
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
      return 'NOT_FOUND';
    }

    if (expectedLineRegex.test(bodyText)) {
      return 'FOUND';
    }

    const extracted = extractVisibleJugadorUsername(bodyText);
    if (extracted) {
      return extracted === expected ? 'FOUND' : 'NOT_FOUND';
    }

    await page.waitForTimeout(120);
  }

  return 'UNKNOWN';
}

async function probeAsnUserExists(page: Page, usuario: string, timeoutMs: number): Promise<AsnUserProbeStatus> {
  const encodedUsuario = encodeURIComponent(usuario);
  const paths = [
    `/NewAdmin/JugadoresCD.php?usr=${encodedUsuario}`,
    `/NewAdmin/Jugadores.php?usr=${encodedUsuario}`
  ];

  let sawNotFound = false;

  for (const path of paths) {
    try {
      await gotoWithSoftAbortHandling(page, path, timeoutMs);
      const probe = await probeAsnUserInPage(page, usuario, Math.min(timeoutMs, 5_000));
      if (probe === 'FOUND') {
        return 'FOUND';
      }
      if (probe === 'NOT_FOUND') {
        sawNotFound = true;
      }
    } catch {
      // Probe the alternate user page before escalating to INTERNAL.
    }
  }

  return sawNotFound ? 'NOT_FOUND' : 'UNKNOWN';
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

    const probe = await probeAsnUserExists(page, input.usuario, Math.min(runtimeConfig.timeoutMs, 8_000));

    if (probe === 'NOT_FOUND') {
      throw new AsnUserCheckError('NOT_FOUND', formatAsnUserNotFoundMessage(input.usuario));
    }
    if (probe !== 'FOUND') {
      throw new AsnUserCheckError('INTERNAL', 'Could not verify ASN user existence');
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
