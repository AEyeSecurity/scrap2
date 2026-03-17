import { describe, expect, it } from 'vitest';
import { AsnUserCheckError } from '../src/asn-user-check';
import { buildAppConfig } from '../src/config';
import { createLogger } from '../src/logging';
import {
  MastercrmUserStoreError,
  type MastercrmClientsDashboardRecord,
  type MastercrmUserCashierLinkRecord,
  type MastercrmUserStore
} from '../src/mastercrm-user-store';
import type { MetaConversionsStore } from '../src/meta-conversions-store';
import { PlayerPhoneStoreError, type PlayerPhoneStore } from '../src/player-phone-store';
import { createServer } from '../src/server';
import type { JobRequest, JobStoreEntry } from '../src/types';

const allowAsnUserExists = async (): Promise<void> => undefined;

class FakeQueue {
  public readonly entries = new Map<string, JobStoreEntry>();
  public readonly requests: JobRequest[] = [];

  enqueue(request: JobRequest): string {
    this.requests.push(request);
    this.entries.set(request.id, {
      id: request.id,
      jobType: request.jobType,
      status: 'queued',
      createdAt: request.createdAt,
      artifactPaths: [],
      steps: []
    });
    return request.id;
  }

  getById(id: string): JobStoreEntry | undefined {
    return this.entries.get(id);
  }

  async shutdown(): Promise<void> {
    // no-op for tests
  }
}

class FakePlayerPhoneStore implements PlayerPhoneStore {
  public readonly intakeInputs: Array<{
    pagina: 'RdA' | 'ASN';
    telefono: string;
    ownerContext: {
      ownerKey: string;
      ownerLabel: string;
      actorAlias?: string | null;
      actorPhone?: string | null;
    };
    sourceContext?: {
      ctwaClid?: string | null;
      referralSourceId?: string | null;
      referralSourceUrl?: string | null;
      referralHeadline?: string | null;
      referralBody?: string | null;
      referralSourceType?: string | null;
      waId?: string | null;
      messageSid?: string | null;
      accountSid?: string | null;
      profileName?: string | null;
    } | null;
  }> = [];

  public readonly syncInputs: Array<{
    pagina: 'RdA' | 'ASN';
    jugadorUsername: string;
    telefono?: string;
    ownerContext: {
      ownerKey: string;
      ownerLabel: string;
      actorAlias?: string | null;
      actorPhone?: string | null;
    };
  }> = [];

  public readonly assignByPhoneInputs: Array<{
    pagina: 'RdA' | 'ASN';
    jugadorUsername: string;
    telefono: string;
    ownerContext: {
      ownerKey: string;
      ownerLabel: string;
      actorAlias?: string | null;
      actorPhone?: string | null;
    };
  }> = [];

  public readonly unassignByPhoneInputs: Array<{
    pagina: 'RdA' | 'ASN';
    telefono: string;
    ownerContext: {
      ownerKey: string;
      ownerLabel: string;
      actorAlias?: string | null;
      actorPhone?: string | null;
    };
  }> = [];

  public assignByPhoneBehavior: () => Promise<{
    previousUsername: string | null;
    currentUsername: string;
    overwritten: boolean;
    createdClient: boolean;
    createdLink: boolean;
    movedFromPhone: string | null;
    deletedOldPhone: boolean;
  }> = async () => ({
    previousUsername: 'player_1',
    currentUsername: 'player_1',
    overwritten: false,
    createdClient: false,
    createdLink: false,
    movedFromPhone: null,
    deletedOldPhone: false
  });

  public unassignByPhoneBehavior: () => Promise<{
    previousUsername: string | null;
    currentStatus: 'pending';
    unlinked: boolean;
  }> = async () => ({
    previousUsername: 'player_1',
    currentStatus: 'pending',
    unlinked: true
  });

  async intakePendingCliente(input: {
    pagina: 'RdA' | 'ASN';
    telefono: string;
    ownerContext: {
      ownerKey: string;
      ownerLabel: string;
      actorAlias?: string | null;
      actorPhone?: string | null;
    };
    sourceContext?: {
      ctwaClid?: string | null;
      referralSourceId?: string | null;
      referralSourceUrl?: string | null;
      referralHeadline?: string | null;
      referralBody?: string | null;
      referralSourceType?: string | null;
      waId?: string | null;
      messageSid?: string | null;
      accountSid?: string | null;
      profileName?: string | null;
    } | null;
  }): Promise<{
    cajeroId: string;
    jugadorId: string;
    linkId: string;
    estado: string;
    ownerId?: string;
    clientId?: string;
  }> {
    this.intakeInputs.push(input);
    return {
      cajeroId: 'cajero-1',
      jugadorId: 'jugador-1',
      linkId: 'link-1',
      estado: 'pendiente',
      ownerId: 'owner-1',
      clientId: 'client-1'
    };
  }

  async syncCreatePlayerLink(input: {
    pagina: 'RdA' | 'ASN';
    jugadorUsername: string;
    telefono?: string;
    ownerContext: {
      ownerKey: string;
      ownerLabel: string;
      actorAlias?: string | null;
      actorPhone?: string | null;
    };
  }): Promise<void> {
    this.syncInputs.push(input);
  }

  async assignPhone(input: {
    pagina: 'RdA' | 'ASN';
    jugadorUsername: string;
    telefono: string;
    ownerContext: {
      ownerKey: string;
      ownerLabel: string;
      actorAlias?: string | null;
      actorPhone?: string | null;
    };
  }): Promise<void> {
    this.assignByPhoneInputs.push(input);
  }

  async assignPendingUsername(input: {
    pagina: 'RdA' | 'ASN';
    jugadorUsername: string;
    telefono: string;
    ownerContext: {
      ownerKey: string;
      ownerLabel: string;
      actorAlias?: string | null;
      actorPhone?: string | null;
    };
  }): Promise<void> {
    this.assignByPhoneInputs.push(input);
  }

  async assignUsernameByPhone(input: {
    pagina: 'RdA' | 'ASN';
    jugadorUsername: string;
    telefono: string;
    ownerContext: {
      ownerKey: string;
      ownerLabel: string;
      actorAlias?: string | null;
      actorPhone?: string | null;
    };
  }): Promise<{
    previousUsername: string | null;
    currentUsername: string;
    overwritten: boolean;
    createdClient: boolean;
    createdLink: boolean;
    movedFromPhone: string | null;
    deletedOldPhone: boolean;
  }> {
    this.assignByPhoneInputs.push(input);
    return this.assignByPhoneBehavior();
  }

  async unassignUsernameByPhone(input: {
    pagina: 'RdA' | 'ASN';
    telefono: string;
    ownerContext: {
      ownerKey: string;
      ownerLabel: string;
      actorAlias?: string | null;
      actorPhone?: string | null;
    };
  }): Promise<{
    previousUsername: string | null;
    currentStatus: 'pending';
    unlinked: boolean;
  }> {
    this.unassignByPhoneInputs.push(input);
    return this.unassignByPhoneBehavior();
  }
}

class FakeMetaConversionsStore implements MetaConversionsStore {
  public readonly leadInputs: Array<{
    ownerId: string;
    clientId: string;
    phoneE164: string;
    ownerContext: { ownerKey: string; ownerLabel: string };
    sourceContext: Record<string, unknown>;
  }> = [];

  async enqueueLead(input: {
    ownerId: string;
    clientId: string;
    phoneE164: string;
    ownerContext: { ownerKey: string; ownerLabel: string };
    sourceContext: Record<string, unknown>;
  }): Promise<void> {
    this.leadInputs.push(input);
  }

  async scanForQualifiedLeads(_limit: number): Promise<number> {
    return 0;
  }

  async leaseNextEvent(_leaseSeconds: number, _maxAttempts: number): Promise<null> {
    return null;
  }

  async markSent(_id: string): Promise<void> {
    // no-op
  }

  async markRetry(_id: string, _error: string, _retryAfterSeconds: number): Promise<void> {
    // no-op
  }

  async markFailed(_id: string, _error: string): Promise<void> {
    // no-op
  }
}

class FakeMastercrmUserStore implements MastercrmUserStore {
  public readonly createInputs: Array<{
    username: string;
    password: string;
    nombre: string;
    telefono?: string;
  }> = [];

  public readonly authenticateInputs: Array<{
    username: string;
    password: string;
  }> = [];

  public readonly getByIdInputs: number[] = [];
  public readonly dashboardInputs: Array<{ userId: number; month?: string }> = [];
  public readonly financialInputs: Array<{ userId: number; month: string; adSpendArs: number; commissionPct: number }> = [];

  public readonly linkInputs: Array<{
    userId: number;
    ownerKey: string;
  }> = [];

  public createBehavior: (input: {
    username: string;
    password: string;
    nombre: string;
    telefono?: string;
  }) => Promise<{
    id: number;
    username: string;
    nombre: string;
    telefono: string | null;
    inversion: number;
    isActive: boolean;
    createdAt: string;
  }> = async (input) => ({
    id: 101,
    username: input.username,
    nombre: input.nombre,
    telefono: input.telefono ?? null,
    inversion: 0,
    isActive: true,
    createdAt: '2026-03-10T12:00:00.000Z'
  });

