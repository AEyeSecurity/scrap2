import { z } from 'zod';
import type { AppConfig, PaginaCode } from './types';

export function normalizePaginaCode(value: string): PaginaCode | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'rda') {
    return 'RdA';
  }
  if (normalized === 'asn') {
    return 'ASN';
  }
  return null;
}

export const paginaCodeSchema = z.string().trim().min(1).transform((value, ctx): PaginaCode => {
  const normalized = normalizePaginaCode(value);
  if (!normalized) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'pagina must be one of: RdA, ASN'
    });
    return z.NEVER;
  }

  return normalized;
});

export function resolveSiteAppConfig(appConfig: AppConfig, pagina: PaginaCode): AppConfig {
  if (pagina === 'RdA') {
    return appConfig;
  }

  return {
    ...appConfig,
    baseUrl: 'https://losasesdelnorte.com',
    loginPath: '/NewAdmin/login.php',
    postLoginWarmupPath: undefined,
    loginSubmitDelayMs: 250,
    selectors: {
      username: [
        'input[name="nombreusuario"]',
        'input[name="usuario"]',
        'input[name*="user" i]',
        'input[type="text"]'
      ],
      password: [
        'input[name="contrasenia"]',
        'input[name="clave"]',
        'input[name="password"]',
        'input[type="password"]'
      ],
      submit: [
        'input[type="image"]',
        'button[type="submit"]',
        'input[type="submit"]',
        'button:has-text("Ingresar")',
        'button:has-text("Entrar")',
        'button:has-text("Login")',
        'input[type="button"][value*="Ingres" i]',
        'input[type="submit"][value*="Ingres" i]'
      ],
      success: 'text=/Bienvenido/i',
      error: 'text=/error|incorrect|invalido|invÃ¡lido|credenciales|no autorizado/i'
    }
  };
}


