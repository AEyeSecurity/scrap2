import type { Logger } from 'pino';
import type { AppConfig, PaginaCode } from './types';

export interface PlatformUserValidationInput {
  usuario: string;
  agente: string;
  contrasenaAgente: string;
  appConfig: AppConfig;
  logger: Logger;
}

export type PlatformUserExistsChecker = (input: PlatformUserValidationInput) => Promise<void>;

export interface PlatformUserValidator {
  readonly pagina: PaginaCode;
  validate(input: PlatformUserValidationInput): Promise<void>;
}

export function getPlatformUserValidator(
  pagina: PaginaCode,
  checkers: Partial<Record<PaginaCode, PlatformUserExistsChecker>>
): PlatformUserValidator {
  const checker = checkers[pagina];
  if (!checker) {
    throw new Error(`missing_${pagina.toLowerCase()}_user_checker`);
  }
  return {
    pagina,
    validate: checker
  };
}
