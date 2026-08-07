import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runRdaReportJob, runAsnReportJob } = vi.hoisted(() => ({
  runRdaReportJob: vi.fn(async () => ({
    result: {
      kind: 'rda-reporte-deposito-total',
      pagina: 'RdA',
      depositoTotal: '$ 0',
      depositoTotalNumero: 0
    }
  })),
  runAsnReportJob: vi.fn(async () => ({
    result: {
      kind: 'asn-reporte-cargado-mes',
      pagina: 'ASN',
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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes the lease reportDate through to RdA report jobs', async () => {
    const reportSession = { runId: 'run-1', pagina: 'RdA' } as any;
    const sessionManager = {
      withSession: vi.fn(async (_lease, action) => action(reportSession)),
      closeRun: vi.fn(async () => undefined)
    };
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
      { headless: true, debug: false, slowMo: 0, timeoutMs: 30_000 } as any,
      sessionManager
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
      expect.any(Object),
      reportSession
    );
    expect(sessionManager.withSession).toHaveBeenCalledOnce();
    await executor.closeRun?.('run-1');
    expect(sessionManager.closeRun).toHaveBeenCalledWith('run-1');
  });

  it('passes the requested historical date through to ASN', async () => {
    const reportSession = { runId: 'run-asn', pagina: 'ASN' } as any;
    const sessionManager = {
      withSession: vi.fn(async (_lease, action) => action(reportSession)),
      closeRun: vi.fn(async () => undefined)
    };
    const executor = createReportJobExecutor(
      { siteProfiles: [] } as any,
      { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) } as any,
      { headless: true, debug: false, slowMo: 0, timeoutMs: 30_000 } as any,
      sessionManager
    );

    await executor({
      runId: 'run-asn',
      itemId: 'item-asn',
      pagina: 'ASN',
      username: 'player-asn',
      agente: 'agente',
      contrasenaAgente: 'clave',
      reportDate: '2026-05-02'
    } as any);

    expect(runAsnReportJob).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ reportDate: '2026-05-02', usuario: 'player-asn' })
      }),
      expect.any(Object),
      expect.any(Object),
      reportSession
    );
  });

  it('rejects an RdA-shaped result returned by the ASN adapter', async () => {
    runAsnReportJob.mockResolvedValueOnce({
      result: {
        kind: 'rda-reporte-deposito-total',
        pagina: 'RdA'
      }
    } as any);
    const executor = createReportJobExecutor(
      { siteProfiles: [] } as any,
      { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) } as any,
      { headless: true, debug: false, slowMo: 0, timeoutMs: 30_000 } as any,
      {
        withSession: vi.fn(async (_lease, action) => action({ runId: 'run-asn-kind', pagina: 'ASN' } as any)),
        closeRun: vi.fn(async () => undefined)
      }
    );

    await expect(
      executor({
        runId: 'run-asn-kind',
        itemId: 'item-asn-kind',
        pagina: 'ASN',
        username: 'player-asn',
        agente: 'agente',
        contrasenaAgente: 'clave',
        reportDate: '2026-05-02'
      } as any)
    ).rejects.toThrow('supported report result for pagina=ASN');
  });

  it('caches a platform authentication failure so the run only attempts one login', async () => {
    runAsnReportJob.mockRejectedValueOnce(new Error('Authentication did not complete: login form is still visible'));
    const sessionManager = {
      withSession: vi.fn(async (_lease, action) => action({ runId: 'run-auth', pagina: 'ASN' } as any)),
      closeRun: vi.fn(async () => undefined)
    };
    const executor = createReportJobExecutor(
      { siteProfiles: [] } as any,
      { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) } as any,
      { headless: true, debug: false, slowMo: 0, timeoutMs: 30_000 } as any,
      sessionManager
    );
    const lease = {
      runId: 'run-auth',
      itemId: 'item-1',
      ownerId: 'owner-1',
      pagina: 'ASN',
      username: 'player-1',
      agente: 'bad-agent',
      contrasenaAgente: 'bad-password',
      reportDate: '2026-05-02'
    } as any;

    await expect(executor(lease)).rejects.toThrow('PLATFORM_AUTH_FAILED:ASN:');
    await expect(executor({ ...lease, itemId: 'item-2', username: 'player-2' })).rejects.toThrow(
      'PLATFORM_AUTH_FAILED:ASN:'
    );
    expect(runAsnReportJob).toHaveBeenCalledOnce();
    expect(sessionManager.withSession).toHaveBeenCalledOnce();

    await expect(
      executor({ ...lease, ownerId: 'owner-2', itemId: 'item-3', username: 'player-3' })
    ).resolves.toBeTruthy();
    expect(runAsnReportJob).toHaveBeenCalledTimes(2);
    expect(sessionManager.withSession).toHaveBeenCalledTimes(2);
  });
});
