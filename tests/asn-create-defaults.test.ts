import { describe, expect, it } from 'vitest';
import { buildAsnCreateDefaults } from '../src/create-player-asn';

describe('ASN create-player defaults', () => {
  it('builds stable defaults from newUsername', () => {
    const defaults = buildAsnCreateDefaults('ballenita26_test');

    expect(defaults).toEqual({
      nombre: 'Alta',
      apellido: 'Bot',
      email: 'ballenita26_test@example.com'
    });
  });
});
