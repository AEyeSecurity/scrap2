import { describe, expect, it } from 'vitest';
import { parseBalanceNumber } from '../src/balance-job';

describe('parseBalanceNumber', () => {
  it('parses dot thousands and comma decimals', () => {
    expect(parseBalanceNumber('1.234,56')).toBe(1234.56);
  });

  it('parses whole amount with dot thousands', () => {
    expect(parseBalanceNumber('12.345')).toBe(12345);
  });

  it('parses zero amount', () => {
    expect(parseBalanceNumber('0,00')).toBe(0);
  });

  it('throws for non parseable value', () => {
    expect(() => parseBalanceNumber('saldo desconocido')).toThrow(/could not parse/i);
  });
});
