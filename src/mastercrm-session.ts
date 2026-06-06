import { createHmac, timingSafeEqual } from 'node:crypto';
import type { MastercrmUserRecord } from './mastercrm-user-store';

const TOKEN_VERSION = 1;
const TOKEN_AUDIENCE = 'mastercrm';
export const MASTERCRM_SESSION_TTL_SECONDS = 8 * 60 * 60;

export interface MastercrmSessionClaims {
  version: number;
  audience: string;
  userId: number;
  username: string;
  issuedAt: number;
  expiresAt: number;
}

export class MastercrmSessionError extends Error {
  constructor(
    public readonly code: 'CONFIGURATION' | 'INVALID_TOKEN',
    message: string
  ) {
    super(message);
    this.name = 'MastercrmSessionError';
  }
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function signPayload(encodedPayload: string, secret: string): string {
  return createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

function parseClaims(encodedPayload: string): MastercrmSessionClaims {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    throw new MastercrmSessionError('INVALID_TOKEN', 'Invalid MasterCRM session token');
  }

  if (!value || typeof value !== 'object') {
    throw new MastercrmSessionError('INVALID_TOKEN', 'Invalid MasterCRM session token');
  }

  const claims = value as Partial<MastercrmSessionClaims>;
  if (
    claims.version !== TOKEN_VERSION ||
    claims.audience !== TOKEN_AUDIENCE ||
    !Number.isInteger(claims.userId) ||
    Number(claims.userId) < 1 ||
    typeof claims.username !== 'string' ||
    !claims.username ||
    !Number.isInteger(claims.issuedAt) ||
    !Number.isInteger(claims.expiresAt)
  ) {
    throw new MastercrmSessionError('INVALID_TOKEN', 'Invalid MasterCRM session token');
  }

  return claims as MastercrmSessionClaims;
}

export function resolveMastercrmSessionSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.MASTERCRM_SESSION_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new MastercrmSessionError(
      'CONFIGURATION',
      'Set MASTERCRM_SESSION_SECRET to at least 32 characters'
    );
  }

  return secret;
}

export function issueMastercrmSessionToken(
  user: MastercrmUserRecord,
  secret: string,
  options: { now?: Date; ttlSeconds?: number } = {}
): { token: string; expiresIn: number } {
  const issuedAt = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const expiresIn = options.ttlSeconds ?? MASTERCRM_SESSION_TTL_SECONDS;
  const claims: MastercrmSessionClaims = {
    version: TOKEN_VERSION,
    audience: TOKEN_AUDIENCE,
    userId: user.id,
    username: user.username,
    issuedAt,
    expiresAt: issuedAt + expiresIn
  };
  const encodedPayload = encodeJson(claims);
  const signature = signPayload(encodedPayload, secret);

  return {
    token: `${encodedPayload}.${signature}`,
    expiresIn
  };
}

export function verifyMastercrmSessionToken(
  token: string,
  secret: string,
  options: { now?: Date } = {}
): MastercrmSessionClaims {
  const [encodedPayload, signature, extra] = token.split('.');
  if (!encodedPayload || !signature || extra) {
    throw new MastercrmSessionError('INVALID_TOKEN', 'Invalid MasterCRM session token');
  }

  const expectedSignature = signPayload(encodedPayload, secret);
  const actualBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new MastercrmSessionError('INVALID_TOKEN', 'Invalid MasterCRM session token');
  }

  const claims = parseClaims(encodedPayload);
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (claims.expiresAt <= now || claims.issuedAt > now + 60) {
    throw new MastercrmSessionError('INVALID_TOKEN', 'Expired or invalid MasterCRM session token');
  }

  return claims;
}

export function readBearerToken(authorization: string | string[] | undefined): string | null {
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  if (!value) {
    return null;
  }

  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(value.trim());
  return match?.[1] ?? null;
}

export function secretsEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
