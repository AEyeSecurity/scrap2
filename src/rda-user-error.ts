function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function formatRdaUserNotFoundMessage(usuario: string): string {
  return `No se ha encontrado el usuario ${usuario}`;
}

export function formatRdaUnavailableMessage(): string {
  return 'RdA no disponible temporalmente';
}

export function isRdaUnavailableErrorMessage(message: string): boolean {
  return (
    /\bRDA_UNAVAILABLE\b/i.test(message) ||
    /cloudflare/i.test(message) ||
    /bad gateway/i.test(message) ||
    /error code\s*502/i.test(message) ||
    /\bHTTP\s+50[0-9]\b/i.test(message) ||
    /Remote login returned an unavailable page/i.test(message) ||
    /Could not locate login form selectors/i.test(message) ||
    /Authentication did not complete before timeout/i.test(message)
  );
}

function matchQuotedUsername(message: string, pattern: RegExp): string | null {
  const match = message.match(pattern);
  return match?.[1]?.trim() || null;
}

export function extractRdaUsernameFromError(message: string): string | null {
  return (
    matchQuotedUsername(message, /No actionable rows found while searching for user "([^"]+)"/i) ||
    matchQuotedUsername(message, /Could not find an exact unique match for user "([^"]+)"/i) ||
    matchQuotedUsername(message, /Multiple exact matches found for user "([^"]+)"/i) ||
    matchQuotedUsername(message, /Multiple compact matches found for user "([^"]+)"/i) ||
    matchQuotedUsername(message, /User "([^"]+)" not found in users list after creation/i) ||
    null
  );
}

export function isRdaUserNotFoundError(message: string): boolean {
  return (
    /No actionable rows found while searching for user "/i.test(message) ||
    /Could not find an exact unique match for user "/i.test(message)
  );
}

export function isRdaAmbiguousUserError(message: string): boolean {
  return /Multiple exact matches found for user "/i.test(message) || /Multiple compact matches found for user "/i.test(message);
}

export function translateRdaJobError(
  message: string,
  context: {
    usuario?: string;
    operacion?: string;
    requestedUsername?: string;
  } = {}
): string {
  const usuario = context.usuario ?? extractRdaUsernameFromError(message) ?? undefined;

  if (isRdaUnavailableErrorMessage(message)) {
    return formatRdaUnavailableMessage();
  }

  if (isRdaUserNotFoundError(message) && usuario) {
    return formatRdaUserNotFoundMessage(usuario);
  }

  if (isRdaAmbiguousUserError(message) && usuario) {
    return `Se encontraron multiples coincidencias para el usuario ${usuario}`;
  }

  if (/No clear success signal detected after (.+) submit/i.test(message)) {
    const operation = context.operacion ?? message.match(/after (.+) submit/i)?.[1]?.trim() ?? 'la operacion';
    const usuarioSuffix = usuario ? ` para el usuario ${usuario}` : '';
    return `No se pudo confirmar la operacion ${operation}${usuarioSuffix}`;
  }

  if (/Could not create user "([^"]+)". Tried candidates: (.+)/i.test(message)) {
    const requestedUsername = context.requestedUsername ?? message.match(/Could not create user "([^"]+)"/i)?.[1]?.trim();
    const triedCandidates = message.match(/Tried candidates: (.+)/i)?.[1]?.trim();
    if (requestedUsername && triedCandidates) {
      return `No se pudo crear el usuario ${requestedUsername}. Usernames probados: ${triedCandidates}`;
    }
  }

  return message;
}

export function isRdaUserNotFoundMessage(message: string, usuario: string): boolean {
  return message === formatRdaUserNotFoundMessage(usuario) || new RegExp(`^${escapeRegex(formatRdaUserNotFoundMessage(usuario))}$`).test(message);
}
