import { describe, expect, it } from 'vitest';
import { fundsOperationSchema, normalizeFundsOperation } from '../src/funds-operation';

describe('funds-operation helpers', () => {
  it('normalizes canonical operations', () => {
    expect(normalizeFundsOperation('carga')).toBe('carga');
    expect(normalizeFundsOperation('descarga')).toBe('descarga');
    expect(normalizeFundsOperation('descarga_total')).toBe('descarga_total');
  });

  it('normalizes alias and trims/case-folds values', () => {
    expect(normalizeFundsOperation(' retiro ')).toBe('descarga');
    expect(normalizeFundsOperation(' DeScArGa ')).toBe('descarga');
    expect(normalizeFundsOperation(' retiro_total ')).toBe('descarga_total');
    expect(normalizeFundsOperation(' Descarga Total ')).toBe('descarga_total');
    expect(normalizeFundsOperation(' Retiro Total ')).toBe('descarga_total');
    expect(normalizeFundsOperation(' CARGA ')).toBe('carga');
  });

  it('returns null for unsupported operations', () => {
    expect(normalizeFundsOperation('transferencia')).toBeNull();
    expect(normalizeFundsOperation('')).toBeNull();
  });

  it('schema parses and normalizes accepted values', () => {
    expect(fundsOperationSchema.parse('carga')).toBe('carga');
    expect(fundsOperationSchema.parse('retiro')).toBe('descarga');
    expect(fundsOperationSchema.parse(' descARGA ')).toBe('descarga');
    expect(fundsOperationSchema.parse('descarga_total')).toBe('descarga_total');
    expect(fundsOperationSchema.parse('retiro_total')).toBe('descarga_total');
    expect(fundsOperationSchema.parse('descarga total')).toBe('descarga_total');
  });

  it('schema rejects unsupported values', () => {
    const parsed = fundsOperationSchema.safeParse('otro');
    expect(parsed.success).toBe(false);
  });
});
