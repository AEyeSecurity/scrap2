import { describe, expect, it } from 'vitest';
import {
  computeAsnAppliedAmount,
  computeExpectedAsnBalance,
  isExpectedAsnDelta,
  parseAsnMoney,
  resolveAsnRequestedAmount
} from '../src/asn-funds-job';

describe('asn-funds helpers', () => {
  it('parses ASN money formats', () => {
    expect(parseAsnMoney('30.525,35')).toBe(30525.35);
    expect(parseAsnMoney('40.000,00')).toBe(40000);
    expect(parseAsnMoney('0,00')).toBe(0);
  });

  it('resolves requested amount for descarga_total from current balance', () => {
    expect(resolveAsnRequestedAmount('descarga_total', 30525.35)).toBe(30525.35);
  });

  it('computes expected balances and applied amounts for each operation', () => {
    expect(computeExpectedAsnBalance('carga', 100, 50)).toBe(150);
    expect(computeExpectedAsnBalance('descarga', 100, 40)).toBe(60);
    expect(computeExpectedAsnBalance('descarga_total', 100, 100)).toBe(0);

    expect(computeAsnAppliedAmount('carga', 100, 150)).toBe(50);
    expect(computeAsnAppliedAmount('descarga', 100, 60)).toBe(40);
    expect(computeAsnAppliedAmount('descarga_total', 100, 0)).toBe(100);
  });

  it('validates expected delta with tolerance', () => {
    expect(isExpectedAsnDelta('carga', 100, 150, 50)).toBe(true);
    expect(isExpectedAsnDelta('descarga', 100, 60, 40)).toBe(true);
    expect(isExpectedAsnDelta('descarga_total', 100, 0, 100)).toBe(true);
    expect(isExpectedAsnDelta('descarga', 100, 70, 40)).toBe(false);
  });
});
