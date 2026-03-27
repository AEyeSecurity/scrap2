function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function formatRdaUserNotFoundMessage(usuario: string): string {
  return `No se ha encontrado el usuario ${usuario}`;
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
  return /Multiple exact matches found for user "/i.test(message);
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
