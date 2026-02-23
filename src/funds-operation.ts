import { z } from 'zod';
import type { FundsOperation } from './types';

export function normalizeFundsOperation(value: string): FundsOperation | null {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, '_');
  if (normalized === 'carga') {
    return 'carga';
  }

  if (normalized === 'descarga' || normalized === 'retiro') {
    return 'descarga';
  }

  if (normalized === 'descarga_total' || normalized === 'retiro_total') {
    return 'descarga_total';
  }

  return null;
}

export const fundsOperationSchema = z.string().trim().min(1).transform((value, ctx): FundsOperation => {
  const normalized = normalizeFundsOperation(value);
  if (!normalized) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'operacion must be one of: carga, descarga, retiro, descarga_total, retiro_total'
    });
    return z.NEVER;
  }

  return normalized;
});
