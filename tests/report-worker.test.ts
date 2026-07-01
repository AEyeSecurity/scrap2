import { describe, expect, it, vi } from 'vitest';

const { runRdaReportJob, runAsnReportJob } = vi.hoisted(() => ({
  runRdaReportJob: vi.fn(async () => ({
    result: {
      kind: 'rda-reporte-deposito-total',
      depositoTotal: '$ 0',
      depositoTotalNumero: 0
    }
  })),
  runAsnReportJob: vi.fn(async () => ({
    result: {
      kind: 'asn-reporte-cargado-mes',
      cargadoMes: '$ 0',
      cargadoMesNumero: 0
    }
  }))
}));

vi.mock('../src/rda-report-job', () => ({
  runRdaReportJob
}));

vi.mock('../src/asn-report-job', () => ({
  runAsnReportJob
}));

import { createReportJobExecutor } from '../src/report-worker';

describe('report worker executor', () => {
  it('passes the lease reportDate through to RdA report jobs', async () => {
    const executor = createReportJobExecutor(
      {
        artifactsDir: 'artifacts',
        baseUrl: 'https://agents.reydeases.com',
        username: 'agente',
        password: 'clave',
        outputDir: 'out',
        headless: true,
        debug: false,
        slowMo: 0,
        timeoutMs: 30_000,
        retries: 1,
        concurrency: 1,
        maxPages: 1,
        logLevel: 'silent',
        blockResources: true,
        reuseSession: false,
        siteProfiles: []
      } as any,
      { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) } as any,
      { headless: true, debug: false, slowMo: 0, timeoutMs: 30_000 } as any
    );

    await executor({
      runId: 'run-1',
      itemId: 'item-1',
      pagina: 'RdA',
      username: '0romi150',
      agente: 'agente',
      contrasenaAgente: 'clave',
      reportDate: '2026-06-30'
    } as any);

    expect(runRdaReportJob).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          reportDate: '2026-06-30',
          usuario: '0romi150'
        })
      }),
      expect.any(Object),
      expect.any(Object)
    );
  });
});
