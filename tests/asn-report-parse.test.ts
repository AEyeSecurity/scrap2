import { describe, expect, it } from 'vitest';
import {
  extractAsnMonthTotalCargadoFromText,
  getBuenosAiresMonthToken,
  parseAsnReportCargadoNumber,
  pickAsnMonthTotalCargadoRow
} from '../src/asn-report-job';

describe('asn-report helpers', () => {
  it('parses cargado amount text into number', () => {
    expect(parseAsnReportCargadoNumber('40.000,00')).toBe(40000);
    expect(parseAsnReportCargadoNumber('0,00')).toBe(0);
  });

  it('picks TOTAL del mes row for requested month token', () => {
    const rows = [
      { label: '2026-03-01', cargado: '40.000,00', descargado: '0,00', resultado: '40.000,00' },
      { label: 'TOTAL del mes 2026-03', cargado: '40.000,00', descargado: '0,00', resultado: '40.000,00' },
      { label: 'TOTAL del mes 2026-02', cargado: '293.430,00', descargado: '0,00', resultado: '293.430,00' }
    ];

    expect(pickAsnMonthTotalCargadoRow(rows, '2026-03')).toEqual(rows[1]);
    expect(pickAsnMonthTotalCargadoRow(rows, '2026-01')).toBeNull();
  });

  it('computes current month token in Buenos Aires timezone', () => {
    expect(getBuenosAiresMonthToken(new Date('2026-03-01T02:30:00.000Z'))).toBe('2026-02');
    expect(getBuenosAiresMonthToken(new Date('2026-03-01T03:30:00.000Z'))).toBe('2026-03');
  });

  it('extracts month total cargado from page text', () => {
    const text = 'algo TOTAL del mes 2026-02 293.430,00 0,00 293.430,00 mas';
    expect(extractAsnMonthTotalCargadoFromText(text, '2026-02')).toBe('293.430,00');
    expect(extractAsnMonthTotalCargadoFromText(text, '2026-03')).toBeNull();
  });
});
