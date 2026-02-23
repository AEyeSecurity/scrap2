import { z } from 'zod';
import type { FundsOperation } from './types';

export function normalizeFundsOperation(value: string): FundsOperation | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'carga') {
    return 'carga';
  }

  if (normalized === 'descarga' || normalized === 'retiro') {
    return 'descarga';
  }

  return null;
}

export const fundsOperationSchema = z.string().trim().min(1).transform((value, ctx): FundsOperation => {
  const normalized = normalizeFundsOperation(value);
  if (!normalized) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'operacion must be one of: carga, descarga, retiro'
    });
    return z.NEVER;
  }

  return normalized;
});
