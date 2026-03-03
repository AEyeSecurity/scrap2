import { describe, expect, it } from 'vitest';
import {
  PlayerPhoneStoreError,
  mapDatabaseError,
  normalizePhone,
  normalizeUsername,
  toHttpError
} from '../src/player-phone-store';

describe('player-phone-store helpers', () => {
  it('normalizes usernames as case-insensitive keys', () => {
    expect(normalizeUsername('  AgEnTe_01  ', 'agente')).toBe('agente_01');
  });

  it('normalizes phone values and converts 00 prefix to +', () => {
    expect(normalizePhone('00 54 (11) 2233-4455')).toBe('+541122334455');
  });

  it('rejects invalid phone values that are not strict E.164', () => {
    expect(() => normalizePhone('abc123')).toThrow(/E.164/i);
  });

  it('maps database unique violations to conflict errors', () => {
    const error = mapDatabaseError({ code: '23505', message: 'duplicate key' }, 'conflict');
    expect(error).toBeInstanceOf(PlayerPhoneStoreError);
    expect(error.code).toBe('CONFLICT');
  });

  it('maps database check violations to validation errors', () => {
    const error = mapDatabaseError({ code: '23514', message: 'check violation' }, 'invalid');
    expect(error.code).toBe('VALIDATION');
  });

  it('maps store errors to HTTP responses', () => {
    const conflictResponse = toHttpError(new PlayerPhoneStoreError('CONFLICT', 'duplicated'));
    expect(conflictResponse).toEqual({ statusCode: 409, message: 'duplicated' });
  });
});