  public authenticateBehavior: (input: {
    username: string;
    password: string;
  }) => Promise<{
    id: number;
    username: string;
    nombre: string;
    telefono: string | null;
    inversion: number;
    isActive: boolean;
    createdAt: string;
  }> = async (input) => ({
    id: 101,
    username: input.username,
    nombre: 'Juan Perez',
    telefono: '54911',
    inversion: 150000,
    isActive: true,
    createdAt: '2026-03-10T12:00:00.000Z'
  });

  public getByIdBehavior: (id: number) => Promise<{
    id: number;
    username: string;
    nombre: string;
    telefono: string | null;
    inversion: number;
    isActive: boolean;
    createdAt: string;
  }> = async (id) => ({
    id,
    username: 'juan',
    nombre: 'Juan Perez',
    telefono: '54911',
    inversion: 0,
    isActive: true,
    createdAt: '2026-03-10T12:00:00.000Z'
  });

  public linkBehavior: (input: {
    userId: number;
    ownerKey: string;
  }) => Promise<MastercrmUserCashierLinkRecord> = async (input) => ({
    userId: input.userId,
    ownerKey: input.ownerKey,
    ownerLabel: 'Owner Label',
    pagina: 'ASN',
    linked: true,
    replaced: false,
    previousOwnerKey: null
  });

  public getClientsDashboardBehavior: (input: { userId: number; month?: string }) => Promise<MastercrmClientsDashboardRecord> = async (input) => ({
    linkedOwner: null,
    summary: null,
    financialInputs: {
      month: input.month ?? '2026-03',
      adSpendArs: null,
      commissionPct: null
    },
    primaryKpis: {
      cargadoMesArs: null,
      gananciaEstimadaArs: null,
      roiEstimadoPct: null,
      costoPorLeadRealArs: null,
      conversionAsignadoPct: null
    },
    statsKpis: {
      clientesTotales: 0,
      asignados: 0,
      pendientes: 0,
      cargadoHoyArs: null,
      cargadoMesArs: null,
      intakesMes: 0,
      asignacionesMes: 0,
      tasaIntakeAsignacionPct: null,
      clientesConReporte: 0,
      promedioCargaGeneralArs: null,
      tasaActivacionPct: null
    },
    clientes: []
  });

  public upsertOwnerFinancialsBehavior: (input: {
    userId: number;
    month: string;
    adSpendArs: number;
    commissionPct: number;
  }) => Promise<{
    month: string;
    adSpendArs: number | null;
    commissionPct: number | null;
  }> = async (input) => ({
    month: input.month,
    adSpendArs: input.adSpendArs,
    commissionPct: input.commissionPct
  });

  async createUser(input: {
    username: string;
    password: string;
    nombre: string;
    telefono?: string;
  }): Promise<{
    id: number;
    username: string;
    nombre: string;
    telefono: string | null;
    inversion: number;
    isActive: boolean;
    createdAt: string;
  }> {
    this.createInputs.push(input);
    return this.createBehavior(input);
  }

  async authenticate(input: {
    username: string;
    password: string;
  }): Promise<{
    id: number;
    username: string;
    nombre: string;
    telefono: string | null;
    inversion: number;
    isActive: boolean;
    createdAt: string;
  }> {
    this.authenticateInputs.push(input);
    return this.authenticateBehavior(input);
  }

  async getActiveUserById(id: number): Promise<{
    id: number;
    username: string;
    nombre: string;
    telefono: string | null;
    inversion: number;
    isActive: boolean;
    createdAt: string;
  }> {
    this.getByIdInputs.push(id);
    return this.getByIdBehavior(id);
  }

  async linkCashierToUser(input: {
    userId: number;
    ownerKey: string;
  }): Promise<MastercrmUserCashierLinkRecord> {
    this.linkInputs.push(input);
    return this.linkBehavior(input);
  }

  async getClientsDashboard(input: { userId: number; month?: string }): Promise<MastercrmClientsDashboardRecord> {
    this.dashboardInputs.push(input);
    return this.getClientsDashboardBehavior(input);
  }

  async upsertOwnerFinancials(input: {
    userId: number;
    month: string;
    adSpendArs: number;
    commissionPct: number;
  }): Promise<{
    month: string;
    adSpendArs: number | null;
    commissionPct: number | null;
  }> {
    this.financialInputs.push(input);
    return this.upsertOwnerFinancialsBehavior(input);
  }
}

