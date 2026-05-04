import { describe, expect, it } from 'vitest';
import {
  computeAsnAppliedAmount,
  computeExpectedAsnBalance,
  extractAsnCurrentAvailableBalance,
  isExpectedAsnTransferDelta,
  isExpectedAsnDelta,
  parseAsnMoney,
  resolveAsnDepositEntryPath,
  resolveAsnExecutableAmount,
  resolveAsnRequestedAmount
} from '../src/asn-funds-job';

describe('asn-funds helpers', () => {
  it('parses ASN money formats', () => {
    expect(parseAsnMoney('30.525,35')).toBe(30525.35);
    expect(parseAsnMoney('40.000,00')).toBe(40000);
    expect(parseAsnMoney('0,00')).toBe(0);
  });

  it('extracts ASN current balance from the strict player balance block', () => {
    const pageText = `
      Moneda: Fichas (ARS)
      Jugador: Dai731
      2026-05-03 12.000,00 0,00 12.000,00
      TOTAL del mes 2026-05 57.000,00 65.039,00 -8.039,00
      Saldo disponible actual

        18,00

      Saldo actualizado el
      2026-05-03 17:51:46
    `;

    expect(extractAsnCurrentAvailableBalance(pageText, 'Dai731')).toEqual({
      saldoTexto: '18,00',
      saldoNumero: 18
    });
  });

  it('does not extract ASN current balance from historical movements', () => {
    const pageText = `
      Jugador: Dai731
      2026-05-03 12.000,00 0,00 12.000,00
      TOTAL del mes 2026-05 57.000,00 65.039,00 -8.039,00
    `;

    expect(extractAsnCurrentAvailableBalance(pageText, 'Dai731')).toBeNull();
  });

  it('does not extract ASN current balance when the player block belongs to another user', () => {
    const pageText = `
      Jugador: Ariel728
      Saldo disponible actual
      18,00
      Saldo actualizado el
      2026-05-03 17:51:46
    `;

    expect(extractAsnCurrentAvailableBalance(pageText, 'Dai731')).toBeNull();
  });

  it('resolves requested amount for descarga_total from current balance', () => {
    expect(resolveAsnRequestedAmount('descarga_total', 30525.35)).toBe(30525.35);
  });

  it('computes expected balances and applied amounts for each operation', () => {
    expect(computeExpectedAsnBalance('carga', 100, 50)).toBe(150);
    expect(computeExpectedAsnBalance('descarga', 100, 40)).toBe(60);
    expect(computeExpectedAsnBalance('descarga', 22.34, 22.34)).toBe(0);
    expect(computeExpectedAsnBalance('descarga', 22.34, 45000)).toBe(0);
    expect(computeExpectedAsnBalance('descarga_total', 100, 100)).toBe(0);

    expect(computeAsnAppliedAmount('carga', 100, 150)).toBe(50);
    expect(computeAsnAppliedAmount('descarga', 100, 60)).toBe(40);
    expect(computeAsnAppliedAmount('descarga_total', 100, 0)).toBe(100);
  });

  it('caps ASN descarga execution to the available balance because ASN never goes negative', () => {
    const saldoAntes = 22.34;
    const montoSolicitado = 45000;
    const montoEjecutable = resolveAsnExecutableAmount('descarga', saldoAntes, montoSolicitado);

    expect(montoEjecutable).toBe(22.34);
    expect(computeExpectedAsnBalance('descarga', saldoAntes, montoEjecutable)).toBe(0);
    expect(computeAsnAppliedAmount('descarga', saldoAntes, 0)).toBe(22.34);
    expect(isExpectedAsnDelta('descarga', saldoAntes, 0, montoEjecutable)).toBe(true);
  });

  it('does not cap carga execution amounts', () => {
    expect(resolveAsnExecutableAmount('carga', 22.34, 45000)).toBe(45000);
  });

  it('validates expected delta with tolerance', () => {
    expect(isExpectedAsnDelta('carga', 100, 150, 50)).toBe(true);
    expect(isExpectedAsnDelta('descarga', 100, 60, 40)).toBe(true);
    expect(isExpectedAsnDelta('descarga', 22.34, 0, 22.34)).toBe(true);
    expect(isExpectedAsnDelta('descarga', 22.34, 0, 45000)).toBe(true);
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
