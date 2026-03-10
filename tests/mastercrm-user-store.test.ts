import { describe, expect, it } from 'vitest';
import {
  hashMastercrmPassword,
  normalizeMastercrmNombre,
  normalizeMastercrmTelefono,
  normalizeMastercrmUsername,
  toMastercrmUserRecord,
  verifyMastercrmPassword
} from '../src/mastercrm-user-store';

describe('mastercrm user store helpers', () => {
  it('normalizes username to lowercase trimmed value', () => {
    expect(normalizeMastercrmUsername('  JuAn  ')).toBe('juan');
  });

  it('normalizes nombre and telefono for storage', () => {
    expect(normalizeMastercrmNombre('  Juan Perez  ')).toBe('Juan Perez');
    expect(normalizeMastercrmTelefono('  54911  ')).toBe('54911');
    expect(normalizeMastercrmTelefono('   ')).toBeNull();
  });

  it('hashes and verifies passwords', async () => {
    const hash = await hashMastercrmPassword('secret123');

    await expect(verifyMastercrmPassword('secret123', hash)).resolves.toBe(true);
    await expect(verifyMastercrmPassword('wrong', hash)).resolves.toBe(false);
  });

  it('serializes supabase rows to frontend-safe records', () => {
    const user = toMastercrmUserRecord({
      id: '101',
      username: 'juan',
      nombre: 'Juan Perez',
      telefono: '54911',
      inversion: '150000',
      is_active: true,
      created_at: '2026-03-10T12:00:00.000Z'
    });

    expect(user).toEqual({
      id: 101,
      username: 'juan',
      nombre: 'Juan Perez',
      telefono: '54911',
      inversion: 150000,
      isActive: true,
      createdAt: '2026-03-10T12:00:00.000Z'
    });
  });
});
