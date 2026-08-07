import { describe, expect, it } from 'vitest';
import {
  buildAsnReportResult,
  extractAsnDayCargadoFromText,
  getBuenosAiresDateToken,
  extractAsnMonthTotalCargadoFromText,
  getBuenosAiresMonthToken,
  parseAsnReportCargadoNumber,
  pickAsnDayCargadoRow,
  pickAsnMonthTotalCargadoRow,
  runAsnReportJob
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

  it('picks day row for requested date token', () => {
    const rows = [
      { label: '2026-03-06', cargado: '42.000,00', descargado: '0,00', resultado: '42.000,00' },
      { label: 'TOTAL del mes 2026-03', cargado: '172.044,00', descargado: '20.017,35', resultado: '152.026,65' }
    ];

    expect(pickAsnDayCargadoRow(rows, '2026-03-06')).toEqual(rows[0]);
    expect(pickAsnDayCargadoRow(rows, '2026-03-09')).toBeNull();
  });

  it('computes current month token in Buenos Aires timezone', () => {
    expect(getBuenosAiresMonthToken(new Date('2026-03-01T02:30:00.000Z'))).toBe('2026-02');
    expect(getBuenosAiresMonthToken(new Date('2026-03-01T03:30:00.000Z'))).toBe('2026-03');
  });

  it('computes current date token in Buenos Aires timezone', () => {
    expect(getBuenosAiresDateToken(new Date('2026-03-09T02:30:00.000Z'))).toBe('2026-03-08');
    expect(getBuenosAiresDateToken(new Date('2026-03-09T03:30:00.000Z'))).toBe('2026-03-09');
  });

  it('extracts month total cargado from page text', () => {
    const text = 'algo TOTAL del mes 2026-02 293.430,00 0,00 293.430,00 mas';
    expect(extractAsnMonthTotalCargadoFromText(text, '2026-02')).toBe('293.430,00');
    expect(extractAsnMonthTotalCargadoFromText(text, '2026-03')).toBeNull();
  });

  it('extracts day cargado from page text', () => {
    const text = 'algo 2026-03-06 42.000,00 0,00 42.000,00 TOTAL del mes 2026-03 172.044,00 20.017,35 152.026,65';
    expect(extractAsnDayCargadoFromText(text, '2026-03-06')).toBe('42.000,00');
    expect(extractAsnDayCargadoFromText(text, '2026-03-09')).toBeNull();
  });

  it('keeps the requested ASN daily amount unknown when the date row is absent', () => {
    expect(
      buildAsnReportResult({
        usuario: 'player-asn',
        reportDate: '2026-03-09',
        monthRow: {
          label: 'TOTAL del mes 2026-03',
          cargado: '172.044,00',
          descargado: '20.017,35',
          resultado: '152.026,65'
        },
        dayRow: null
      })
    ).toEqual(
      expect.objectContaining({
        kind: 'asn-reporte-cargado-mes',
        pagina: 'ASN',
        cargadoNumero: 172044,
        cargadoHoyTexto: null,
        cargadoHoyNumero: null
      })
    );
  });

  it('returns REPORT_DATE_UNAVAILABLE instead of fabricating another month', () => {
    expect(() =>
      buildAsnReportResult({
        usuario: 'player-asn',
        reportDate: '2026-01-10',
        monthRow: null,
        dayRow: null
      })
    ).toThrow('REPORT_DATE_UNAVAILABLE:');
  });

  it('rejects an ASN report job without an explicit reportDate before opening a browser', async () => {
    await expect(
      runAsnReportJob(
        {
          id: 'missing-date',
          jobType: 'report',
          createdAt: '2026-08-07T00:00:00.000Z',
          options: {} as any,
          payload: {
            pagina: 'ASN',
            operacion: 'reporte',
            usuario: 'player-asn',
            agente: 'agent',
            contrasena_agente: 'secret'
          }
        },
        {} as any,
        {} as any
      )
    ).rejects.toThrow('REPORT_DATE_UNAVAILABLE: ASN reportDate is required');
  });
});
