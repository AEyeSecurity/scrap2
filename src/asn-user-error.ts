export function formatAsnUserNotFoundMessage(usuario: string): string {
  return `No se ha encontrado el usuario ${usuario}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isAsnUserNotFoundError(usuario: string, error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  const escapedUsuario = escapeRegex(usuario.trim());
  const errorName =
    typeof error === 'object' && error != null && 'name' in error && typeof error.name === 'string' ? error.name : null;
  const errorCode =
    typeof error === 'object' && error != null && 'code' in error && typeof error.code === 'string' ? error.code : null;

  const directPatterns = [
    /\bel usuario no existe\b/i,
    /\bno se ha encontrado el usuario\b/i,
    /\busuario no existe\b/i,
    /\bjugador no existe\b/i,
    /\bno existe el usuario\b/i,
    /\bno existe el jugador\b/i,
    /\bsin resultados\b/i,
    /\bno se encontraron\b/i,
    /\bsin coincidencias\b/i,
    /\bningun resultado\b/i,
    /\busers table did not refresh after applying filter\b/i,
    /\bcould not find a unique row for user\b/i,
    /\bis not visible in .*target panel\b/i
  ];

  if (errorName === 'AsnUserCheckError' && errorCode === 'NOT_FOUND') {
    return true;
  }

  if (directPatterns.some((pattern) => pattern.test(message))) {
    return true;
  }

  if (
    /\bstep failed:\s*(02-goto-user-cd|04-find-user-row)\b/i.test(message) &&
    (/no visible element found for selector:/i.test(message) ||
      /\bsin resultados\b/i.test(message) ||
      /\bno se encontraron\b/i.test(message) ||
      /\bsin coincidencias\b/i.test(message) ||
      /\busers table did not refresh after applying filter\b/i.test(message) ||
      /\bcould not find a unique row for user\b/i.test(message))
  ) {
    return true;
  }

  if (
    /no visible element found for selector:/i.test(message) &&
    /saldo\s+disponible\s+actual|cargar\s+saldo|descargar\s+saldo|importe\s*:|cargar/i.test(normalized)
  ) {
    return true;
  }

  if (new RegExp(`user\\s+"${escapedUsuario}"\\s+is\\s+not\\s+visible\\s+in`, 'i').test(message)) {
    return true;
  }

  if (new RegExp(`could\\s+not\\s+find\\s+a\\s+unique\\s+row\\s+for\\s+user\\s+"${escapedUsuario}"`, 'i').test(message)) {
    return true;
  }

  return false;
}

export function toFriendlyAsnUserError(usuario: string, error: unknown): Error | null {
  if (!isAsnUserNotFoundError(usuario, error)) {
    return null;
  }

  return new Error(formatAsnUserNotFoundMessage(usuario), {
    cause: error instanceof Error ? error : undefined
  });
}
