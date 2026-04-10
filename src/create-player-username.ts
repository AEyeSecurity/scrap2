import type { PaginaCode } from './types';

const ASN_MAX_USERNAME_LENGTH = 12;
const DUPLICATE_USERNAME_ERROR_REGEX =
  /ya existe|already exist(?:s)?|already in use|usuario.+existe|nick.+existe|login.+existe|en uso/i;
const GENERIC_REQUEST_FAILURE_REGEX = /ejecuci[oó]n de la solicitud fall[oó]/i;
const PASSWORD_VERIFICATION_WARNING_REGEX = /password not verified/i;

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
  return DUPLICATE_USERNAME_ERROR_REGEX.test(message);
}

export function isGenericRequestFailure(message: string): boolean {
  return GENERIC_REQUEST_FAILURE_REGEX.test(message);
}

export function isPasswordVerificationWarning(message: string): boolean {
  return PASSWORD_VERIFICATION_WARNING_REGEX.test(message);
}

export interface RemoteApiErrorDetails {
  httpStatus?: number;
  apiStatus?: number;
  errorMessage?: string | null;
}

export function isDuplicateUsernameApiFailure(details: RemoteApiErrorDetails | null | undefined): boolean {
  if (!details) {
    return false;
  }

  if (typeof details.errorMessage === 'string' && isDuplicateUsernameError(details.errorMessage)) {
    return true;
  }

  return typeof details.apiStatus === 'number' && details.apiStatus === -3;
}

export function extractRemoteApiErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') {
    return null;
  }

  const candidateBody = body as {
    error_message?: unknown;
    message?: unknown;
    error?: unknown;
  };

  const candidates = [candidateBody.error_message, candidateBody.message, candidateBody.error];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue;
    }

    const normalized = candidate.trim();
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

export function buildRemoteApiErrorMessage(details: RemoteApiErrorDetails): string | null {
  const statusLabel =
    typeof details.apiStatus === 'number' && Number.isFinite(details.apiStatus)
      ? `status ${details.apiStatus}`
      : typeof details.httpStatus === 'number' && Number.isFinite(details.httpStatus)
        ? `HTTP ${details.httpStatus}`
        : null;
  const errorMessage = typeof details.errorMessage === 'string' ? details.errorMessage.trim() : '';

  if (errorMessage && statusLabel) {
    return `RdA create-player API error (${statusLabel}): ${errorMessage}`;
  }

  if (errorMessage) {
    return `RdA create-player API error: ${errorMessage}`;
  }

  if (statusLabel) {
    return `RdA create-player API error (${statusLabel})`;
  }

  return null;
}

export function buildExhaustedUsernameError(requestedUsername: string, triedCandidates: string[]): Error {
  return new Error(
    `Could not create user "${requestedUsername}". Tried candidates: ${triedCandidates.join(', ')}`
  );
}
