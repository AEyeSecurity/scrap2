import { describe, expect, it } from 'vitest';
import { extractRdaDepositoTotalFromText, parseRdaDepositoTotalNumber } from '../src/rda-report-job';
import type { RdaReportJobResult } from '../src/types';

describe('rda report job helpers', () => {
  it('extracts Deposito total from visible report text', () => {
    const text = `Total

Depósito total

$1.234,56

Retiro total

$0,00`;

    expect(extractRdaDepositoTotalFromText(text)).toBe('$1.234,56');
    expect(parseRdaDepositoTotalNumber('$1.234,56')).toBe(1234.56);
  });

  it('maps RdA deposit total to persisted cargado fields', () => {
    const result: RdaReportJobResult = {
      kind: 'rda-reporte-deposito-total',
      pagina: 'RdA',
      usuario: '0robertino254',
      depositoTotalTexto: '$1.000,00',
      depositoTotalNumero: 1000,
      cargadoTexto: '$1.000,00',
      cargadoNumero: 1000,
      cargadoHoyTexto: '0,00',
      cargadoHoyNumero: 0
    };

    expect(result.cargadoNumero).toBe(result.depositoTotalNumero);
    expect(result.cargadoHoyNumero).toBe(0);
  });
});
