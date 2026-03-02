import { describe, expect, it } from 'vitest';
import {
  buildExhaustedUsernameError,
  buildUsernameCandidates,
  isDuplicateUsernameError
} from '../src/create-player-username';

describe('create-player username helpers', () => {
  it('builds RdA candidates with base + 1..9', () => {
    expect(buildUsernameCandidates('Pepito47', 'RdA')).toEqual([
      'Pepito47',
      'Pepito471',
      'Pepito472',
      'Pepito473',
      'Pepito474',
      'Pepito475',
      'Pepito476',
      'Pepito477',
      'Pepito478',
      'Pepito479'
    ]);
  });

  it('builds ASN candidates with deterministic truncation up to 12 chars', () => {
    expect(buildUsernameCandidates('Pepito47', 'ASN')).toEqual([
      'Pepito47',
      'Pepito471',
      'Pepito472',
      'Pepito473',
      'Pepito474',
      'Pepito475',
      'Pepito476',
      'Pepito477',
      'Pepito478',
      'Pepito479'
    ]);

    expect(buildUsernameCandidates('Pepito47Larguisimo', 'ASN')).toEqual([
      'Pepito47Larg',
      'Pepito47Lar1',
      'Pepito47Lar2',
      'Pepito47Lar3',
      'Pepito47Lar4',
      'Pepito47Lar5',
      'Pepito47Lar6',
      'Pepito47Lar7',
      'Pepito47Lar8',
      'Pepito47Lar9'
    ]);
  });

  it('deduplicates ASN candidates when truncation collides', () => {
    expect(buildUsernameCandidates('A', 'ASN')).toEqual(['A', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9']);
  });

  it('detects duplicate username error messages', () => {
    expect(isDuplicateUsernameError('El Login / Nick de usuario de usuario ya existe.')).toBe(true);
    expect(isDuplicateUsernameError('Username already exists')).toBe(true);
    expect(isDuplicateUsernameError('La ejecución de la solicitud falló.')).toBe(true);
    expect(isDuplicateUsernameError('invalid password')).toBe(false);
  });

  it('builds exhausted username error with tried candidates', () => {
    const error = buildExhaustedUsernameError('Pepito47', ['Pepito47', 'Pepito471']);
    expect(error.message).toContain('Pepito47');
    expect(error.message).toContain('Pepito471');
  });
});
