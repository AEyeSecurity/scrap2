import type { PaginaCode } from './types';

const ASN_MAX_USERNAME_LENGTH = 12;

function normalizeRequestedUsername(requestedUsername: string): string {
  const normalized = requestedUsername.trim();
  return normalized.length > 0 ? normalized : requestedUsername;
}

export function buildUsernameCandidates(requestedUsername: string, pagina: PaginaCode): string[] {
  const normalizedRequested = normalizeRequestedUsername(requestedUsername);
  const normalizedBase =
    pagina === 'ASN'
      ? normalizedRequested.slice(0, ASN_MAX_USERNAME_LENGTH)
      : normalizedRequested;

  const candidates: string[] = [normalizedBase];
  for (let i = 1; i <= 9; i += 1) {
    const suffix = String(i);
    if (pagina === 'ASN') {
      const maxBaseLength = ASN_MAX_USERNAME_LENGTH - suffix.length;
      candidates.push(`${normalizedBase.slice(0, Math.max(0, maxBaseLength))}${suffix}`);
      continue;
    }

    candidates.push(`${normalizedBase}${suffix}`);
  }

  const deduplicated: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    deduplicated.push(candidate);
    seen.add(candidate);
  }

  return deduplicated;
}

export function isDuplicateUsernameError(message: string): boolean {
  return /ya existe|already exists|already in use|usuario.+existe|nick.+existe|login.+existe|en uso|ejecuci[oó]n de la solicitud fall[oó]/i.test(
    message
  );
}

export function buildExhaustedUsernameError(requestedUsername: string, triedCandidates: string[]): Error {
  return new Error(
    `Could not create user "${requestedUsername}". Tried candidates: ${triedCandidates.join(', ')}`
  );
}
