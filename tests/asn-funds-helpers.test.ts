import { describe, expect, it } from 'vitest';
import {
  computeAsnAppliedAmount,
  computeExpectedAsnBalance,
  isExpectedAsnTransferDelta,
  isExpectedAsnDelta,
  parseAsnMoney,
  resolveAsnDepositEntryPath,
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

  it('validates transfer delta for carga with at-least semantics', () => {
    expect(isExpectedAsnTransferDelta(320520.04, 290520.04, 30000)).toBe(true);
    expect(isExpectedAsnTransferDelta(320520.04, 260520.04, 30000)).toBe(true);
    expect(isExpectedAsnTransferDelta(320520.04, 300520.04, 30000)).toBe(false);
    expect(isExpectedAsnTransferDelta(320520.04, 330520.04, 30000)).toBe(false);
  });

  it('uses direct carga-jugador path in turbo mode for carga', () => {
    expect(resolveAsnDepositEntryPath('carga', 'Gladis2359', true)).toBe(
      '/NewAdmin/carga-jugador.php?usr=Gladis2359'
    );
  });

  it('keeps JugadoresCD path for carga when not turbo', () => {
    expect(resolveAsnDepositEntryPath('carga', 'Gladis2359', false)).toBe('/NewAdmin/JugadoresCD.php?usr=Gladis2359');
  });

  it('uses descarga-jugador path for withdraw operations', () => {
    expect(resolveAsnDepositEntryPath('descarga', 'Gladis2359', true)).toBe(
      '/NewAdmin/descarga-jugador.php?usr=Gladis2359'
    );
    expect(resolveAsnDepositEntryPath('descarga_total', 'Gladis2359', false)).toBe(
      '/NewAdmin/descarga-jugador.php?usr=Gladis2359'
    );
  });
});
