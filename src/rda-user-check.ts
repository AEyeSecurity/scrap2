import type { Logger } from 'pino';
import { ensureAuthenticated } from './auth';
import { configureContext, launchChromiumBrowser } from './browser';
import { RdaUserApiError, resolveRdaUserByApi } from './rda-user-api';
import { formatRdaUnavailableMessage, formatRdaUserNotFoundMessage } from './rda-user-error';
import { resolveSiteAppConfig } from './site-profile';
import type { AppConfig } from './types';

type RdaUserCheckErrorCode = 'NOT_FOUND' | 'AMBIGUOUS' | 'UNAVAILABLE' | 'INTERNAL';

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

export async function assertRdaUserExists(input: AssertRdaUserExistsInput): Promise<void> {
  const rdaConfig = resolveSiteAppConfig(input.appConfig, 'RdA');
  const runtimeConfig: AppConfig = {
    ...rdaConfig,
    headless: true,
    debug: false,
    slowMo: 0,
    timeoutMs: Math.min(Math.max(rdaConfig.timeoutMs, 8_000), 20_000),
    blockResources: true,
    postLoginWarmupPath: undefined
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

    await resolveRdaUserByApi(page, input.usuario, runtimeConfig.timeoutMs);
  } catch (error) {
    if (error instanceof RdaUserCheckError) {
      throw error;
    }
    if (error instanceof RdaUserApiError) {
      if (error.code === 'NOT_FOUND') {
        throw new RdaUserCheckError('NOT_FOUND', formatRdaUserNotFoundMessage(input.usuario), { cause: error });
      }
      if (error.code === 'AMBIGUOUS') {
        throw new RdaUserCheckError('AMBIGUOUS', `Se encontraron multiples coincidencias para el usuario ${input.usuario}`, {
          cause: error
        });
      }
      if (error.code === 'UNAVAILABLE') {
        throw new RdaUserCheckError('UNAVAILABLE', formatRdaUnavailableMessage(), { cause: error });
      }
    }

    throw new RdaUserCheckError('INTERNAL', 'Could not verify RdA user existence', { cause: error as Error });
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}
