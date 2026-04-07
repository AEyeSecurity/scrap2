import { describe, expect, it } from 'vitest';
import {
  hasCompactUsernameMatch,
  hasExactUsernameMatch,
  normalizeDepositText,
  selectDepositRowIndex,
  type DepositRowCandidate
} from '../src/deposit-match';

describe('deposit-match helpers', () => {
  it('normalizes accents and spacing', () => {
    expect(normalizeDepositText('  Dep\u00f3sito   R\u00e1pido  ')).toBe('deposito rapido');
  });

  it('matches exact username boundaries', () => {
    expect(hasExactUsernameMatch('usuario pruebita jugador', 'pruebita')).toBe(true);
    expect(hasExactUsernameMatch('pruebita_2', 'pruebita')).toBe(false);
  });

  it('matches compact username fragments', () => {
    expect(hasCompactUsernameMatch('0 Robertino254 jugador', '0Robertino254')).toBe(true);
  });

  it('selects the only exact actionable row', () => {
    const rows: DepositRowCandidate[] = [
      { index: 0, hasAction: true, usernames: ['otro_user'], normalizedText: 'otro_user jugador deposito' },
      { index: 1, hasAction: true, usernames: ['pruebita'], normalizedText: 'pruebita jugador deposito' }
    ];

    expect(selectDepositRowIndex(rows, 'pruebita')).toBe(1);
  });

  it('selects a unique compact match when the UI splits username fragments', () => {
    const rows: DepositRowCandidate[] = [
      { index: 0, hasAction: true, usernames: ['robertino254'], normalizedText: 'robertino254 jugador deposito' },
      { index: 1, hasAction: true, usernames: ['0', 'Robertino254'], normalizedText: '0 robertino254 jugador deposito' }
    ];

    expect(selectDepositRowIndex(rows, '0Robertino254')).toBe(1);
  });

  it('throws when there is no exact match', () => {
    const rows: DepositRowCandidate[] = [
      { index: 4, hasAction: true, usernames: ['algun_usuario'], normalizedText: 'algun_usuario deposito' }
    ];

    expect(() => selectDepositRowIndex(rows, 'pruebita')).toThrow(/Could not find an exact unique match/);
  });

  it('throws on ambiguity', () => {
    const rows: DepositRowCandidate[] = [
      { index: 0, hasAction: true, usernames: ['pruebita'], normalizedText: 'pruebita jugador deposito' },
      { index: 1, hasAction: true, usernames: ['pruebita'], normalizedText: 'pruebita jugador deposito' }
    ];

    expect(() => selectDepositRowIndex(rows, 'pruebita')).toThrow(/Multiple exact matches/);
  });
});
