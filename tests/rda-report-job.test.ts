import { describe, expect, it } from 'vitest';
import {
  advanceRdaCashReportSettleState,
  extractRdaDepositoTotalFromText,
  parseRdaDepositoTotalNumber,
  type RdaCashReportSettleState
} from '../src/rda-report-job';
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

  it('does not accept the first ready placeholder immediately', () => {
    const initial: RdaCashReportSettleState = {
      readySince: null,
      valueStableSince: null,
      lastValue: null,
      lastSample: ''
    };
    const first = advanceRdaCashReportSettleState(
      initial,
      { ready: true, depositoTotalTexto: '$0,00', sample: 'Depósito total $0,00' },
      1_000,
      { minReadyMs: 500, valueStableMs: 300 }
    );
    const second = advanceRdaCashReportSettleState(
      first.state,
      { ready: true, depositoTotalTexto: '$0,00', sample: 'Depósito total $0,00' },
      1_700,
      { minReadyMs: 500, valueStableMs: 300 }
    );

    expect(first.settled).toBe(false);
    expect(second.settled).toBe(true);
  });

  it('resets stability when the deposit total changes after a placeholder', () => {
    const initial: RdaCashReportSettleState = {
      readySince: null,
      valueStableSince: null,
      lastValue: null,
      lastSample: ''
    };
    const first = advanceRdaCashReportSettleState(
      initial,
      { ready: true, depositoTotalTexto: '$0,00', sample: 'Depósito total $0,00' },
      1_000,
      { minReadyMs: 500, valueStableMs: 300 }
    );
    const changed = advanceRdaCashReportSettleState(
      first.state,
      { ready: true, depositoTotalTexto: '$119.900,00', sample: 'Depósito total $119.900,00' },
      1_700,
      { minReadyMs: 500, valueStableMs: 300 }
    );
    const stable = advanceRdaCashReportSettleState(
      changed.state,
      { ready: true, depositoTotalTexto: '$119.900,00', sample: 'Depósito total $119.900,00' },
      2_100,
      { minReadyMs: 500, valueStableMs: 300 }
    );

    expect(changed.settled).toBe(false);
    expect(stable.settled).toBe(true);
    expect(stable.state.lastValue).toBe('$119.900,00');
  });

  it('resets readiness when the report is not ready', () => {
    const state: RdaCashReportSettleState = {
      readySince: 1_000,
      valueStableSince: 1_000,
      lastValue: '$119.900,00',
      lastSample: 'Depósito total $119.900,00'
    };
    const next = advanceRdaCashReportSettleState(
      state,
      { ready: false, depositoTotalTexto: '$119.900,00', sample: 'Cargando' },
      1_500,
      { minReadyMs: 500, valueStableMs: 300 }
    );

    expect(next.settled).toBe(false);
    expect(next.state.readySince).toBeNull();
    expect(next.state.lastValue).toBeNull();
  });
});