describe('server routes', () => {
  it('POST /login returns 202 with job id', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { asnUserExistsChecker: allowAsnUserExists }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/login',
      payload: {
        username: 'user',
        password: 'pass'
      }
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.status).toBe('queued');
    expect(body.jobId).toMatch(/[0-9a-f-]{36}/i);
    expect(body.statusUrl).toBe(`/jobs/${body.jobId}`);
    expect(queue.getById(body.jobId)?.jobType).toBe('login');

    await server.close();
  });

  it('POST /mastercrm-register creates user and returns canonical payload', async () => {
    const queue = new FakeQueue();
    const store = new FakeMastercrmUserStore();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { mastercrmUserStore: store }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/mastercrm-register',
      payload: {
        username: 'Juan',
        usuario: 'juan',
        password: 'secret123',
        contrasena: 'secret123',
        nombre: 'Juan Perez',
        telefono: '54911'
      }
    });

    expect(response.statusCode).toBe(201);
    expect(store.createInputs).toEqual([
      {
        username: 'juan',
        password: 'secret123',
        nombre: 'Juan Perez',
        telefono: '54911'
      }
    ]);
    expect(response.json()).toEqual({
      id: 101,
      usuario: 'juan',
      nombre: 'Juan Perez',
      telefono: '54911',
      created_at: '2026-03-10T12:00:00.000Z',
      inversion: 0
    });

    await server.close();
  });

  it('POST /mastercrm-register rejects conflicting aliases', async () => {
    const queue = new FakeQueue();
    const store = new FakeMastercrmUserStore();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { mastercrmUserStore: store }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/mastercrm-register',
      payload: {
        username: 'juan',
        usuario: 'pedro',
        password: 'secret123',
        contrasena: 'secret123',
        nombre: 'Juan Perez'
      }
    });

    expect(response.statusCode).toBe(400);
    expect(store.createInputs).toHaveLength(0);

    await server.close();
  });

  it('POST /mastercrm-register returns 409 on duplicate username', async () => {
    const queue = new FakeQueue();
    const store = new FakeMastercrmUserStore();
    store.createBehavior = async () => {
      throw new MastercrmUserStoreError('CONFLICT', 'Could not create mastercrm user');
    };
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { mastercrmUserStore: store }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/mastercrm-register',
      payload: {
        usuario: 'juan',
        contrasena: 'secret123',
        nombre: 'Juan Perez'
      }
    });

    expect(response.statusCode).toBe(409);

    await server.close();
  });

  it('POST /mastercrm-login accepts duplicated frontend payload and returns canonical payload', async () => {
    const queue = new FakeQueue();
    const store = new FakeMastercrmUserStore();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { mastercrmUserStore: store }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/mastercrm-login',
      payload: {
        username: 'Juan',
        usuario: 'juan',
        password: 'secret123',
        contrasena: 'secret123'
      }
    });

    expect(response.statusCode).toBe(200);
    expect(store.authenticateInputs).toEqual([
      {
        username: 'juan',
        password: 'secret123'
      }
    ]);
    expect(response.json()).toEqual({
      id: 101,
      usuario: 'juan',
      nombre: 'Juan Perez',
      telefono: '54911',
      created_at: '2026-03-10T12:00:00.000Z',
      inversion: 150000
    });

    await server.close();
  });

  it('POST /mastercrm-login returns 401 on invalid credentials', async () => {
    const queue = new FakeQueue();
    const store = new FakeMastercrmUserStore();
    store.authenticateBehavior = async () => {
      throw new MastercrmUserStoreError('AUTHENTICATION', 'Invalid username or password');
    };
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { mastercrmUserStore: store }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/mastercrm-login',
      payload: {
        usuario: 'juan',
        contrasena: 'wrong'
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ message: 'Invalid username or password' });

    await server.close();
  });

  it('POST /mastercrm-clients accepts id aliases and returns the cashier dashboard payload', async () => {
    const queue = new FakeQueue();
    const store = new FakeMastercrmUserStore();
    store.getClientsDashboardBehavior = async ({ userId, month }) => ({
      linkedOwner: {
        ownerId: `owner-${userId}`,
        ownerKey: `owner-${userId}`,
        ownerLabel: `Owner ${userId}`,
        pagina: 'ASN',
        telefono: `+54911${userId}`
      },
      summary: {
        totalClients: 3,
        assignedClients: 2,
        pendingClients: 1,
        reportDate: '2026-03-12',
        cargadoHoyTotal: 1200,
        cargadoMesTotal: 5600,
        hasReport: true
      },
      financialInputs: {
        month: month ?? '2026-03',
        adSpendArs: 2500,
        commissionPct: 12.5
      },
      primaryKpis: {
        cargadoMesArs: 5600,
        gananciaEstimadaArs: 700,
        roiEstimadoPct: -72,
        costoPorLeadRealArs: 625,
        conversionAsignadoPct: 66.67
      },
      statsKpis: {
        clientesTotales: 3,
        asignados: 2,
        pendientes: 1,
        cargadoHoyArs: 1200,
        cargadoMesArs: 5600,
        intakesMes: 4,
        asignacionesMes: 2,
        tasaIntakeAsignacionPct: 50,
        clientesConReporte: 2,
        promedioCargaGeneralArs: 1866.67,
        tasaActivacionPct: 100
      },
      clientes: [
        {
          id: `link-${userId}`,
          username: `player-${userId}`,
          telefono: `54911${userId}`,
          pagina: 'ASN',
          estado: 'assigned',
          ownerKey: `owner-${userId}`,
          ownerLabel: `Owner ${userId}`,
          cargadoHoy: 600,
          cargadoMes: 2800,
          reportDate: '2026-03-12'
        }
      ]
    });
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { mastercrmUserStore: store }
    );

    const responseFromId = await server.inject({
      method: 'POST',
      url: '/mastercrm-clients',
      payload: { id: 101, month: '2026-03' }
    });
    const responseFromUserId = await server.inject({
      method: 'POST',
      url: '/mastercrm-clients',
      payload: { user_id: 202 }
    });
    const responseFromUsuarioId = await server.inject({
      method: 'POST',
      url: '/mastercrm-clients',
      payload: { usuario_id: '303' }
    });

    expect(responseFromId.statusCode).toBe(200);
    expect(responseFromUserId.statusCode).toBe(200);
    expect(responseFromUsuarioId.statusCode).toBe(200);
    expect(responseFromId.json()).toEqual({
      linkedOwner: {
        ownerKey: 'owner-101',
        ownerLabel: 'Owner 101',
        pagina: 'ASN',
        telefono: '+54911101'
      },
      summary: {
        totalClients: 3,
        assignedClients: 2,
        pendingClients: 1,
        reportDate: '2026-03-12',
        cargadoHoyTotal: 1200,
        cargadoMesTotal: 5600,
        hasReport: true
      },
      financialInputs: {
        month: '2026-03',
        adSpendArs: 2500,
        commissionPct: 12.5
      },
      primaryKpis: {
        cargadoMesArs: 5600,
        gananciaEstimadaArs: 700,
        roiEstimadoPct: -72,
        costoPorLeadRealArs: 625,
        conversionAsignadoPct: 66.67
      },
      statsKpis: {
        clientesTotales: 3,
        asignados: 2,
        pendientes: 1,
        cargadoHoyArs: 1200,
        cargadoMesArs: 5600,
        intakesMes: 4,
        asignacionesMes: 2,
        tasaIntakeAsignacionPct: 50,
        clientesConReporte: 2,
        promedioCargaGeneralArs: 1866.67,
        tasaActivacionPct: 100
      },
      clientes: [
        {
          id: 'link-101',
          username: 'player-101',
          telefono: '54911101',
          pagina: 'ASN',
          estado: 'assigned',
          ownerKey: 'owner-101',
          ownerLabel: 'Owner 101',
          cargadoHoy: 600,
          cargadoMes: 2800,
          reportDate: '2026-03-12'
        }
      ]
    });
    expect(responseFromUserId.json()).toEqual({
      linkedOwner: {
        ownerKey: 'owner-202',
        ownerLabel: 'Owner 202',
        pagina: 'ASN',
        telefono: '+54911202'
      },
      summary: {
        totalClients: 3,
        assignedClients: 2,
        pendingClients: 1,
        reportDate: '2026-03-12',
        cargadoHoyTotal: 1200,
        cargadoMesTotal: 5600,
        hasReport: true
      },
      financialInputs: {
        month: '2026-03',
        adSpendArs: 2500,
        commissionPct: 12.5
      },
      primaryKpis: {
        cargadoMesArs: 5600,
        gananciaEstimadaArs: 700,
        roiEstimadoPct: -72,
        costoPorLeadRealArs: 625,
        conversionAsignadoPct: 66.67
      },
      statsKpis: {
        clientesTotales: 3,
        asignados: 2,
        pendientes: 1,
        cargadoHoyArs: 1200,
        cargadoMesArs: 5600,
        intakesMes: 4,
        asignacionesMes: 2,
        tasaIntakeAsignacionPct: 50,
        clientesConReporte: 2,
        promedioCargaGeneralArs: 1866.67,
        tasaActivacionPct: 100
      },
      clientes: [
        {
          id: 'link-202',
          username: 'player-202',
          telefono: '54911202',
          pagina: 'ASN',
          estado: 'assigned',
          ownerKey: 'owner-202',
          ownerLabel: 'Owner 202',
          cargadoHoy: 600,
          cargadoMes: 2800,
          reportDate: '2026-03-12'
        }
      ]
    });
    expect(responseFromUsuarioId.json()).toEqual({
      linkedOwner: {
        ownerKey: 'owner-303',
        ownerLabel: 'Owner 303',
        pagina: 'ASN',
        telefono: '+54911303'
      },
      summary: {
        totalClients: 3,
        assignedClients: 2,
        pendingClients: 1,
        reportDate: '2026-03-12',
        cargadoHoyTotal: 1200,
        cargadoMesTotal: 5600,
        hasReport: true
      },
      financialInputs: {
        month: '2026-03',
        adSpendArs: 2500,
        commissionPct: 12.5
      },
      primaryKpis: {
        cargadoMesArs: 5600,
        gananciaEstimadaArs: 700,
        roiEstimadoPct: -72,
        costoPorLeadRealArs: 625,
        conversionAsignadoPct: 66.67
      },
      statsKpis: {
        clientesTotales: 3,
        asignados: 2,
        pendientes: 1,
        cargadoHoyArs: 1200,
        cargadoMesArs: 5600,
        intakesMes: 4,
        asignacionesMes: 2,
        tasaIntakeAsignacionPct: 50,
        clientesConReporte: 2,
        promedioCargaGeneralArs: 1866.67,
        tasaActivacionPct: 100
      },
      clientes: [
        {
          id: 'link-303',
          username: 'player-303',
          telefono: '54911303',
          pagina: 'ASN',
          estado: 'assigned',
          ownerKey: 'owner-303',
          ownerLabel: 'Owner 303',
          cargadoHoy: 600,
          cargadoMes: 2800,
          reportDate: '2026-03-12'
        }
      ]
    });
    expect(store.dashboardInputs).toEqual([{ userId: 101, month: '2026-03' }, { userId: 202 }, { userId: 303 }]);

    await server.close();
  });

  it('POST /mastercrm-owner-financials persists monthly ad spend and commission', async () => {
    const queue = new FakeQueue();
    const store = new FakeMastercrmUserStore();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { mastercrmUserStore: store }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/mastercrm-owner-financials',
      payload: {
        user_id: 101,
        month: '2026-03',
        ad_spend_ars: 250000,
        commission_pct: 12.5
      }
    });

    expect(response.statusCode).toBe(200);
    expect(store.financialInputs).toEqual([
      {
        userId: 101,
        month: '2026-03',
        adSpendArs: 250000,
        commissionPct: 12.5
      }
    ]);
    expect(response.json()).toEqual({
      month: '2026-03',
      adSpendArs: 250000,
      commissionPct: 12.5
    });

    await server.close();
  });

  it('POST /mastercrm-clients returns 404 when user is missing', async () => {
    const queue = new FakeQueue();
    const store = new FakeMastercrmUserStore();
    store.getClientsDashboardBehavior = async () => {
      throw new MastercrmUserStoreError('NOT_FOUND', 'MasterCRM user not found');
    };
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { mastercrmUserStore: store }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/mastercrm-clients',
      payload: { user_id: 999 }
    });

    expect(response.statusCode).toBe(404);

    await server.close();
  });

  it('POST /mastercrm-link-cashier creates the user-owner link', async () => {
    const queue = new FakeQueue();
    const store = new FakeMastercrmUserStore();
    const previousPassword = process.env.MASTERCRM_STAFF_LINK_PASSWORD;
    process.env.MASTERCRM_STAFF_LINK_PASSWORD = 'staff-secret';
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { mastercrmUserStore: store }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/mastercrm-link-cashier',
      payload: {
        user_id: '123',
        owner_key: '  OWNER_KEY_DEL_CAJERO  ',
        staff_password: 'staff-secret'
      }
    });

    expect(response.statusCode).toBe(201);
    expect(store.linkInputs).toEqual([
      {
        userId: 123,
        ownerKey: 'owner_key_del_cajero'
      }
    ]);
    expect(response.json()).toEqual({
      success: true,
      message: 'Usuario vinculado al cajero correctamente',
      data: {
        user_id: 123,
        owner_key: 'owner_key_del_cajero',
        owner_label: 'Owner Label',
        pagina: 'ASN',
        linked: true,
        replaced: false,
        previous_owner_key: null
      }
    });

    await server.close();
    process.env.MASTERCRM_STAFF_LINK_PASSWORD = previousPassword;
  });

  it('POST /mastercrm-link-cashier validates payload', async () => {
    const queue = new FakeQueue();
    const store = new FakeMastercrmUserStore();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { mastercrmUserStore: store }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/mastercrm-link-cashier',
      payload: {
        owner_key: ''
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      success: false,
      message: 'Faltan datos requeridos',
      issues: [
        { path: 'user_id', message: 'user_id is required' },
        { path: 'owner_key', message: 'owner_key is required' },
        { path: 'staff_password', message: 'staff_password is required' }
      ]
    });
    expect(store.linkInputs).toHaveLength(0);

    await server.close();
  });

  it('POST /mastercrm-link-cashier returns 404 when user is missing', async () => {
    const queue = new FakeQueue();
    const store = new FakeMastercrmUserStore();
    const previousPassword = process.env.MASTERCRM_STAFF_LINK_PASSWORD;
    process.env.MASTERCRM_STAFF_LINK_PASSWORD = 'staff-secret';
    store.linkBehavior = async () => {
      throw new MastercrmUserStoreError('NOT_FOUND', 'MasterCRM user not found');
    };
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { mastercrmUserStore: store }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/mastercrm-link-cashier',
      payload: {
        user_id: 999,
        owner_key: 'owner_1',
        staff_password: 'staff-secret'
      }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      success: false,
      message: 'Usuario o cajero no encontrado'
    });

    await server.close();
    process.env.MASTERCRM_STAFF_LINK_PASSWORD = previousPassword;
  });

  it('POST /mastercrm-link-cashier returns 404 when owner is missing', async () => {
    const queue = new FakeQueue();
    const store = new FakeMastercrmUserStore();
    const previousPassword = process.env.MASTERCRM_STAFF_LINK_PASSWORD;
    process.env.MASTERCRM_STAFF_LINK_PASSWORD = 'staff-secret';
    store.linkBehavior = async () => {
      throw new MastercrmUserStoreError('NOT_FOUND', 'Cashier owner_key not found');
    };
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { mastercrmUserStore: store }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/mastercrm-link-cashier',
      payload: {
        user_id: 123,
        owner_key: 'owner_missing',
        staff_password: 'staff-secret'
      }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      success: false,
      message: 'Usuario o cajero no encontrado'
    });

    await server.close();
    process.env.MASTERCRM_STAFF_LINK_PASSWORD = previousPassword;
  });

  it('POST /mastercrm-link-cashier returns 403 when the staff password is invalid', async () => {
    const queue = new FakeQueue();
    const store = new FakeMastercrmUserStore();
    const previousPassword = process.env.MASTERCRM_STAFF_LINK_PASSWORD;
    process.env.MASTERCRM_STAFF_LINK_PASSWORD = 'staff-secret';
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { mastercrmUserStore: store }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/mastercrm-link-cashier',
      payload: {
        user_id: 123,
        owner_key: 'owner_1',
        staff_password: 'wrong-secret'
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      success: false,
      message: 'Clave tecnica invalida'
    });
    expect(store.linkInputs).toHaveLength(0);

    await server.close();
    process.env.MASTERCRM_STAFF_LINK_PASSWORD = previousPassword;
  });

  it('POST /mastercrm-link-cashier reports replacement metadata when changing owner', async () => {
    const queue = new FakeQueue();
    const store = new FakeMastercrmUserStore();
    const previousPassword = process.env.MASTERCRM_STAFF_LINK_PASSWORD;
    process.env.MASTERCRM_STAFF_LINK_PASSWORD = 'staff-secret';
    store.linkBehavior = async (input) => ({
      userId: input.userId,
      ownerKey: input.ownerKey,
      ownerLabel: 'Owner Replaced',
      pagina: 'ASN',
      linked: true,
      replaced: true,
      previousOwnerKey: 'owner_old'
    });
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { mastercrmUserStore: store }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/mastercrm-link-cashier',
      payload: {
        user_id: 123,
        owner_key: 'owner_1',
        staff_password: 'staff-secret'
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      success: true,
      message: 'Usuario vinculado al cajero correctamente',
      data: {
        user_id: 123,
        owner_key: 'owner_1',
        owner_label: 'Owner Replaced',
        pagina: 'ASN',
        linked: true,
        replaced: true,
        previous_owner_key: 'owner_old'
      }
    });

    await server.close();
    process.env.MASTERCRM_STAFF_LINK_PASSWORD = previousPassword;
  });

  it('OPTIONS /mastercrm-login returns configured cors headers', async () => {
    const queue = new FakeQueue();
    const store = new FakeMastercrmUserStore();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const previousOrigins = process.env.MASTERCRM_CORS_ORIGINS;
    process.env.MASTERCRM_CORS_ORIGINS = 'http://localhost:5173,http://127.0.0.1:5173';

    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { mastercrmUserStore: store }
    );

    const response = await server.inject({
      method: 'OPTIONS',
      url: '/mastercrm-login',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST'
      }
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');

    await server.close();
    if (previousOrigins === undefined) {
      delete process.env.MASTERCRM_CORS_ORIGINS;
    } else {
      process.env.MASTERCRM_CORS_ORIGINS = previousOrigins;
    }
  });

  it('POST /users/create-player returns 202 with job id', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { asnUserExistsChecker: allowAsnUserExists }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/create-player',
      payload: {
        pagina: 'RdA',
        loginUsername: 'agent',
        loginPassword: 'secret',
        newUsername: 'player_1',
        newPassword: 'player_secret'
      }
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.status).toBe('queued');
    expect(body.statusUrl).toBe(`/jobs/${body.jobId}`);
    expect(queue.getById(body.jobId)?.jobType).toBe('create-player');
    const queued = queue.requests.find((item) => item.id === body.jobId);
    expect(queued?.jobType).toBe('create-player');
    if (queued?.jobType === 'create-player') {
      expect(queued.payload.pagina).toBe('RdA');
    }

    await server.close();
  });

  it('POST /users/create-player validates payload', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { asnUserExistsChecker: allowAsnUserExists }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/create-player',
      payload: { loginUsername: 'agent' }
    });

    expect(response.statusCode).toBe(400);
    await server.close();
  });

  it('POST /users/create-player requires ownerContext when telefono is provided', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { asnUserExistsChecker: allowAsnUserExists }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/create-player',
      payload: {
        pagina: 'RdA',
        loginUsername: 'agent',
        loginPassword: 'secret',
        newUsername: 'player_with_phone',
        newPassword: 'player_secret',
        telefono: '+5491122334455'
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().issues).toContainEqual({
      path: 'ownerContext',
      message: 'ownerContext is required when telefono is provided'
    });
    expect(queue.requests).toHaveLength(0);

    await server.close();
  });

  it('POST /users/create-player accepts ownerContext', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { asnUserExistsChecker: allowAsnUserExists }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/create-player',
      payload: {
        pagina: 'ASN',
        loginUsername: 'agent',
        loginPassword: 'secret',
        newUsername: 'player_with_owner',
        newPassword: 'player_secret',
        telefono: '+5491122334455',
        ownerContext: {
          ownerKey: 'wf_123',
          ownerLabel: 'Lucas 10',
          actorAlias: 'Vicky',
          actorPhone: '+5491122334000'
        }
      }
    });

    expect(response.statusCode).toBe(202);
    const queued = queue.requests.find((item) => item.id === response.json().jobId);
    expect(queued?.jobType).toBe('create-player');
    if (queued?.jobType === 'create-player') {
      expect(queued.payload.ownerContext).toEqual({
        ownerKey: 'wf_123',
        ownerLabel: 'Lucas 10',
        actorAlias: 'Vicky',
        actorPhone: '+5491122334000'
      });
    }

    await server.close();
  });

  it('POST /users/create-player normalizes pagina aliases', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { asnUserExistsChecker: allowAsnUserExists }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/create-player',
      payload: {
        pagina: 'asn',
        loginUsername: 'Abigail759',
        loginPassword: 'abigail123',
        newUsername: 'player_asn_alias',
        newPassword: 'player_secret'
      }
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    const queued = queue.requests.find((item) => item.id === body.jobId);
    expect(queued?.jobType).toBe('create-player');
    if (queued?.jobType === 'create-player') {
      expect(queued.payload.pagina).toBe('ASN');
    }

    await server.close();
  });

  it('POST /users/create-player requires pagina', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { asnUserExistsChecker: allowAsnUserExists }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/create-player',
      payload: {
        loginUsername: 'Abigail759',
        loginPassword: 'abigail123',
        newUsername: 'player_missing_pagina',
        newPassword: 'player_secret'
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().issues.some((issue: { path: string }) => issue.path === 'pagina')).toBe(true);
    await server.close();
  });

  it('POST /users/intake-pending persists pending intake via store', async () => {
    const queue = new FakeQueue();
    const store = new FakePlayerPhoneStore();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { playerPhoneStore: store }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/intake-pending',
      payload: {
        pagina: 'ASN',
        telefono: '+5491122334455',
        ownerContext: {
          ownerKey: 'wf_001',
          ownerLabel: 'Lucas 10',
          actorAlias: 'Vicky',
          actorPhone: '+5491122334999'
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(store.intakeInputs).toHaveLength(1);
    expect(store.intakeInputs[0]).toEqual({
      pagina: 'ASN',
      telefono: '+5491122334455',
      ownerContext: {
        ownerKey: 'wf_001',
        ownerLabel: 'Lucas 10',
        actorAlias: 'Vicky',
        actorPhone: '+5491122334999'
      }
    });

    await server.close();
  });

  it('POST /users/intake-pending forwards sourceContext and enqueues an attributable Meta lead', async () => {
    const queue = new FakeQueue();
    const playerPhoneStore = new FakePlayerPhoneStore();
    const metaStore = new FakeMetaConversionsStore();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      {
        playerPhoneStore,
        metaConversionsStore: metaStore,
        metaEnabled: true,
        metaWorkerEnabled: false
      }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/intake-pending',
      payload: {
        pagina: 'ASN',
        telefono: '+5491122334455',
        ownerContext: {
          ownerKey: 'wf_001',
          ownerLabel: 'Lucas 10'
        },
        sourceContext: {
          ctwaClid: 'clid-123',
          referralSourceId: '6904268485256',
          referralSourceUrl: 'https://fb.me/8cuWQu6gD',
          referralHeadline: 'ROYAL LUCK',
          referralBody: 'Quiero mi bono',
          referralSourceType: 'ad',
          waId: '5491138294407',
          messageSid: 'SM123',
          accountSid: 'AC123',
          profileName: 'Raul Rodriguez'
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(playerPhoneStore.intakeInputs[0]).toEqual({
      pagina: 'ASN',
      telefono: '+5491122334455',
      ownerContext: {
        ownerKey: 'wf_001',
        ownerLabel: 'Lucas 10'
      },
      sourceContext: {
        ctwaClid: 'clid-123',
        referralSourceId: '6904268485256',
        referralSourceUrl: 'https://fb.me/8cuWQu6gD',
        referralHeadline: 'ROYAL LUCK',
        referralBody: 'Quiero mi bono',
        referralSourceType: 'ad',
        waId: '5491138294407',
        messageSid: 'SM123',
        accountSid: 'AC123',
        profileName: 'Raul Rodriguez'
      }
    });
    expect(metaStore.leadInputs).toEqual([
      {
        ownerId: 'owner-1',
        clientId: 'client-1',
        phoneE164: '+5491122334455',
        ownerContext: {
          ownerKey: 'wf_001',
          ownerLabel: 'Lucas 10'
        },
        sourceContext: {
          ctwaClid: 'clid-123',
          referralSourceId: '6904268485256',
          referralSourceUrl: 'https://fb.me/8cuWQu6gD',
          referralHeadline: 'ROYAL LUCK',
          referralBody: 'Quiero mi bono',
          referralSourceType: 'ad',
          waId: '5491138294407',
          messageSid: 'SM123',
          accountSid: 'AC123',
          profileName: 'Raul Rodriguez'
        }
      }
    ]);

    await server.close();
  });

  it('POST /users/intake-pending requires ownerContext', async () => {
    const queue = new FakeQueue();
    const store = new FakePlayerPhoneStore();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { playerPhoneStore: store }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/intake-pending',
      payload: {
        pagina: 'ASN',
        telefono: '+5491122334455'
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      message: 'Invalid payload',
      code: 'INVALID_PAYLOAD',
      details: {
        issues: [
          {
            path: 'ownerContext',
            message: 'Invalid input: expected object, received undefined'
          }
        ]
      }
    });
    expect(store.intakeInputs).toHaveLength(0);

    await server.close();
  });

  it('POST /users/assign-phone validates payload and requires contrasena_agente', async () => {
    const queue = new FakeQueue();
    const store = new FakePlayerPhoneStore();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      {
        playerPhoneStore: store,
        asnUserExistsChecker: async () => undefined
      }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/assign-phone',
      payload: {
        pagina: 'ASN',
        usuario: 'player_1',
        agente: 'agent_1',
        telefono: '+5491122334455'
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('INVALID_PAYLOAD');
    expect(store.assignByPhoneInputs).toHaveLength(0);

    await server.close();
  });

  it('POST /users/assign-phone uses ownerContext.ownerKey when provided', async () => {
    const queue = new FakeQueue();
    const store = new FakePlayerPhoneStore();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      {
        playerPhoneStore: store,
        asnUserExistsChecker: async () => undefined
      }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/assign-phone',
      payload: {
        pagina: 'ASN',
        usuario: 'player_1',
        agente: 'agent_visible',
        contrasena_agente: 'secret',
        telefono: '+5491122334455',
        ownerContext: {
          ownerKey: 'wf_owner_9',
          ownerLabel: 'Lucas 10',
          actorAlias: 'Vicky'
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(store.assignByPhoneInputs).toHaveLength(1);
    expect(store.assignByPhoneInputs[0]?.ownerContext).toEqual({
      ownerKey: 'wf_owner_9',
      ownerLabel: 'Lucas 10',
      actorAlias: 'Vicky'
    });

    await server.close();
  });

  it('POST /users/assign-phone returns 501 for non-ASN pagina', async () => {
    const queue = new FakeQueue();
    const store = new FakePlayerPhoneStore();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      {
        playerPhoneStore: store,
        asnUserExistsChecker: async () => undefined
      }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/assign-phone',
      payload: {
        pagina: 'RdA',
        usuario: 'player_1',
        agente: 'agent_1',
        contrasena_agente: 'secret',
        telefono: '+5491122334455',
        ownerContext: {
          ownerKey: 'wf_owner_9',
          ownerLabel: 'Lucas 10'
        }
      }
    });

    expect(response.statusCode).toBe(501);
    expect(response.json()).toEqual({
      message: 'assign-phone with ASN existence check is implemented only for ASN',
      code: 'UNSUPPORTED_PAGINA',
      details: { pagina: 'RdA' }
    });
    expect(store.assignByPhoneInputs).toHaveLength(0);

    await server.close();
  });

  it('POST /users/assign-phone returns 404 when ASN user does not exist', async () => {
    const queue = new FakeQueue();
    const store = new FakePlayerPhoneStore();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      {
        playerPhoneStore: store,
        asnUserExistsChecker: async () => {
          throw new AsnUserCheckError('NOT_FOUND', 'El usuario no existe');
        }
      }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/assign-phone',
      payload: {
        pagina: 'ASN',
        usuario: 'missing_player',
        agente: 'agent_1',
        contrasena_agente: 'secret',
        telefono: '+5491122334455',
        ownerContext: {
          ownerKey: 'wf_owner_9',
          ownerLabel: 'Lucas 10'
        }
      }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      message: 'No se ha encontrado el usuario missing_player',
      code: 'ASN_USER_NOT_FOUND',
      details: { usuario: 'missing_player' }
    });
    expect(store.assignByPhoneInputs).toHaveLength(0);

    await server.close();
  });

  it('POST /users/assign-phone returns 409 when username belongs to another owner', async () => {
    const queue = new FakeQueue();
    const store = new FakePlayerPhoneStore();
    store.assignByPhoneBehavior = async () => {
      throw new PlayerPhoneStoreError('CONFLICT', 'El usuario ya esta asignado a otro cajero', {
        reason: 'USERNAME_ASSIGNED_TO_OTHER_OWNER',
        details: { usuario: 'player_1' }
      });
    };
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      {
        playerPhoneStore: store,
        asnUserExistsChecker: async () => undefined
      }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/assign-phone',
      payload: {
        pagina: 'ASN',
        usuario: 'player_1',
        agente: 'agent_1',
        contrasena_agente: 'secret',
        telefono: '+5491122334455',
        ownerContext: {
          ownerKey: 'wf_owner_9',
          ownerLabel: 'Lucas 10'
        }
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      message: 'El usuario ya esta asignado a otro cajero',
      code: 'USERNAME_ASSIGNED_TO_OTHER_OWNER',
      details: { usuario: 'player_1' }
    });

    await server.close();
  });

  it('POST /users/assign-phone returns overwrite details when assignment changes username', async () => {
    const queue = new FakeQueue();
    const store = new FakePlayerPhoneStore();
    store.assignByPhoneBehavior = async () => ({
      previousUsername: 'ailen389',
      currentUsername: '1ailen389',
      overwritten: true,
      createdClient: true,
      createdLink: true,
      movedFromPhone: '+5493514000000',
      deletedOldPhone: true
    });
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      {
        playerPhoneStore: store,
        asnUserExistsChecker: async () => undefined
      }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/assign-phone',
      payload: {
        pagina: 'ASN',
        usuario: '1ailen389',
        agente: 'luuucas10',
        contrasena_agente: 'secret',
        telefono: '+5493514867589',
        ownerContext: {
          ownerKey: 'wf_owner_9',
          ownerLabel: 'Lucas 10'
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      overwritten: true,
      previousUsername: 'ailen389',
      currentUsername: '1ailen389',
      createdClient: true,
      createdLink: true,
      movedFromPhone: '+5493514000000',
      deletedOldPhone: true
    });

    await server.close();
  });

  it('POST /users/assign-phone returns overwritten=false when username is unchanged', async () => {
    const queue = new FakeQueue();
    const store = new FakePlayerPhoneStore();
    store.assignByPhoneBehavior = async () => ({
      previousUsername: '1ailen389',
      currentUsername: '1ailen389',
      overwritten: false,
      createdClient: false,
      createdLink: false,
      movedFromPhone: null,
      deletedOldPhone: false
    });
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      {
        playerPhoneStore: store,
        asnUserExistsChecker: async () => undefined
      }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/assign-phone',
      payload: {
        pagina: 'ASN',
        usuario: '1ailen389',
        agente: 'luuucas10',
        contrasena_agente: 'secret',
        telefono: '+5493514867589',
        ownerContext: {
          ownerKey: 'wf_owner_9',
          ownerLabel: 'Lucas 10'
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      overwritten: false,
      previousUsername: '1ailen389',
      currentUsername: '1ailen389'
    });

    await server.close();
  });

  it('POST /users/assign-phone returns 409 when target username is already used', async () => {
    const queue = new FakeQueue();
    const store = new FakePlayerPhoneStore();
    store.assignByPhoneBehavior = async () => {
      throw new PlayerPhoneStoreError('CONFLICT', 'username already exists in this pagina', {
        reason: 'USERNAME_ALREADY_EXISTS_IN_PAGINA'
      });
    };
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      {
        playerPhoneStore: store,
        asnUserExistsChecker: async () => undefined
      }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/assign-phone',
      payload: {
        pagina: 'ASN',
        usuario: 'taken_username',
        agente: 'luuucas10',
        contrasena_agente: 'secret',
        telefono: '+5493514867589',
        ownerContext: {
          ownerKey: 'wf_owner_9',
          ownerLabel: 'Lucas 10'
        }
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      message: 'Ese usuario ya esta vinculado a otro numero dentro de ASN',
      code: 'USERNAME_ALREADY_EXISTS_IN_PAGINA'
    });

    await server.close();
  });

  it('POST /users/assign-phone returns 409 when phone already has another username for the owner', async () => {
    const queue = new FakeQueue();
    const store = new FakePlayerPhoneStore();
    store.assignByPhoneBehavior = async () => {
      throw new PlayerPhoneStoreError('CONFLICT', 'telefono already assigned for this owner', {
        reason: 'PHONE_ALREADY_ASSIGNED_FOR_OWNER'
      });
    };
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      {
        playerPhoneStore: store,
        asnUserExistsChecker: async () => undefined
      }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/assign-phone',
      payload: {
        pagina: 'ASN',
        usuario: 'taken_username',
        agente: 'luuucas10',
        contrasena_agente: 'secret',
        telefono: '+5493514867589',
        ownerContext: {
          ownerKey: 'wf_owner_9',
          ownerLabel: 'Lucas 10'
        }
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      message: 'Ese numero ya tiene otro usuario asignado para este cajero',
      code: 'PHONE_ALREADY_ASSIGNED_FOR_OWNER'
    });

    await server.close();
  });

  it('POST /users/assign-phone returns 404 when owner link does not exist', async () => {
    const queue = new FakeQueue();
    const store = new FakePlayerPhoneStore();
    store.assignByPhoneBehavior = async () => {
      throw new PlayerPhoneStoreError('NOT_FOUND', 'owner-client link does not exist', {
        reason: 'OWNER_CLIENT_LINK_NOT_FOUND'
      });
    };
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      {
        playerPhoneStore: store,
        asnUserExistsChecker: async () => undefined
      }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/assign-phone',
      payload: {
        pagina: 'ASN',
        usuario: 'taken_username',
        agente: 'luuucas10',
        contrasena_agente: 'secret',
        telefono: '+5493514867589',
        ownerContext: {
          ownerKey: 'wf_owner_9',
          ownerLabel: 'Lucas 10'
        }
      }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      message: 'No se encontro el cliente dentro de la cartera del cajero',
      code: 'OWNER_CLIENT_LINK_NOT_FOUND'
    });

    await server.close();
  });

  it('POST /users/assign-phone returns 400 for invalid phone format', async () => {
    const queue = new FakeQueue();
    const store = new FakePlayerPhoneStore();
    store.assignByPhoneBehavior = async () => {
      throw new PlayerPhoneStoreError('VALIDATION', 'telefono must follow strict E.164 format', {
        reason: 'INVALID_PHONE_FORMAT',
        details: { field: 'telefono', value: 'abc' }
      });
    };
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      {
        playerPhoneStore: store,
        asnUserExistsChecker: async () => undefined
      }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/assign-phone',
      payload: {
        pagina: 'ASN',
        usuario: 'player_1',
        agente: 'agent_1',
        contrasena_agente: 'secret',
        telefono: 'abc',
        ownerContext: {
          ownerKey: 'wf_owner_9',
          ownerLabel: 'Lucas 10'
        }
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      message: 'telefono must follow strict E.164 format',
      code: 'INVALID_PHONE_FORMAT',
      details: { field: 'telefono', value: 'abc' }
    });

    await server.close();
  });

  it('POST /users/unassign-phone validates payload and requires ownerContext', async () => {
    const queue = new FakeQueue();
    const store = new FakePlayerPhoneStore();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      {
        playerPhoneStore: store
      }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/unassign-phone',
      payload: {
        pagina: 'ASN',
        telefono: '+5491122334455'
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      message: 'Invalid payload',
      code: 'INVALID_PAYLOAD',
      details: {
        issues: [{ path: 'ownerContext', message: 'Invalid input: expected object, received undefined' }]
      }
    });
    expect(store.unassignByPhoneInputs).toHaveLength(0);

    await server.close();
  });

  it('POST /users/unassign-phone returns success and leaves client pending', async () => {
    const queue = new FakeQueue();
    const store = new FakePlayerPhoneStore();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      {
        playerPhoneStore: store
      }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/unassign-phone',
      payload: {
        pagina: 'ASN',
        telefono: '+5491122334455',
        ownerContext: {
          ownerKey: 'wf_owner_9',
          ownerLabel: 'Lucas 10'
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      previousUsername: 'player_1',
      currentStatus: 'pending',
      unlinked: true
    });
    expect(store.unassignByPhoneInputs).toHaveLength(1);

    await server.close();
  });

  it('POST /users/unassign-phone returns 404 when owner link does not exist', async () => {
    const queue = new FakeQueue();
    const store = new FakePlayerPhoneStore();
    store.unassignByPhoneBehavior = async () => {
      throw new PlayerPhoneStoreError('NOT_FOUND', 'owner-client link does not exist', {
        reason: 'OWNER_CLIENT_LINK_NOT_FOUND'
      });
    };
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      {
        playerPhoneStore: store
      }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/unassign-phone',
      payload: {
        pagina: 'ASN',
        telefono: '+5491122334455',
        ownerContext: {
          ownerKey: 'wf_owner_9',
          ownerLabel: 'Lucas 10'
        }
      }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      message: 'No se encontro el cliente dentro de la cartera del cajero',
      code: 'OWNER_CLIENT_LINK_NOT_FOUND'
    });

    await server.close();
  });

  it('POST /users/deposit returns 202 with job id', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { asnUserExistsChecker: allowAsnUserExists }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'RdA',
        operacion: 'carga',
        usuario: 'pruebita',
        agente: 'agent',
        contrasena_agente: 'secret',
        cantidad: 500
      }
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.status).toBe('queued');
    expect(body.statusUrl).toBe(`/jobs/${body.jobId}`);
    expect(queue.getById(body.jobId)?.jobType).toBe('deposit');
    const queued = queue.requests.find((item) => item.id === body.jobId);
    expect(queued?.jobType).toBe('deposit');
    if (queued?.jobType === 'deposit') {
      expect(queued.payload.pagina).toBe('RdA');
      expect(queued.payload.operacion).toBe('carga');
      expect(queued.options.headless).toBe(true);
      expect(queued.options.debug).toBe(false);
      expect(queued.options.slowMo).toBe(0);
      expect(queued.options.timeoutMs).toBe(15_000);
    }

    await server.close();
  });

  it('POST /users/deposit enqueues balance job for consultar_saldo', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { asnUserExistsChecker: allowAsnUserExists }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'RdA',
        operacion: 'consultar_saldo',
        usuario: 'pruebita',
        agente: 'agent',
        contrasena_agente: 'secret'
      }
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    const queued = queue.requests.find((item) => item.id === body.jobId);
    expect(queued?.jobType).toBe('balance');
    if (queued?.jobType === 'balance') {
      expect(queued.payload.pagina).toBe('RdA');
      expect(queued.payload.operacion).toBe('consultar_saldo');
      expect(queued.options.headless).toBe(true);
      expect(queued.options.debug).toBe(false);
      expect(queued.options.slowMo).toBe(0);
      expect(queued.options.timeoutMs).toBe(15_000);
    }

    await server.close();
  });

  it('POST /users/deposit enqueues ASN report job for reporte', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { asnUserExistsChecker: allowAsnUserExists }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'ASN',
        operacion: 'reporte',
        usuario: 'Ariel728',
        agente: 'luuucas10',
        contrasena_agente: 'australopitecus12725'
      }
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    const queued = queue.requests.find((item) => item.id === body.jobId);
    expect(queued?.jobType).toBe('report');
    if (queued?.jobType === 'report') {
      expect(queued.payload.pagina).toBe('ASN');
      expect(queued.payload.operacion).toBe('reporte');
      expect(queued.payload.usuario).toBe('Ariel728');
      expect(queued.options.headless).toBe(true);
      expect(queued.options.debug).toBe(false);
      expect(queued.options.slowMo).toBe(0);
      expect(queued.options.timeoutMs).toBe(15_000);
    }

    await server.close();
  });

  it('POST /users/deposit keeps explicit execution overrides', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { asnUserExistsChecker: allowAsnUserExists }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'RdA',
        operacion: ' DescARGA ',
        usuario: 'pruebita',
        agente: 'agent',
        contrasena_agente: 'secret',
        cantidad: 500,
        headless: false,
        debug: true,
        slowMo: 55,
        timeoutMs: 28_000
      }
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    const queued = queue.requests.find((item) => item.id === body.jobId);
    expect(queued?.jobType).toBe('deposit');
    if (queued?.jobType === 'deposit') {
      expect(queued.payload.operacion).toBe('descarga');
      expect(queued.options.headless).toBe(false);
      expect(queued.options.debug).toBe(true);
      expect(queued.options.slowMo).toBe(55);
      expect(queued.options.timeoutMs).toBe(28_000);
    }

    await server.close();
  });

  it('POST /users/deposit enqueues ASN deposit job for carga', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { asnUserExistsChecker: allowAsnUserExists }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'ASN',
        operacion: 'carga',
        usuario: 'pruebita',
        agente: 'agent',
        contrasena_agente: 'secret',
        cantidad: 10
      }
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    const queued = queue.requests.find((item) => item.id === body.jobId);
    expect(queued?.jobType).toBe('deposit');
    if (queued?.jobType === 'deposit') {
      expect(queued.payload.pagina).toBe('ASN');
      expect(queued.payload.operacion).toBe('carga');
      expect(queued.payload.cantidad).toBe(10);
    }

    await server.close();
  });

  it('POST /users/deposit enqueues ASN deposit and balance jobs for remaining operations', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { asnUserExistsChecker: allowAsnUserExists }
    );

    const descargaResponse = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'ASN',
        operacion: 'descarga',
        usuario: 'usuario1',
        agente: 'agent',
        contrasena_agente: 'secret',
        cantidad: 5
      }
    });

    const descargaTotalResponse = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'ASN',
        operacion: 'descarga_total',
        usuario: 'usuario1',
        agente: 'agent',
        contrasena_agente: 'secret'
      }
    });

    const balanceResponse = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'ASN',
        operacion: 'consultar_saldo',
        usuario: 'usuario1',
        agente: 'agent',
        contrasena_agente: 'secret'
      }
    });

    expect(descargaResponse.statusCode).toBe(202);
    expect(descargaTotalResponse.statusCode).toBe(202);
    expect(balanceResponse.statusCode).toBe(202);

    const descargaJob = queue.requests.find((item) => item.id === descargaResponse.json().jobId);
    const descargaTotalJob = queue.requests.find((item) => item.id === descargaTotalResponse.json().jobId);
    const balanceJob = queue.requests.find((item) => item.id === balanceResponse.json().jobId);

    expect(descargaJob?.jobType).toBe('deposit');
    if (descargaJob?.jobType === 'deposit') {
      expect(descargaJob.payload.pagina).toBe('ASN');
      expect(descargaJob.payload.operacion).toBe('descarga');
      expect(descargaJob.payload.cantidad).toBe(5);
    }

    expect(descargaTotalJob?.jobType).toBe('deposit');
    if (descargaTotalJob?.jobType === 'deposit') {
      expect(descargaTotalJob.payload.pagina).toBe('ASN');
      expect(descargaTotalJob.payload.operacion).toBe('descarga_total');
      expect(descargaTotalJob.payload.cantidad).toBeUndefined();
    }

    expect(balanceJob?.jobType).toBe('balance');
    if (balanceJob?.jobType === 'balance') {
      expect(balanceJob.payload.pagina).toBe('ASN');
      expect(balanceJob.payload.operacion).toBe('consultar_saldo');
    }

    await server.close();
  });

  it('POST /users/deposit returns 404 immediately for missing ASN users and does not enqueue jobs', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      {
        asnUserExistsChecker: async () => {
          throw new AsnUserCheckError('NOT_FOUND', 'El usuario no existe');
        }
      }
    );

    const operations = ['consultar_saldo', 'carga', 'descarga', 'descarga_total'] as const;
    for (const operacion of operations) {
      const response = await server.inject({
        method: 'POST',
        url: '/users/deposit',
        payload: {
          pagina: 'ASN',
          operacion,
          usuario: 'missing_user',
          agente: 'agent',
          contrasena_agente: 'secret',
          ...(operacion === 'carga' || operacion === 'descarga' ? { cantidad: 25 } : {})
        }
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        message: 'No se ha encontrado el usuario missing_user',
        code: 'ASN_USER_NOT_FOUND',
        details: { usuario: 'missing_user' }
      });
    }

    expect(queue.requests).toHaveLength(0);

    await server.close();
  });

  it('POST /users/deposit keeps enqueuing ASN jobs when the user precheck is inconclusive', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      {
        asnUserExistsChecker: async () => {
          throw new AsnUserCheckError('INTERNAL', 'Could not verify ASN user existence');
        }
      }
    );

    const operations = ['consultar_saldo', 'carga', 'descarga', 'descarga_total'] as const;
    for (const operacion of operations) {
      const response = await server.inject({
        method: 'POST',
        url: '/users/deposit',
        payload: {
          pagina: 'ASN',
          operacion,
          usuario: 'existing_user',
          agente: 'agent',
          contrasena_agente: 'secret',
          ...(operacion === 'carga' || operacion === 'descarga' ? { cantidad: 25 } : {})
        }
      });

      expect(response.statusCode).toBe(202);
    }

    expect(queue.requests).toHaveLength(4);

    await server.close();
  });

  it('POST /users/deposit does not run ASN user precheck for reporte', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      {
        asnUserExistsChecker: async () => {
          throw new AsnUserCheckError('INTERNAL', 'Should not run for reporte');
        }
      }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'ASN',
        operacion: 'reporte',
        usuario: 'ignored_for_report',
        agente: 'agent',
        contrasena_agente: 'secret'
      }
    });

    expect(response.statusCode).toBe(202);
    expect(queue.requests).toHaveLength(1);
    expect(queue.requests[0]?.jobType).toBe('report');

    await server.close();
  });

  it('POST /users/deposit returns 501 for reporte on non-ASN pagina', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'RdA',
        operacion: 'reporte',
        usuario: 'Ariel728',
        agente: 'agent',
        contrasena_agente: 'secret'
      }
    });

    expect(response.statusCode).toBe(501);
    expect(response.json().message).toMatch(/only for ASN/i);
    expect(queue.requests).toHaveLength(0);

    await server.close();
  });

  it('POST /users/deposit keeps explicit execution overrides for consultar_saldo', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'RdA',
        operacion: 'consultar saldo',
        usuario: 'pruebita',
        agente: 'agent',
        contrasena_agente: 'secret',
        headless: true,
        debug: true,
        slowMo: 33,
        timeoutMs: 18_000
      }
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    const queued = queue.requests.find((item) => item.id === body.jobId);
    expect(queued?.jobType).toBe('balance');
    if (queued?.jobType === 'balance') {
      expect(queued.payload.operacion).toBe('consultar_saldo');
      expect(queued.options.headless).toBe(true);
      expect(queued.options.debug).toBe(true);
      expect(queued.options.slowMo).toBe(33);
      expect(queued.options.timeoutMs).toBe(18_000);
    }

    await server.close();
  });

  it('POST /users/deposit validates payload', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { asnUserExistsChecker: allowAsnUserExists }
    );

    const aliasOperationResponse = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'RdA',
        operacion: 'retiro',
        usuario: 'pruebita',
        agente: 'agent',
        contrasena_agente: 'secret',
        cantidad: 500
      }
    });

    expect(aliasOperationResponse.statusCode).toBe(202);
    const aliasBody = aliasOperationResponse.json();
    const aliasQueued = queue.requests.find((item) => item.id === aliasBody.jobId);
    expect(aliasQueued?.jobType).toBe('deposit');
    if (aliasQueued?.jobType === 'deposit') {
      expect(aliasQueued.payload.operacion).toBe('descarga');
    }

    const totalOperationResponse = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'RdA',
        operacion: 'descarga_total',
        usuario: 'pruebita',
        agente: 'agent',
        contrasena_agente: 'secret'
      }
    });

    expect(totalOperationResponse.statusCode).toBe(202);
    const totalBody = totalOperationResponse.json();
    const totalQueued = queue.requests.find((item) => item.id === totalBody.jobId);
    expect(totalQueued?.jobType).toBe('deposit');
    if (totalQueued?.jobType === 'deposit') {
      expect(totalQueued.payload.operacion).toBe('descarga_total');
      expect(totalQueued.payload.cantidad).toBeUndefined();
    }

    const totalAliasOperationResponse = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'RdA',
        operacion: 'retiro_total',
        usuario: 'pruebita',
        agente: 'agent',
        contrasena_agente: 'secret'
      }
    });

    expect(totalAliasOperationResponse.statusCode).toBe(202);
    const totalAliasBody = totalAliasOperationResponse.json();
    const totalAliasQueued = queue.requests.find((item) => item.id === totalAliasBody.jobId);
    expect(totalAliasQueued?.jobType).toBe('deposit');
    if (totalAliasQueued?.jobType === 'deposit') {
      expect(totalAliasQueued.payload.operacion).toBe('descarga_total');
      expect(totalAliasQueued.payload.cantidad).toBeUndefined();
    }

    const balanceOperationResponse = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'RdA',
        operacion: 'consultar_saldo',
        usuario: 'pruebita',
        agente: 'agent',
        contrasena_agente: 'secret'
      }
    });

    expect(balanceOperationResponse.statusCode).toBe(202);
    const balanceBody = balanceOperationResponse.json();
    const balanceQueued = queue.requests.find((item) => item.id === balanceBody.jobId);
    expect(balanceQueued?.jobType).toBe('balance');
    if (balanceQueued?.jobType === 'balance') {
      expect(balanceQueued.payload.operacion).toBe('consultar_saldo');
    }

    const balanceAliasOperationResponse = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'RdA',
        operacion: 'consultar saldo',
        usuario: 'pruebita',
        agente: 'agent',
        contrasena_agente: 'secret'
      }
    });

    expect(balanceAliasOperationResponse.statusCode).toBe(202);
    const balanceAliasBody = balanceAliasOperationResponse.json();
    const balanceAliasQueued = queue.requests.find((item) => item.id === balanceAliasBody.jobId);
    expect(balanceAliasQueued?.jobType).toBe('balance');
    if (balanceAliasQueued?.jobType === 'balance') {
      expect(balanceAliasQueued.payload.operacion).toBe('consultar_saldo');
    }

    const reportOperationResponse = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'ASN',
        operacion: 'report',
        usuario: 'Ariel728',
        agente: 'luuucas10',
        contrasena_agente: 'australopitecus12725'
      }
    });

    expect(reportOperationResponse.statusCode).toBe(202);
    const reportBody = reportOperationResponse.json();
    const reportQueued = queue.requests.find((item) => item.id === reportBody.jobId);
    expect(reportQueued?.jobType).toBe('report');
    if (reportQueued?.jobType === 'report') {
      expect(reportQueued.payload.operacion).toBe('reporte');
    }

    const badOperationResponse = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'RdA',
        operacion: 'transferencia',
        usuario: 'pruebita',
        agente: 'agent',
        contrasena_agente: 'secret',
        cantidad: 500
      }
    });

    expect(badOperationResponse.statusCode).toBe(400);

    const badAmountResponse = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'RdA',
        operacion: 'carga',
        usuario: 'pruebita',
        agente: 'agent',
        contrasena_agente: 'secret',
        cantidad: 0
      }
    });

    expect(badAmountResponse.statusCode).toBe(400);

    const missingAmountForDescargaResponse = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'RdA',
        operacion: 'descarga',
        usuario: 'pruebita',
        agente: 'agent',
        contrasena_agente: 'secret'
      }
    });

    expect(missingAmountForDescargaResponse.statusCode).toBe(400);

    const missingAmountForCargaResponse = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'RdA',
        operacion: 'carga',
        usuario: 'pruebita',
        agente: 'agent',
        contrasena_agente: 'secret'
      }
    });

    expect(missingAmountForCargaResponse.statusCode).toBe(400);

    await server.close();
  });

  it('POST /users/deposit normalizes pagina aliases', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        pagina: 'rda',
        operacion: 'consultar_saldo',
        usuario: 'pruebita',
        agente: 'monchi30',
        contrasena_agente: '123mon'
      }
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    const queued = queue.requests.find((item) => item.id === body.jobId);
    expect(queued?.jobType).toBe('balance');
    if (queued?.jobType === 'balance') {
      expect(queued.payload.pagina).toBe('RdA');
    }

    await server.close();
  });

  it('POST /users/deposit requires pagina', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/deposit',
      payload: {
        operacion: 'carga',
        usuario: 'pruebita',
        agente: 'monchi30',
        contrasena_agente: '123mon',
        cantidad: 100
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().issues.some((issue: { path: string }) => issue.path === 'pagina')).toBe(true);
    await server.close();
  });

  it('GET /jobs/:id returns 404 when missing', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue
    );

    const response = await server.inject({
      method: 'GET',
      url: '/jobs/missing'
    });

    expect(response.statusCode).toBe(404);
    await server.close();
  });

  it('GET /jobs/:id returns create-player result payload when available', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue
    );

    const id = 'job-create-player-result';
    queue.entries.set(id, {
      id,
      jobType: 'create-player',
      status: 'succeeded',
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      artifactPaths: [],
      steps: [],
      result: {
        kind: 'create-player',
        pagina: 'ASN',
        requestedUsername: 'Pepito47',
        createdUsername: 'Pepito471',
        createdPassword: 'PepitoPass123',
        attempts: 2
      }
    });

    const response = await server.inject({
      method: 'GET',
      url: `/jobs/${id}`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().result).toEqual({
      kind: 'create-player',
      pagina: 'ASN',
      requestedUsername: 'Pepito47',
      createdUsername: 'Pepito471',
      createdPassword: 'PepitoPass123',
      attempts: 2
    });

    await server.close();
  });

  it('GET /jobs/:id returns ASN report result payload when available', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue
    );

    const id = 'job-asn-report-result';
    queue.entries.set(id, {
      id,
      jobType: 'report',
      status: 'succeeded',
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      artifactPaths: [],
      steps: [],
      result: {
        kind: 'asn-reporte-cargado-mes',
        pagina: 'ASN',
        usuario: 'Ariel728',
        mesActual: '2026-03',
        fechaActual: '2026-03-09',
        cargadoTexto: '40.000,00',
        cargadoNumero: 40000,
        cargadoHoyTexto: '0,00',
        cargadoHoyNumero: 0
      }
    });

    const response = await server.inject({
      method: 'GET',
      url: `/jobs/${id}`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().result).toEqual({
      kind: 'asn-reporte-cargado-mes',
      pagina: 'ASN',
      usuario: 'Ariel728',
      mesActual: '2026-03',
      fechaActual: '2026-03-09',
      cargadoTexto: '40.000,00',
      cargadoNumero: 40000,
      cargadoHoyTexto: '0,00',
      cargadoHoyNumero: 0
    });

    await server.close();
  });

  it('GET /jobs/:id returns ASN funds operation result payload when available', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue
    );

    const id = 'job-asn-funds-result';
    queue.entries.set(id, {
      id,
      jobType: 'deposit',
      status: 'succeeded',
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      artifactPaths: [],
      steps: [],
      result: {
        kind: 'asn-funds-operation',
        pagina: 'ASN',
        operacion: 'carga',
        usuario: 'Monica626',
        montoSolicitado: 500,
        montoAplicado: 500,
        montoAplicadoTexto: '500,00',
        saldoAntesNumero: 1000,
        saldoAntesTexto: '1.000,00',
        saldoDespuesNumero: 1500,
        saldoDespuesTexto: '1.500,00'
      }
    });

    const response = await server.inject({
      method: 'GET',
      url: `/jobs/${id}`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().result).toEqual({
      kind: 'asn-funds-operation',
      pagina: 'ASN',
      operacion: 'carga',
      usuario: 'Monica626',
      montoSolicitado: 500,
      montoAplicado: 500,
      montoAplicadoTexto: '500,00',
      saldoAntesNumero: 1000,
      saldoAntesTexto: '1.000,00',
      saldoDespuesNumero: 1500,
      saldoDespuesTexto: '1.500,00'
    });

    await server.close();
  });

  it('GET /jobs/:id returns ASN balance result payload when available', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue
    );

    const id = 'job-asn-balance-result';
    queue.entries.set(id, {
      id,
      jobType: 'balance',
      status: 'succeeded',
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      artifactPaths: [],
      steps: [],
      result: {
        kind: 'asn-balance',
        pagina: 'ASN',
        operacion: 'consultar_saldo',
        usuario: 'Carolina225',
        saldoTexto: '30.525,35',
        saldoNumero: 30525.35
      }
    });

    const response = await server.inject({
      method: 'GET',
      url: `/jobs/${id}`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().result).toEqual({
      kind: 'asn-balance',
      pagina: 'ASN',
      operacion: 'consultar_saldo',
      usuario: 'Carolina225',
      saldoTexto: '30.525,35',
      saldoNumero: 30525.35
    });

    await server.close();
  });
});
