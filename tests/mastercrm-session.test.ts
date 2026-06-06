import { describe, expect, it } from 'vitest';
import {
  issueMastercrmSessionToken,
  readBearerToken,
  resolveMastercrmSessionSecret,
  secretsEqual,
  verifyMastercrmSessionToken
} from '../src/mastercrm-session';

const secret = 'test-mastercrm-session-secret-32-chars';
const user = {
  id: 101,
  username: 'juan',
  nombre: 'Juan',
  telefono: null,
  inversion: 0,
  isActive: true,
  createdAt: '2026-06-06T00:00:00.000Z'
};

describe('MasterCRM sessions', () => {
  it('issues and verifies a signed token', () => {
    const now = new Date('2026-06-06T12:00:00.000Z');
    const issued = issueMastercrmSessionToken(user, secret, { now, ttlSeconds: 3600 });

    expect(verifyMastercrmSessionToken(issued.token, secret, { now })).toMatchObject({
      userId: 101,
      username: 'juan'
    });
    expect(issued.expiresIn).toBe(3600);
  });

  it('rejects tampered and expired tokens', () => {
    const now = new Date('2026-06-06T12:00:00.000Z');
    const issued = issueMastercrmSessionToken(user, secret, { now, ttlSeconds: 60 });

    expect(() => verifyMastercrmSessionToken(`${issued.token}x`, secret, { now })).toThrow();
    expect(() =>
      verifyMastercrmSessionToken(issued.token, secret, {
        now: new Date('2026-06-06T12:01:01.000Z')
      })
    ).toThrow();
  });

  it('parses bearer tokens and compares secrets safely', () => {
    const issued = issueMastercrmSessionToken(user, secret);
    expect(readBearerToken(`Bearer ${issued.token}`)).toBe(issued.token);
    expect(readBearerToken('Basic abc')).toBeNull();
    expect(secretsEqual('staff-secret', 'staff-secret')).toBe(true);
    expect(secretsEqual('staff-secret', 'wrong')).toBe(false);
  });

  it('requires a sufficiently long session secret', () => {
    expect(() => resolveMastercrmSessionSecret({ MASTERCRM_SESSION_SECRET: 'short' })).toThrow();
    expect(
      resolveMastercrmSessionSecret({ MASTERCRM_SESSION_SECRET: secret })
    ).toBe(secret);
  });
});
