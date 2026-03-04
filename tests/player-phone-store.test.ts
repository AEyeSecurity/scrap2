import { describe, expect, it } from 'vitest';
import {
  PlayerPhoneStoreError,
  mapAssignUsernameByPhoneRpcError,
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

  it('maps database invalid parameter errors to validation errors', () => {
    const error = mapDatabaseError({ code: '22023', message: 'invalid parameter' }, 'invalid');
    expect(error.code).toBe('VALIDATION');
  });

  it('maps store errors to HTTP responses', () => {
    const conflictResponse = toHttpError(new PlayerPhoneStoreError('CONFLICT', 'duplicated'));
    expect(conflictResponse).toEqual({ statusCode: 409, message: 'duplicated' });
  });

  it('maps assign_username_by_phone RPC not found to NOT_FOUND', () => {
    const error = mapAssignUsernameByPhoneRpcError({
      code: 'P0001',
      message: 'link not found for agente + telefono'
    } as any);
    expect(error.code).toBe('NOT_FOUND');
  });

  it('maps assign_username_by_phone RPC conflict to CONFLICT', () => {
    const error = mapAssignUsernameByPhoneRpcError({
      code: 'P0001',
      message: 'username already exists in this pagina'
    } as any);
    expect(error.code).toBe('CONFLICT');
  });

  it('maps assign_username_by_phone RPC validation errors to VALIDATION', () => {
    const error = mapAssignUsernameByPhoneRpcError({
      code: '22023',
      message: 'telefono must be strict E.164 format'
    } as any);
    expect(error.code).toBe('VALIDATION');
  });
});
