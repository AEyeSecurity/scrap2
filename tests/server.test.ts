import { describe, expect, it, vi } from 'vitest';
import { AsnUserCheckError } from '../src/asn-user-check';
import { buildAppConfig } from '../src/config';
import { createLogger } from '../src/logging';
import { RdaUserCheckError } from '../src/rda-user-check';
import {
  MastercrmUserStoreError,
  type DeleteMastercrmMarketingBudgetInput,
  type GetMastercrmAnalyticsInput,
  type DistributeMastercrmMarketingBudgetsInput,
  type MastercrmClientsDashboardRecord,
  type MastercrmAnalyticsRecord,
  type MastercrmMarketingBudgetRecord,
  type MastercrmUserCashierLinkRecord,
  type MastercrmUserStore,
  type UpsertMastercrmMarketingBudgetInput
} from '../src/mastercrm-user-store';
import { issueMastercrmSessionToken, verifyMastercrmSessionToken } from '../src/mastercrm-session';
import { normalizeLandingMessageKey, type LandingSessionRecord, type LandingSessionStore } from '../src/landing-session-store';
import type { MetaConversionsDispatcher, MetaDispatchResult } from '../src/meta-conversions';
import type { MetaConversionLease, MetaConversionsStore } from '../src/meta-conversions-store';
import { PlayerPhoneStoreError, type PlayerPhoneStore } from '../src/player-phone-store';
import { createServer } from '../src/server';
import type { JobRequest, JobStoreEntry } from '../src/types';

const allowAsnUserExists = async (): Promise<void> => undefined;
const MASTERCRM_TEST_SESSION_SECRET = 'server-test-mastercrm-session-secret-32';
const MASTERCRM_TEST_STAFF_PASSWORD = 'staff-secret';

process.env.MASTERCRM_SESSION_SECRET = MASTERCRM_TEST_SESSION_SECRET;
process.env.MASTERCRM_STAFF_LINK_PASSWORD = MASTERCRM_TEST_STAFF_PASSWORD;

function mastercrmAuthorization(userId: number, username = 'juan'): { authorization: string } {
  const session = issueMastercrmSessionToken(
    {
      id: userId,
      username,
      nombre: 'Test User',
      telefono: null,
      inversion: 0,
      isActive: true,
      createdAt: '2026-06-06T00:00:00.000Z'
    },
    MASTERCRM_TEST_SESSION_SECRET
  );

  return { authorization: `Bearer ${session.token}` };
}

async function withEnv<T>(values: Record<string, string | undefined>, callback: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

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
      clientIpAddress?: string | null;
      clientUserAgent?: string | null;
      receivedAt?: string | null;
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

  public readonly resolveOwnerContextByPhoneInputs: Array<{
    pagina: 'RdA' | 'ASN';
    telefono: string;
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

  public resolveOwnerContextByPhoneBehavior: (input: { pagina: 'RdA' | 'ASN'; telefono: string }) => Promise<{
    ownerKey: string;
    ownerLabel: string;
    actorAlias: string;
    actorPhone: string | null;
  } | null> = async () => null;

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
      clientIpAddress?: string | null;
      clientUserAgent?: string | null;
      receivedAt?: string | null;
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

  async resolveOwnerContextByPhone(input: {
    pagina: 'RdA' | 'ASN';
    telefono: string;
  }): Promise<{
    ownerKey: string;
    ownerLabel: string;
    actorAlias: string;
    actorPhone: string | null;
  } | null> {
    this.resolveOwnerContextByPhoneInputs.push(input);
    return this.resolveOwnerContextByPhoneBehavior(input);
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

class FakeLandingSessionStore implements LandingSessionStore {
  public readonly createInputs: Parameters<LandingSessionStore['createSession']>[0][] = [];
  public readonly claimInputs: Parameters<LandingSessionStore['claimPendingSession']>[0][] = [];
  public readonly sessions: LandingSessionRecord[] = [];

  async createSession(input: Parameters<LandingSessionStore['createSession']>[0]): Promise<LandingSessionRecord> {
    this.createInputs.push(input);
    const row: LandingSessionRecord = {
      id: `landing-session-${this.sessions.length + 1}`,
      landingSessionId: input.landingSessionId,
      contactEventId: input.contactEventId,
      messageText: input.messageText,
      messageKey: input.messageKey,
      status: 'pending',
      pagina: input.pagina,
      ownerKey: input.ownerContext.ownerKey,
      ownerLabel: input.ownerContext.ownerLabel,
      landingVariant: input.landingVariant ?? null,
      botPhoneE164: input.botPhoneE164,
      cashierPhoneE164: input.cashierPhoneE164,
      fbp: input.fbp ?? null,
      fbc: input.fbc ?? null,
      fbclid: input.fbclid ?? null,
      eventSourceUrl: input.eventSourceUrl ?? null,
      referrer: input.referrer ?? null,
      utmSource: input.utmSource ?? null,
      utmMedium: input.utmMedium ?? null,
      utmId: input.utmId ?? null,
      utmCampaign: input.utmCampaign ?? null,
      utmContent: input.utmContent ?? null,
      utmTerm: input.utmTerm ?? null,
      adsetId: input.adsetId ?? null,
      adId: input.adId ?? null,
      placement: input.placement ?? null,
      clientIpAddress: input.clientIpAddress ?? null,
      clientUserAgent: input.clientUserAgent ?? null,
      whatsappUrl: input.whatsappUrl,
      createdAt: '2026-06-03T15:00:00.000Z',
      claimedAt: null,
      claimedPhoneE164: null,
      claimedMessageSid: null
    };
    this.sessions.push(row);
    return row;
  }

  async claimPendingSession(input: Parameters<LandingSessionStore['claimPendingSession']>[0]): Promise<LandingSessionRecord | null> {
    this.claimInputs.push(input);
    const messageKey = normalizeLandingMessageKey(input.messageText);
    const session = this.sessions.find((item) => item.status === 'pending' && item.messageKey === messageKey);
    if (!session) {
      return null;
    }

    session.status = 'claimed';
    session.claimedAt = input.claimedAt ?? '2026-06-03T15:01:00.000Z';
    session.claimedPhoneE164 = input.phoneE164;
    session.claimedMessageSid = input.messageSid ?? null;
    return session;
  }
}

class FakeMetaConversionsStore implements MetaConversionsStore {
  public readonly leadInputs: Array<{
    ownerId: string;
    clientId: string;
    phoneE164: string;
    ownerContext: { ownerKey: string; ownerLabel: string };
    sourceContext: Record<string, unknown>;
    customerData?: Record<string, unknown> | null;
    eventTime?: string;
  }> = [];
  public readonly landingLeadInputs: Array<{
    ownerId: string;
    clientId: string;
    phoneE164: string;
    ownerContext: { ownerKey: string; ownerLabel: string };
    sourceContext: Record<string, unknown>;
    customerData?: Record<string, unknown> | null;
    eventTime?: string;
  }> = [];

  async enqueueLead(input: {
    ownerId: string;
    clientId: string;
    phoneE164: string;
    ownerContext: { ownerKey: string; ownerLabel: string };
    sourceContext: Record<string, unknown>;
    customerData?: Record<string, unknown> | null;
    eventTime?: string;
  }): Promise<void> {
    this.leadInputs.push(input);
  }

  async enqueueLandingLead(input: {
    ownerId: string;
    clientId: string;
    phoneE164: string;
    ownerContext: { ownerKey: string; ownerLabel: string };
    sourceContext: Record<string, unknown>;
    customerData?: Record<string, unknown> | null;
    eventTime?: string;
  }): Promise<void> {
    this.landingLeadInputs.push(input);
  }

  async scanForValueSignals(_limit: number): Promise<number> {
    return 0;
  }

  async leaseNextEvent(_leaseSeconds: number, _maxAttempts: number): Promise<null> {
    return null;
  }

  async markSent(_input: { id: string }): Promise<void> {
    // no-op
  }

  async markRetry(_input: { id: string; error: string; retryAfterSeconds: number }): Promise<void> {
    // no-op
  }

  async markFailed(_input: { id: string; error: string }): Promise<void> {
    // no-op
  }
}

class FakeLandingMetaConversionsDispatcher implements MetaConversionsDispatcher {
  public readonly leases: MetaConversionLease[] = [];

  async dispatch(lease: MetaConversionLease): Promise<MetaDispatchResult> {
    this.leases.push(lease);
    return {
      requestBody: { data: [{ event_name: lease.metaEventName }] },
      responseStatus: 200,
      responseBody: { events_received: 1 },
      fbtraceId: 'TRACE123'
    };
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
  public readonly analyticsInputs: GetMastercrmAnalyticsInput[] = [];
  public readonly marketingBudgetInputs: UpsertMastercrmMarketingBudgetInput[] = [];
  public readonly distributeMarketingBudgetInputs: DistributeMastercrmMarketingBudgetsInput[] = [];
  public readonly deleteMarketingBudgetInputs: DeleteMastercrmMarketingBudgetInput[] = [];

  public readonly linkInputs: Array<{
    userId: number;
    ownerKey: string;
    pagina: 'ASN' | 'RdA';
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
    pagina: 'ASN' | 'RdA';
  }) => Promise<MastercrmUserCashierLinkRecord> = async (input) => ({
    userId: input.userId,
    ownerKey: input.ownerKey,
    ownerLabel: 'Owner Label',
    pagina: input.pagina,
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
      reingresosMes: 0,
      asignacionesMes: 0,
      asignacionesBacklogMes: 0,
      tasaIntakeAsignacionPct: null,
      clientesConReporte: 0,
      promedioCargaGeneralArs: null,
      tasaActivacionPct: null
    },
    monthlyFlowKpis: {
      intakesMes: 0,
      reingresosMes: 0,
      asignacionesMes: 0,
      asignacionesBacklogMes: 0,
      tasaIntakeAsignacionPct: null
    },
    closingPortfolioKpis: {
      clientesTotales: 0,
      asignados: 0,
      pendientes: 0,
      cargadoHoyArs: null,
      cargadoMesArs: null,
      clientesConReporte: 0,
      promedioCargaGeneralArs: null,
      tasaActivacionPct: null
    },
    charts: {
      monthlyTrend: []
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

  public getMarketingAnalyticsBehavior: (input: GetMastercrmAnalyticsInput) => Promise<MastercrmAnalyticsRecord> = async (input) => ({
    linkedOwner: null,
    filters: {
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      channel: input.channel ?? 'all',
      campaignKey: input.campaignKey ?? null,
      adKey: input.adKey ?? null
    },
    summary: {
      investmentArs: 0,
      revenueArs: 0,
      estimatedProfitArs: null,
      roiPct: null,
      roas: null,
      leads: 0,
      assigned: 0,
      depositors: 0,
      cplArs: null,
      costPerDepositorArs: null,
      leadToAssignedPct: null,
      leadToDepositorPct: null,
      averageRevenueArs: null
    },
    channels: [],
    campaigns: [],
    ads: [],
    clients: [],
    budgets: [],
    audit: {
      unknownLeads: 0,
      landingUnmatchedLeads: 0,
      excludedLeads: 0,
      reentryLeads: 0,
      missingBudgetCampaigns: 0,
      missingBudgetAds: 0,
      negativeAdjustments: []
    }
  });

  public upsertMarketingBudgetBehavior: (input: UpsertMastercrmMarketingBudgetInput) => Promise<MastercrmMarketingBudgetRecord> = async (input) => ({
    id: input.id ?? 'budget-1',
    channel: input.channel,
    level: input.level,
    campaignKey: input.campaignKey,
    campaignName: input.campaignName,
    adKey: input.level === 'ad' ? input.adKey ?? null : null,
    adName: input.adName ?? null,
    linkUrl: input.linkUrl ?? null,
    dailyBudgetArs: input.dailyBudgetArs,
    activeFrom: input.activeFrom,
    activeTo: input.activeTo ?? null,
    effectiveSpendArs: input.dailyBudgetArs,
    updatedAt: '2026-06-18T12:00:00.000Z'
  });

  public distributeMarketingBudgetsBehavior: (
    input: DistributeMastercrmMarketingBudgetsInput
  ) => Promise<MastercrmMarketingBudgetRecord[]> = async (input) =>
    input.ads.map((ad, index) => ({
      id: `budget-${index + 1}`,
      channel: ad.channel,
      level: 'ad',
      campaignKey: ad.campaignKey,
      campaignName: ad.campaignName,
      adKey: ad.adKey,
      adName: ad.adName ?? null,
      linkUrl: ad.linkUrl ?? null,
      dailyBudgetArs: input.totalDailyBudgetArs / input.ads.length,
      activeFrom: input.activeFrom,
      activeTo: input.activeTo ?? null,
      effectiveSpendArs: input.totalDailyBudgetArs / input.ads.length,
      updatedAt: '2026-06-18T12:00:00.000Z'
    }));

  public deleteMarketingBudgetBehavior: (input: DeleteMastercrmMarketingBudgetInput) => Promise<{ deleted: true; id: string }> = async (input) => ({
    deleted: true,
    id: input.budgetId
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
    pagina: 'ASN' | 'RdA';
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

  async getMarketingAnalytics(input: GetMastercrmAnalyticsInput): Promise<MastercrmAnalyticsRecord> {
    this.analyticsInputs.push(input);
    return this.getMarketingAnalyticsBehavior(input);
  }

  async upsertMarketingBudget(input: UpsertMastercrmMarketingBudgetInput): Promise<MastercrmMarketingBudgetRecord> {
    this.marketingBudgetInputs.push(input);
    return this.upsertMarketingBudgetBehavior(input);
  }

  async distributeMarketingBudgets(
    input: DistributeMastercrmMarketingBudgetsInput
  ): Promise<MastercrmMarketingBudgetRecord[]> {
    this.distributeMarketingBudgetInputs.push(input);
    return this.distributeMarketingBudgetsBehavior(input);
  }

  async deleteMarketingBudget(input: DeleteMastercrmMarketingBudgetInput): Promise<{ deleted: true; id: string }> {
    this.deleteMarketingBudgetInputs.push(input);
    return this.deleteMarketingBudgetBehavior(input);
  }
}

describe('server routes', () => {
  it('keeps serving when technical retention is enabled but Supabase config is missing', async () => {
    await withEnv({ SUPABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined }, async () => {
      const queue = new FakeQueue();
      const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
      const logger = createLogger('silent', false);
      const errorSpy = vi.spyOn(logger, 'error');
      const server = createServer(
        appConfig,
        { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
        logger,
        queue,
        {
          asnUserExistsChecker: allowAsnUserExists,
          metaWorkerEnabled: false,
          reportWorkerEnabled: false,
          retentionWorkerEnabled: true
        }
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
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(Error) }),
        'MasterCRM technical retention worker could not start'
      );

      await server.close();
    });
  });

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
        telefono: '54911',
        staff_password: MASTERCRM_TEST_STAFF_PASSWORD
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
        nombre: 'Juan Perez',
        staff_password: MASTERCRM_TEST_STAFF_PASSWORD
      }
    });

    expect(response.statusCode).toBe(409);

    await server.close();
  });

  it('POST /mastercrm-register rejects an invalid staff password', async () => {
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
        usuario: 'juan',
        contrasena: 'secret123',
        nombre: 'Juan Perez',
        staff_password: 'wrong-secret'
      }
    });

    expect(response.statusCode).toBe(403);
    expect(store.createInputs).toHaveLength(0);

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
    expect(response.json()).toMatchObject({
      id: 101,
      usuario: 'juan',
      nombre: 'Juan Perez',
      telefono: '54911',
      created_at: '2026-03-10T12:00:00.000Z',
      inversion: 150000,
      token_type: 'Bearer',
      expires_in: 28800
    });
    expect(
      verifyMastercrmSessionToken(response.json().access_token, MASTERCRM_TEST_SESSION_SECRET)
    ).toMatchObject({ userId: 101, username: 'juan' });

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

  it('POST /mastercrm-clients requires a bearer token', async () => {
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
      url: '/mastercrm-clients',
      payload: { user_id: 101 }
    });

    expect(response.statusCode).toBe(401);
    expect(store.dashboardInputs).toHaveLength(0);

    await server.close();
  });

  it('POST /mastercrm-clients rejects access to another user id', async () => {
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
      url: '/mastercrm-clients',
      headers: mastercrmAuthorization(101),
      payload: { user_id: 202 }
    });

    expect(response.statusCode).toBe(403);
    expect(store.dashboardInputs).toHaveLength(0);

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
        reingresosMes: 1,
        asignacionesMes: 2,
        asignacionesBacklogMes: 1,
        tasaIntakeAsignacionPct: 50,
        clientesConReporte: 2,
        promedioCargaGeneralArs: 1866.67,
        tasaActivacionPct: 100
      },
      monthlyFlowKpis: {
        intakesMes: 4,
        reingresosMes: 1,
        asignacionesMes: 2,
        asignacionesBacklogMes: 1,
        tasaIntakeAsignacionPct: 50
      },
      closingPortfolioKpis: {
        clientesTotales: 3,
        asignados: 2,
        pendientes: 1,
        cargadoHoyArs: 1200,
        cargadoMesArs: 5600,
        clientesConReporte: 2,
        promedioCargaGeneralArs: 1866.67,
        tasaActivacionPct: 100
      },
      monthlyFlowKpis: {
        intakesMes: 4,
        reingresosMes: 1,
        asignacionesMes: 2,
        asignacionesBacklogMes: 1,
        tasaIntakeAsignacionPct: 50
      },
      closingPortfolioKpis: {
        clientesTotales: 3,
        asignados: 2,
        pendientes: 1,
        cargadoHoyArs: 1200,
        cargadoMesArs: 5600,
        clientesConReporte: 2,
        promedioCargaGeneralArs: 1866.67,
        tasaActivacionPct: 100
      },
      monthlyFlowKpis: {
        intakesMes: 4,
        reingresosMes: 1,
        asignacionesMes: 2,
        asignacionesBacklogMes: 1,
        tasaIntakeAsignacionPct: 50
      },
      closingPortfolioKpis: {
        clientesTotales: 3,
        asignados: 2,
        pendientes: 1,
        cargadoHoyArs: 1200,
        cargadoMesArs: 5600,
        clientesConReporte: 2,
        promedioCargaGeneralArs: 1866.67,
        tasaActivacionPct: 100
      },
      charts: {
        monthlyTrend: [
          { month: '2025-10', reportDate: null, cargadoMesArs: null },
          { month: '2025-11', reportDate: null, cargadoMesArs: null },
          { month: '2025-12', reportDate: null, cargadoMesArs: null },
          { month: '2026-01', reportDate: '2026-01-31', cargadoMesArs: 4100 },
          { month: '2026-02', reportDate: '2026-02-28', cargadoMesArs: 4700 },
          { month: '2026-03', reportDate: '2026-03-15', cargadoMesArs: 5600 }
        ]
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
          firstSeenAt: '2026-03-02T13:15:00.000Z',
          cargadoHoy: 600,
          cargadoMes: 2800,
          reportDate: '2026-03-12',
          isNewIntakeMes: true,
          isReingresoMes: false,
          assignedEnMes: true,
          assignedDesdeBacklogMes: false
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
      headers: mastercrmAuthorization(101),
      payload: { id: 101, month: '2026-03' }
    });
    const responseFromUserId = await server.inject({
      method: 'POST',
      url: '/mastercrm-clients',
      headers: mastercrmAuthorization(202),
      payload: { user_id: 202 }
    });
    const responseFromUsuarioId = await server.inject({
      method: 'POST',
      url: '/mastercrm-clients',
      headers: mastercrmAuthorization(303),
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
        reingresosMes: 1,
        asignacionesMes: 2,
        asignacionesBacklogMes: 1,
        tasaIntakeAsignacionPct: 50,
        clientesConReporte: 2,
        promedioCargaGeneralArs: 1866.67,
        tasaActivacionPct: 100
      },
      monthlyFlowKpis: {
        intakesMes: 4,
        reingresosMes: 1,
        asignacionesMes: 2,
        asignacionesBacklogMes: 1,
        tasaIntakeAsignacionPct: 50
      },
      closingPortfolioKpis: {
        clientesTotales: 3,
        asignados: 2,
        pendientes: 1,
        cargadoHoyArs: 1200,
        cargadoMesArs: 5600,
        clientesConReporte: 2,
        promedioCargaGeneralArs: 1866.67,
        tasaActivacionPct: 100
      },
      monthlyFlowKpis: {
        intakesMes: 4,
        reingresosMes: 1,
        asignacionesMes: 2,
        asignacionesBacklogMes: 1,
        tasaIntakeAsignacionPct: 50
      },
      closingPortfolioKpis: {
        clientesTotales: 3,
        asignados: 2,
        pendientes: 1,
        cargadoHoyArs: 1200,
        cargadoMesArs: 5600,
        clientesConReporte: 2,
        promedioCargaGeneralArs: 1866.67,
        tasaActivacionPct: 100
      },
      monthlyFlowKpis: {
        intakesMes: 4,
        reingresosMes: 1,
        asignacionesMes: 2,
        asignacionesBacklogMes: 1,
        tasaIntakeAsignacionPct: 50
      },
      closingPortfolioKpis: {
        clientesTotales: 3,
        asignados: 2,
        pendientes: 1,
        cargadoHoyArs: 1200,
        cargadoMesArs: 5600,
        clientesConReporte: 2,
        promedioCargaGeneralArs: 1866.67,
        tasaActivacionPct: 100
      },
      charts: {
        monthlyTrend: [
          { month: '2025-10', reportDate: null, cargadoMesArs: null },
          { month: '2025-11', reportDate: null, cargadoMesArs: null },
          { month: '2025-12', reportDate: null, cargadoMesArs: null },
          { month: '2026-01', reportDate: '2026-01-31', cargadoMesArs: 4100 },
          { month: '2026-02', reportDate: '2026-02-28', cargadoMesArs: 4700 },
          { month: '2026-03', reportDate: '2026-03-15', cargadoMesArs: 5600 }
        ]
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
          firstSeenAt: '2026-03-02T13:15:00.000Z',
          cargadoHoy: 600,
          cargadoMes: 2800,
          reportDate: '2026-03-12',
          isNewIntakeMes: true,
          isReingresoMes: false,
          assignedEnMes: true,
          assignedDesdeBacklogMes: false
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
        reingresosMes: 1,
        asignacionesMes: 2,
        asignacionesBacklogMes: 1,
        tasaIntakeAsignacionPct: 50,
        clientesConReporte: 2,
        promedioCargaGeneralArs: 1866.67,
        tasaActivacionPct: 100
      },
      monthlyFlowKpis: {
        intakesMes: 4,
        reingresosMes: 1,
        asignacionesMes: 2,
        asignacionesBacklogMes: 1,
        tasaIntakeAsignacionPct: 50
      },
      closingPortfolioKpis: {
        clientesTotales: 3,
        asignados: 2,
        pendientes: 1,
        cargadoHoyArs: 1200,
        cargadoMesArs: 5600,
        clientesConReporte: 2,
        promedioCargaGeneralArs: 1866.67,
        tasaActivacionPct: 100
      },
      charts: {
        monthlyTrend: [
          { month: '2025-10', reportDate: null, cargadoMesArs: null },
          { month: '2025-11', reportDate: null, cargadoMesArs: null },
          { month: '2025-12', reportDate: null, cargadoMesArs: null },
          { month: '2026-01', reportDate: '2026-01-31', cargadoMesArs: 4100 },
          { month: '2026-02', reportDate: '2026-02-28', cargadoMesArs: 4700 },
          { month: '2026-03', reportDate: '2026-03-15', cargadoMesArs: 5600 }
        ]
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
          firstSeenAt: '2026-03-02T13:15:00.000Z',
          cargadoHoy: 600,
          cargadoMes: 2800,
          reportDate: '2026-03-12',
          isNewIntakeMes: true,
          isReingresoMes: false,
          assignedEnMes: true,
          assignedDesdeBacklogMes: false
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
        reingresosMes: 1,
        asignacionesMes: 2,
        asignacionesBacklogMes: 1,
        tasaIntakeAsignacionPct: 50,
        clientesConReporte: 2,
        promedioCargaGeneralArs: 1866.67,
        tasaActivacionPct: 100
      },
      monthlyFlowKpis: {
        intakesMes: 4,
        reingresosMes: 1,
        asignacionesMes: 2,
        asignacionesBacklogMes: 1,
        tasaIntakeAsignacionPct: 50
      },
      closingPortfolioKpis: {
        clientesTotales: 3,
        asignados: 2,
        pendientes: 1,
        cargadoHoyArs: 1200,
        cargadoMesArs: 5600,
        clientesConReporte: 2,
        promedioCargaGeneralArs: 1866.67,
        tasaActivacionPct: 100
      },
      charts: {
        monthlyTrend: [
          { month: '2025-10', reportDate: null, cargadoMesArs: null },
          { month: '2025-11', reportDate: null, cargadoMesArs: null },
          { month: '2025-12', reportDate: null, cargadoMesArs: null },
          { month: '2026-01', reportDate: '2026-01-31', cargadoMesArs: 4100 },
          { month: '2026-02', reportDate: '2026-02-28', cargadoMesArs: 4700 },
          { month: '2026-03', reportDate: '2026-03-15', cargadoMesArs: 5600 }
        ]
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
          firstSeenAt: '2026-03-02T13:15:00.000Z',
          cargadoHoy: 600,
          cargadoMes: 2800,
          reportDate: '2026-03-12',
          isNewIntakeMes: true,
          isReingresoMes: false,
          assignedEnMes: true,
          assignedDesdeBacklogMes: false
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
      headers: mastercrmAuthorization(101),
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

  it('POST /mastercrm-analytics returns marketing analytics for the authenticated user', async () => {
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
      url: '/mastercrm-analytics',
      headers: mastercrmAuthorization(101),
      payload: {
        user_id: 101,
        date_from: '2026-06-01',
        date_to: '2026-06-18',
        channel: 'landing',
        campaign_key: 'TESTEO V2'
      }
    });

    expect(response.statusCode).toBe(200);
    expect(store.analyticsInputs).toEqual([
      {
        userId: 101,
        dateFrom: '2026-06-01',
        dateTo: '2026-06-18',
        channel: 'landing',
        campaignKey: 'TESTEO V2'
      }
    ]);
    expect(response.json().filters).toEqual({
      dateFrom: '2026-06-01',
      dateTo: '2026-06-18',
      channel: 'landing',
      campaignKey: 'TESTEO V2',
      adKey: null
    });

    await server.close();
  });

  it('POST /mastercrm-marketing-budgets upserts a daily ad budget', async () => {
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
      url: '/mastercrm-marketing-budgets',
      headers: mastercrmAuthorization(101),
      payload: {
        user_id: 101,
        channel: 'meta_ctwa',
        level: 'ad',
        campaign_key: 'Diamond play winner',
        campaign_name: 'Diamond play winner',
        ad_key: 'https://www.instagram.com/p/DZInI9YAF7y/',
        ad_name: 'Diamond play winner',
        link_url: 'https://www.instagram.com/p/DZInI9YAF7y/',
        daily_budget_ars: 15000,
        active_from: '2026-06-01',
        active_to: '2026-06-18'
      }
    });

    expect(response.statusCode).toBe(200);
    expect(store.marketingBudgetInputs).toEqual([
      {
        userId: 101,
        channel: 'meta_ctwa',
        level: 'ad',
        campaignKey: 'Diamond play winner',
        campaignName: 'Diamond play winner',
        adKey: 'https://www.instagram.com/p/DZInI9YAF7y/',
        adName: 'Diamond play winner',
        linkUrl: 'https://www.instagram.com/p/DZInI9YAF7y/',
        dailyBudgetArs: 15000,
        activeFrom: '2026-06-01',
        activeTo: '2026-06-18'
      }
    ]);
    expect(response.json()).toMatchObject({
      id: 'budget-1',
      channel: 'meta_ctwa',
      level: 'ad',
      dailyBudgetArs: 15000
    });

    await server.close();
  });

  it('POST /mastercrm-marketing-budgets rejects campaign budgets', async () => {
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
      url: '/mastercrm-marketing-budgets',
      headers: mastercrmAuthorization(101),
      payload: {
        user_id: 101,
        channel: 'meta_ctwa',
        level: 'campaign',
        campaign_key: 'Diamond play winner',
        campaign_name: 'Diamond play winner',
        daily_budget_ars: 15000,
        active_from: '2026-06-01'
      }
    });

    expect(response.statusCode).toBe(400);
    expect(store.marketingBudgetInputs).toEqual([]);
    expect(response.json()).toEqual({
      message: 'Invalid payload',
      issues: [{ path: 'level', message: 'level must be ad' }]
    });

    await server.close();
  });

  it('POST /mastercrm-marketing-budgets/distribute saves a distributed daily ad budget', async () => {
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
      url: '/mastercrm-marketing-budgets/distribute',
      headers: mastercrmAuthorization(101),
      payload: {
        user_id: 101,
        total_daily_budget_ars: 1000,
        active_from: '2026-06-01',
        active_to: '2026-06-18',
        ads: [
          {
            channel: 'meta_ctwa',
            campaign_key: 'Reino Dorado',
            campaign_name: 'Reino Dorado',
            ad_key: 'ad-1',
            ad_name: 'Anuncio 1',
            link_url: 'https://example.test/ad-1'
          },
          {
            channel: 'meta_ctwa',
            campaign_key: 'Reino Dorado',
            campaign_name: 'Reino Dorado',
            ad_key: 'ad-2',
            ad_name: 'Anuncio 2'
          }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(store.distributeMarketingBudgetInputs).toEqual([
      {
        userId: 101,
        totalDailyBudgetArs: 1000,
        activeFrom: '2026-06-01',
        activeTo: '2026-06-18',
        ads: [
          {
            channel: 'meta_ctwa',
            campaignKey: 'Reino Dorado',
            campaignName: 'Reino Dorado',
            adKey: 'ad-1',
            adName: 'Anuncio 1',
            linkUrl: 'https://example.test/ad-1'
          },
          {
            channel: 'meta_ctwa',
            campaignKey: 'Reino Dorado',
            campaignName: 'Reino Dorado',
            adKey: 'ad-2',
            adName: 'Anuncio 2'
          }
        ]
      }
    ]);
    expect(response.json()).toMatchObject({
      budgets: [
        { id: 'budget-1', level: 'ad', dailyBudgetArs: 500 },
        { id: 'budget-2', level: 'ad', dailyBudgetArs: 500 }
      ]
    });

    await server.close();
  });

  it('POST /mastercrm-marketing-budgets/distribute rejects invalid ad selections before the store', async () => {
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
      url: '/mastercrm-marketing-budgets/distribute',
      headers: mastercrmAuthorization(101),
      payload: {
        user_id: 101,
        total_daily_budget_ars: 1000,
        active_from: '2026-06-01',
        ads: [
          {
            channel: 'meta_ctwa',
            campaign_key: 'Reino Dorado',
            campaign_name: 'Reino Dorado',
            ad_key: 'ad-1'
          }
        ]
      }
    });

    expect(response.statusCode).toBe(400);
    expect(store.distributeMarketingBudgetInputs).toEqual([]);
    expect(response.json()).toMatchObject({
      message: 'Invalid payload',
      issues: [{ path: 'ads', message: 'ads must include at least two ads' }]
    });

    await server.close();
  });

  it('POST /mastercrm-marketing-budgets/delete deletes a budget for the authenticated user', async () => {
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
      url: '/mastercrm-marketing-budgets/delete',
      headers: mastercrmAuthorization(101),
      payload: {
        user_id: 101,
        budget_id: 'budget-1'
      }
    });

    expect(response.statusCode).toBe(200);
    expect(store.deleteMarketingBudgetInputs).toEqual([{ userId: 101, budgetId: 'budget-1' }]);
    expect(response.json()).toEqual({ deleted: true, id: 'budget-1' });

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
      headers: mastercrmAuthorization(999),
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
      headers: mastercrmAuthorization(123),
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
        ownerKey: 'owner_key_del_cajero',
        pagina: 'ASN'
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

  it('POST /mastercrm-link-cashier can link RdA owners', async () => {
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
      headers: mastercrmAuthorization(123),
      payload: {
        user_id: 123,
        owner_key: 'rda_owner',
        pagina: 'RdA',
        staff_password: 'staff-secret'
      }
    });

    expect(response.statusCode).toBe(201);
    expect(store.linkInputs).toEqual([{ userId: 123, ownerKey: 'rda_owner', pagina: 'RdA' }]);
    expect(response.json().data.pagina).toBe('RdA');

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
      headers: mastercrmAuthorization(999),
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
      headers: mastercrmAuthorization(999),
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
      headers: mastercrmAuthorization(123),
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
      headers: mastercrmAuthorization(123),
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
      pagina: input.pagina,
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
      headers: mastercrmAuthorization(123),
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

  it('POST /users/create-player rejects short RdA player passwords before queueing', async () => {
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
        newUsername: '0Ro347',
        newPassword: 'ro123'
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().issues).toContainEqual({
      path: 'newPassword',
      message: 'RdA newPassword must be at least 6 characters'
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

  it('GET /landing renders the Rey Dorado landing with CTA, legal badges and Pixel config', async () => {
    await withEnv(
      {
        LANDING_ENABLED: 'true',
        META_PIXEL_ID: '1234567890'
      },
      async () => {
        const queue = new FakeQueue();
        const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
        const logger = createLogger('silent', false);
        const server = createServer(
          appConfig,
          { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
          logger,
          queue,
          {
            reportWorkerEnabled: false,
            metaWorkerEnabled: false
          }
        );

        const response = await server.inject({
          method: 'GET',
          url: '/landing'
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toContain('text/html');
        expect(response.body).toContain('Rey Dorado');
        expect(response.body).toContain('Quiero mi bono');
        expect(response.body).toContain('18<sup>+</sup>');
        expect(response.body).toContain('Juego responsable');
        expect(response.body).toContain('/landing/privacidad');
        expect(response.body).toContain('/landing/terminos');
        expect(response.body).toContain('"pixelId":"1234567890"');
        expect(response.body).toContain('"whatsappPhone":"5493515747477"');
        expect(response.body).toContain('"whatsappPhones":["5493515747477"]');
        expect(response.body).not.toContain('"cashierPhone"');
        expect(response.body).not.toContain('5493516549344');
        expect(response.body).toContain(
          'https://wa.me/5493515747477?text=Hola%20quiero%20mi%20usuario%20suertudo%20del%20Rey%20Dorado'
        );

        await server.close();
      }
    );
  });

  it('GET /landing legal pages and static assets respond with cache headers', async () => {
    await withEnv({ LANDING_ENABLED: 'true' }, async () => {
      const queue = new FakeQueue();
      const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
      const logger = createLogger('silent', false);
      const server = createServer(
        appConfig,
        { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
        logger,
        queue,
        {
          reportWorkerEnabled: false,
          metaWorkerEnabled: false
        }
      );

      const privacidad = await server.inject({ method: 'GET', url: '/landing/privacidad' });
      const terminos = await server.inject({ method: 'GET', url: '/landing/terminos' });
      const rdav2Privacidad = await server.inject({ method: 'GET', url: '/landing/rdav2/privacidad' });
      const rdav2Terminos = await server.inject({ method: 'GET', url: '/landing/rdav2/terminos' });
      const css = await server.inject({ method: 'GET', url: '/landing/styles.css' });
      const rdav2 = await server.inject({ method: 'GET', url: '/landing/rdav2' });
      const rdav2Css = await server.inject({ method: 'GET', url: '/landing/styles-rdav2.css' });
      const rdav2Roulette = await server.inject({ method: 'GET', url: '/landing/assets/rdav2-roulette.webp' });
      const hero = await server.inject({ method: 'GET', url: '/landing/assets/hero-monkey-king.webp' });

      expect(privacidad.statusCode).toBe(200);
      expect(terminos.statusCode).toBe(200);
      expect(privacidad.body).not.toContain('landing.js');
      expect(terminos.body).not.toContain('landing.js');
      expect(rdav2Privacidad.statusCode).toBe(200);
      expect(rdav2Privacidad.body).toContain('href="/landing/rdav2"');
      expect(rdav2Privacidad.body).not.toContain('landing.js');
      expect(rdav2Terminos.statusCode).toBe(200);
      expect(rdav2Terminos.body).toContain('href="/landing/rdav2"');
      expect(rdav2Terminos.body).not.toContain('landing.js');
      expect(css.statusCode).toBe(200);
      expect(css.headers['cache-control']).toContain('max-age=300');
      expect(rdav2.statusCode).toBe(200);
      expect(rdav2.body).toContain('rda-luqui10-rdav2');
      expect(rdav2.body).toContain('"whatsappPhone":"5493516346253"');
      expect(rdav2.body).toContain('"whatsappPhones":["5493516346253"]');
      expect(rdav2.body).toContain('Hola quiero un usuario, el codigo de mi bono es: XXXXX');
      expect(rdav2.body).toContain('/landing/rdav2/privacidad');
      expect(rdav2.body).toContain('/landing/rdav2/terminos');
      expect(rdav2.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(rdav2.headers['x-content-type-options']).toBe('nosniff');
      expect(rdav2.headers['x-frame-options']).toBe('DENY');
      expect(rdav2Css.statusCode).toBe(200);
      expect(rdav2Css.headers['content-type']).toContain('text/css');
      expect(rdav2Roulette.statusCode).toBe(200);
      expect(rdav2Roulette.headers['content-type']).toContain('image/webp');
      expect(rdav2Roulette.headers['cache-control']).toContain('immutable');
      expect(hero.statusCode).toBe(200);
      expect(hero.headers['content-type']).toContain('image/webp');
      expect(hero.headers['cache-control']).toContain('immutable');
      expect(Number(hero.headers['content-length'] ?? 0)).toBeGreaterThan(0);

      await server.close();
    });
  });

  it('POST /landing/contact dispatches website Contact CAPI without creating a CRM intake', async () => {
    await withEnv(
      {
        LANDING_ENABLED: 'true',
        LANDING_ALLOWED_ORIGINS: 'https://landing.reydeases.com'
      },
      async () => {
        const queue = new FakeQueue();
        const dispatcher = new FakeLandingMetaConversionsDispatcher();
        const playerPhoneStore = new FakePlayerPhoneStore();
        const landingSessionStore = new FakeLandingSessionStore();
        const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
        const logger = createLogger('silent', false);
        const server = createServer(
          appConfig,
          { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
          logger,
          queue,
          {
            playerPhoneStore,
            landingSessionStore,
            metaEnabled: true,
            reportWorkerEnabled: false,
            metaWorkerEnabled: false,
            landingMetaConversionsDispatcher: dispatcher
          }
        );

        const response = await server.inject({
          method: 'POST',
          url: '/landing/contact',
          headers: {
            origin: 'https://landing.reydeases.com',
            'user-agent': 'Mozilla/5.0 MetaInAppBrowser',
            'x-forwarded-for': '181.45.10.22, 10.0.0.1'
          },
          payload: {
            eventId: 'contact:test',
            landingSessionId: 'session_123',
            landingVariant: 'rda-luqui10-rdav2',
            routingSeed: 'routing_0',
            bonusCode: 'ABCD2',
            fbp: 'fb.1.1710000000000.111',
            fbc: 'fb.1.1710000000000.fbclid-123',
            fbclid: 'fbclid-123',
            eventSourceUrl: 'https://landing.reydeases.com/landing?fbclid=fbclid-123&utm_source=meta',
            referrer: 'https://facebook.com/',
            utmSource: 'meta',
            utmMedium: 'paid_social',
            utmId: '6991129588056',
            utmCampaign: 'Mayo RDA',
            utmTerm: 'Prospeccion',
            utmContent: 'Video 1',
            adsetId: '69911377388568',
            adId: '699113773885680',
            placement: 'facebook_feed'
          }
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          status: 'ok',
          tracked: true,
          trackingStatus: 'sent',
          eventId: 'contact:test',
          whatsappUrl: 'https://wa.me/5493516346253?text=Hola%20quiero%20un%20usuario%2C%20el%20codigo%20de%20mi%20bono%20es%3A%20ABCD2',
          whatsappMessage: 'Hola quiero un usuario, el codigo de mi bono es: ABCD2',
          bonusCode: 'ABCD2',
          attributionStatus: 'persisted',
          ownerContext: {
            ownerKey: 'luqui10:luqui10',
            ownerLabel: 'Lucas10'
          }
        });
        expect(landingSessionStore.createInputs).toHaveLength(1);
        expect(landingSessionStore.createInputs[0]).toMatchObject({
          landingSessionId: 'session_123',
          landingVariant: 'rda-luqui10-rdav2',
          contactEventId: 'contact:test',
          messageText: 'Hola quiero un usuario, el codigo de mi bono es: ABCD2',
          messageKey: 'hola quiero un usuario el codigo de mi bono es abcd2',
          pagina: 'RdA',
          botPhoneE164: '+5493516346253',
          cashierPhoneE164: '+5493516549344',
          utmId: '6991129588056',
          utmCampaign: 'Mayo RDA',
          utmTerm: 'Prospeccion',
          utmContent: 'Video 1',
          adsetId: '69911377388568',
          adId: '699113773885680',
          placement: 'facebook_feed'
        });
        expect(playerPhoneStore.intakeInputs).toEqual([]);
        expect(dispatcher.leases).toHaveLength(1);
        expect(dispatcher.leases[0]).toMatchObject({
          ownerId: 'luqui10:luqui10',
          clientId: 'session_123',
          eventStage: 'landing_contact',
          metaEventName: 'Contact',
          eventId: 'contact:test',
          phoneE164: null,
          username: null,
          sourcePayload: {
            owner_key: 'luqui10:luqui10',
            owner_label: 'Lucas10',
            Fbp: 'fb.1.1710000000000.111',
            Fbc: 'fb.1.1710000000000.fbclid-123',
            Fbclid: 'fbclid-123',
            EventSourceUrl: 'https://landing.reydeases.com/landing?fbclid=fbclid-123&utm_source=meta',
            Referrer: 'https://facebook.com/',
            LandingSessionId: 'session_123',
            LandingVariant: 'rda-luqui10-rdav2',
            CtaType: 'whatsapp_click',
            UtmSource: 'meta',
            UtmMedium: 'paid_social',
            UtmId: '6991129588056',
            UtmCampaign: 'Mayo RDA',
            UtmTerm: 'Prospeccion',
            UtmContent: 'Video 1',
            AdsetId: '69911377388568',
            AdId: '699113773885680',
            Placement: 'facebook_feed',
            WhatsappUrl: 'https://wa.me/5493516346253?text=Hola%20quiero%20un%20usuario%2C%20el%20codigo%20de%20mi%20bono%20es%3A%20ABCD2',
            ClientIpAddress: '181.45.10.22',
            ClientUserAgent: 'Mozilla/5.0 MetaInAppBrowser'
          }
        });

        await server.close();
      }
    );
  });

  it('POST /landing/contact returns the WhatsApp URL when Meta tracking is disabled', async () => {
    await withEnv({ LANDING_ENABLED: 'true' }, async () => {
      const queue = new FakeQueue();
      const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
      const logger = createLogger('silent', false);
      const server = createServer(
        appConfig,
        { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
        logger,
        queue,
        {
          metaEnabled: false,
          reportWorkerEnabled: false,
          metaWorkerEnabled: false
        }
      );

      const response = await server.inject({
        method: 'POST',
        url: '/landing/contact',
        headers: {
          'user-agent': 'Mozilla/5.0'
        },
        payload: {
          eventId: 'contact:fallback',
          landingSessionId: 'session_fallback',
          routingSeed: 'routing_0'
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        status: 'ok',
        tracked: false,
        trackingStatus: 'disabled',
        whatsappUrl: 'https://wa.me/5493515747477?text=Hola%20quiero%20mi%20usuario%20suertudo%20del%20Rey%20Dorado',
        whatsappMessage: 'Hola quiero mi usuario suertudo del Rey Dorado',
        attributionStatus: 'incomplete'
      });

      await server.close();
    });
  });

  it('POST /landing/contact keeps rdav2 on its fixed WhatsApp number even when the fallback URL is spoofed', async () => {
    await withEnv({ LANDING_ENABLED: 'true' }, async () => {
      const queue = new FakeQueue();
      const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
      const logger = createLogger('silent', false);
      const server = createServer(
        appConfig,
        { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
        logger,
        queue,
        {
          metaEnabled: false,
          reportWorkerEnabled: false,
          metaWorkerEnabled: false
        }
      );

      const response = await server.inject({
        method: 'POST',
        url: '/landing/contact',
        payload: {
          eventId: 'contact:rdav2-fallback',
          landingSessionId: 'session_rdav2_fallback',
          landingVariant: 'rda-luqui10-rdav2',
          routingSeed: 'routing_0',
          bonusCode: 'QWERT',
          whatsappUrl: 'https://wa.me/1111111111?text=incorrecto'
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        whatsappUrl: 'https://wa.me/5493516346253?text=Hola%20quiero%20un%20usuario%2C%20el%20codigo%20de%20mi%20bono%20es%3A%20QWERT',
        whatsappMessage: 'Hola quiero un usuario, el codigo de mi bono es: QWERT',
        bonusCode: 'QWERT'
      });

      await server.close();
    });
  });

  it('POST /landing/contact rejects invalid rdav2 bonus codes', async () => {
    await withEnv({ LANDING_ENABLED: 'true' }, async () => {
      const queue = new FakeQueue();
      const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
      const logger = createLogger('silent', false);
      const server = createServer(
        appConfig,
        { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
        logger,
        queue,
        {
          metaEnabled: false,
          reportWorkerEnabled: false,
          metaWorkerEnabled: false
        }
      );

      const response = await server.inject({
        method: 'POST',
        url: '/landing/contact',
        payload: {
          eventId: 'contact:invalid-bonus-code',
          landingSessionId: 'session_invalid_bonus_code',
          landingVariant: 'rda-luqui10-rdav2',
          routingSeed: 'routing_0',
          bonusCode: 'bad'
        }
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: 'INVALID_PAYLOAD'
      });

      await server.close();
    });
  });

  it('POST /landing/contact keeps the WhatsApp redirect fixed while preserving routing seed identity', async () => {
    await withEnv({ LANDING_ENABLED: 'true' }, async () => {
      const queue = new FakeQueue();
      const landingSessionStore = new FakeLandingSessionStore();
      const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
      const logger = createLogger('silent', false);
      const server = createServer(
        appConfig,
        { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
        logger,
        queue,
        {
          landingSessionStore,
          metaEnabled: false,
          reportWorkerEnabled: false,
          metaWorkerEnabled: false
        }
      );

      const primary = await server.inject({
        method: 'POST',
        url: '/landing/contact',
        payload: {
          eventId: 'contact:split-primary',
          landingSessionId: 'session_stable',
          routingSeed: 'routing_1'
        }
      });
      const repeated = await server.inject({
        method: 'POST',
        url: '/landing/contact',
        payload: {
          eventId: 'contact:fixed-secondary',
          landingSessionId: 'session_stable',
          routingSeed: 'routing_0'
        }
      });

      expect(primary.statusCode).toBe(200);
      expect(repeated.statusCode).toBe(200);
      expect(primary.json().whatsappUrl).toBe(
        'https://wa.me/5493515747477?text=Hola%20quiero%20mi%20usuario%20suertudo%20del%20Rey%20Dorado'
      );
      expect(repeated.json().whatsappUrl).toBe(
        'https://wa.me/5493515747477?text=Hola%20quiero%20mi%20usuario%20suertudo%20del%20Rey%20Dorado'
      );
      expect(landingSessionStore.createInputs.map((input) => input.botPhoneE164)).toEqual([
        '+5493515747477',
        '+5493515747477'
      ]);
      expect(landingSessionStore.createInputs.map((input) => input.landingSessionId)).toEqual([
        'session_stable',
        'session_stable'
      ]);

      await server.close();
    });
  });

  it('POST /landing/contact rejects payloads without a routing seed', async () => {
    await withEnv({ LANDING_ENABLED: 'true' }, async () => {
      const queue = new FakeQueue();
      const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
      const logger = createLogger('silent', false);
      const server = createServer(
        appConfig,
        { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
        logger,
        queue,
        {
          metaEnabled: false,
          reportWorkerEnabled: false,
          metaWorkerEnabled: false
        }
      );

      const response = await server.inject({
        method: 'POST',
        url: '/landing/contact',
        payload: {
          eventId: 'contact:missing-routing',
          landingSessionId: 'session_stable'
        }
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        message: 'Invalid payload',
        code: 'INVALID_PAYLOAD',
        attributionStatus: 'incomplete',
        attributionError: 'invalid_payload'
      });
      expect(response.json().details.issues).toContainEqual(
        expect.objectContaining({
          path: 'routingSeed'
        })
      );

      await server.close();
    });
  });

  it('disables landing routes when LANDING_ENABLED=false', async () => {
    await withEnv({ LANDING_ENABLED: 'false' }, async () => {
      const queue = new FakeQueue();
      const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
      const logger = createLogger('silent', false);
      const server = createServer(
        appConfig,
        { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
        logger,
        queue,
        {
          reportWorkerEnabled: false,
          metaWorkerEnabled: false
        }
      );

      const page = await server.inject({ method: 'GET', url: '/landing' });
      const contact = await server.inject({
        method: 'POST',
        url: '/landing/contact',
        payload: {
          eventId: 'contact:disabled',
          landingSessionId: 'session_disabled'
        }
      });

      expect(page.statusCode).toBe(404);
      expect(contact.statusCode).toBe(404);

      await server.close();
    });
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

  it('POST /users/intake-pending forwards sourceContext and enqueues an immediate Meta lead when attributable', async () => {
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
        eventTime: '2026-03-17T09:58:00.000Z',
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
          profileName: 'Raul Rodriguez',
          clientIpAddress: '181.45.10.22',
          clientUserAgent: 'Mozilla/5.0',
          receivedAt: '2026-03-17T09:58:00.000Z'
        },
        customerData: {
          email: 'cliente@gmail.com',
          firstName: 'Raul',
          lastName: 'Rodriguez'
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
        profileName: 'Raul Rodriguez',
        clientIpAddress: '181.45.10.22',
        clientUserAgent: 'Mozilla/5.0',
        receivedAt: '2026-03-17T09:58:00.000Z'
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
          profileName: 'Raul Rodriguez',
          clientIpAddress: '181.45.10.22',
          clientUserAgent: 'Mozilla/5.0',
          receivedAt: '2026-03-17T09:58:00.000Z'
        },
        customerData: {
          email: 'cliente@gmail.com',
          firstName: 'Raul',
          lastName: 'Rodriguez'
        },
        eventTime: '2026-03-17T09:58:00.000Z'
      }
    ]);

    await server.close();
  });

  it('POST /users/intake-pending does not enqueue a Meta lead when sourceContext is not attributable', async () => {
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
          referralSourceType: 'organic',
          waId: '5491138294407',
          receivedAt: '2026-03-17T09:58:00.000Z'
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(metaStore.leadInputs).toEqual([]);

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

  it('POST /whatsapp/intake persists Twilio intake from WaId and enqueues Meta lead when attributable', async () => {
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
      url: '/whatsapp/intake',
      payload: {
        pagina: 'ASN',
        body: {
          WaId: '5493515747477',
          From: 'whatsapp:+5493515747477',
          ProfileName: 'Lucas Cliente',
          ReferralCtwaClid: 'clid-123',
          ReferralSourceId: 'source-123',
          ReferralSourceUrl: 'https://fb.me/ad',
          ReferralHeadline: 'Royal Luck',
          ReferralBody: 'Quiero info',
          ReferralSourceType: 'ad',
          MessageSid: 'SM123',
          AccountSid: 'AC123',
          ReceivedAt: '2026-04-07T13:00:00.000Z'
        },
        ownerContext: {
          ownerKey: 'asnlucas10:lucas10',
          ownerLabel: 'Lucas10',
          actorAlias: 'Lucas10',
          actorPhone: '+5493516549344'
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      pagina: 'ASN',
      telefono: '+5493515747477',
      ownerContext: {
        ownerKey: 'asnlucas10:lucas10',
        ownerLabel: 'Lucas10',
        actorAlias: 'Lucas10',
        actorPhone: '+5493516549344'
      },
      cajeroId: 'cajero-1',
      jugadorId: 'jugador-1',
      linkId: 'link-1',
      estado: 'pendiente',
      ownerId: 'owner-1'
    });
    expect(playerPhoneStore.intakeInputs).toEqual([
      {
        pagina: 'ASN',
        telefono: '+5493515747477',
        ownerContext: {
          ownerKey: 'asnlucas10:lucas10',
          ownerLabel: 'Lucas10',
          actorAlias: 'Lucas10',
          actorPhone: '+5493516549344'
        },
        sourceContext: {
          ctwaClid: 'clid-123',
          referralSourceId: 'source-123',
          referralSourceUrl: 'https://fb.me/ad',
          referralHeadline: 'Royal Luck',
          referralBody: 'Quiero info',
          referralSourceType: 'ad',
          waId: '5493515747477',
          messageSid: 'SM123',
          accountSid: 'AC123',
          profileName: 'Lucas Cliente',
          receivedAt: '2026-04-07T13:00:00.000Z'
        }
      }
    ]);
    expect(metaStore.leadInputs).toEqual([
      {
        ownerId: 'owner-1',
        clientId: 'client-1',
        phoneE164: '+5493515747477',
        ownerContext: {
          ownerKey: 'asnlucas10:lucas10',
          ownerLabel: 'Lucas10',
          actorAlias: 'Lucas10',
          actorPhone: '+5493516549344'
        },
        sourceContext: {
          ctwaClid: 'clid-123',
          referralSourceId: 'source-123',
          referralSourceUrl: 'https://fb.me/ad',
          referralHeadline: 'Royal Luck',
          referralBody: 'Quiero info',
          referralSourceType: 'ad',
          waId: '5493515747477',
          messageSid: 'SM123',
          accountSid: 'AC123',
          profileName: 'Lucas Cliente',
          receivedAt: '2026-04-07T13:00:00.000Z'
        },
        eventTime: '2026-04-07T13:00:00.000Z'
      }
    ]);

    await server.close();
  });

  it('POST /whatsapp/intake claims a landing session and enqueues a website landing Lead', async () => {
    const queue = new FakeQueue();
    const playerPhoneStore = new FakePlayerPhoneStore();
    const landingSessionStore = new FakeLandingSessionStore();
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
        landingSessionStore,
        metaConversionsStore: metaStore,
        metaEnabled: true,
        metaWorkerEnabled: false
      }
    );

    const contact = await server.inject({
      method: 'POST',
      url: '/landing/contact',
      headers: {
        'user-agent': 'Mozilla/5.0 MetaInAppBrowser',
        'x-forwarded-for': '181.45.10.22'
      },
      payload: {
        eventId: 'contact:landing-lead',
        landingSessionId: 'session_landing_lead',
        routingSeed: 'routing_0',
        fbp: 'fb.1.1710000000000.111',
        fbc: 'fb.1.1710000000000.fbclid-123',
        fbclid: 'fbclid-123',
        eventSourceUrl: 'https://reydeases.imperial-support.com/landing?fbclid=fbclid-123&utm_source=meta',
        utmSource: 'meta',
        utmMedium: 'paid_social',
        utmCampaign: 'rda_landing'
      }
    });
    const contactBody = contact.json();

    const response = await server.inject({
      method: 'POST',
      url: '/whatsapp/intake',
      payload: {
        pagina: 'RdA',
        body: {
          WaId: '5493511112222',
          From: 'whatsapp:+5493511112222',
          Body: contactBody.whatsappMessage,
          ProfileName: 'Cliente Landing',
          MessageSid: 'SM-LANDING',
          AccountSid: 'AC-LANDING',
          ReceivedAt: '2026-06-03T18:00:00.000Z'
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      pagina: 'RdA',
      telefono: '+5493511112222',
      landingSessionId: 'session_landing_lead',
      ownerContext: {
        ownerKey: 'luqui10:luqui10',
        ownerLabel: 'Lucas10',
        actorAlias: 'Lucas10',
        actorPhone: '+5493516549344'
      }
    });
    expect(landingSessionStore.claimInputs).toEqual([
      {
        messageText: 'Hola quiero mi usuario suertudo del Rey Dorado',
        phoneE164: '+5493511112222',
        messageSid: 'SM-LANDING',
        claimedAt: '2026-06-03T18:00:00.000Z'
      }
    ]);
    expect(playerPhoneStore.intakeInputs).toHaveLength(1);
    expect(playerPhoneStore.intakeInputs[0]).toMatchObject({
      pagina: 'RdA',
      telefono: '+5493511112222',
      ownerContext: {
        ownerKey: 'luqui10:luqui10',
        ownerLabel: 'Lucas10',
        actorAlias: 'Lucas10',
        actorPhone: '+5493516549344'
      },
      sourceContext: {
        fbp: 'fb.1.1710000000000.111',
        fbc: 'fb.1.1710000000000.fbclid-123',
        fbclid: 'fbclid-123',
        eventSourceUrl: 'https://reydeases.imperial-support.com/landing?fbclid=fbclid-123&utm_source=meta',
        landingSessionId: 'session_landing_lead',
        landingVariant: 'rda-luqui10-v1',
        ctaType: 'whatsapp_click',
        utmSource: 'meta',
        utmMedium: 'paid_social',
        utmCampaign: 'rda_landing',
        whatsappUrl: 'https://wa.me/5493515747477?text=Hola%20quiero%20mi%20usuario%20suertudo%20del%20Rey%20Dorado',
        waId: '5493511112222',
        messageSid: 'SM-LANDING',
        accountSid: 'AC-LANDING',
        profileName: 'Cliente Landing',
        clientIpAddress: '181.45.10.22',
        clientUserAgent: 'Mozilla/5.0 MetaInAppBrowser',
        receivedAt: '2026-06-03T18:00:00.000Z'
      }
    });
    expect(metaStore.leadInputs).toEqual([]);
    expect(metaStore.landingLeadInputs).toHaveLength(1);
    expect(metaStore.landingLeadInputs[0]).toMatchObject({
      ownerId: 'owner-1',
      clientId: 'client-1',
      phoneE164: '+5493511112222',
      ownerContext: {
        ownerKey: 'luqui10:luqui10',
        ownerLabel: 'Lucas10',
        actorAlias: 'Lucas10',
        actorPhone: '+5493516549344'
      },
      sourceContext: {
        landingSessionId: 'session_landing_lead',
        fbp: 'fb.1.1710000000000.111',
        fbc: 'fb.1.1710000000000.fbclid-123',
        clientIpAddress: '181.45.10.22',
        clientUserAgent: 'Mozilla/5.0 MetaInAppBrowser'
      },
      eventTime: '2026-06-03T18:00:00.000Z'
    });

    await server.close();
  });

  it('POST /whatsapp/intake keeps explicit n8n ownerContext when claiming a landing session', async () => {
    const queue = new FakeQueue();
    const playerPhoneStore = new FakePlayerPhoneStore();
    const landingSessionStore = new FakeLandingSessionStore();
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
        landingSessionStore,
        metaConversionsStore: metaStore,
        metaEnabled: true,
        metaWorkerEnabled: false
      }
    );

    const contact = await server.inject({
      method: 'POST',
      url: '/landing/contact',
      headers: {
        'user-agent': 'Mozilla/5.0 MetaInAppBrowser',
        'x-forwarded-for': '181.45.10.22'
      },
      payload: {
        eventId: 'contact:landing-n8n-owner',
        landingSessionId: 'session_landing_n8n_owner',
        routingSeed: 'routing_0',
        fbp: 'fb.1.1710000000000.111',
        eventSourceUrl: 'https://reydeases.imperial-support.com/landing?utm_source=meta',
        utmSource: 'meta'
      }
    });
    const contactBody = contact.json();

    const ownerContext = {
      ownerKey: 'luqui10:lear',
      ownerLabel: 'Lea Riqueza',
      actorAlias: 'Lea Riqueza',
      actorPhone: '+5491154816740'
    };
    const response = await server.inject({
      method: 'POST',
      url: '/whatsapp/intake',
      payload: {
        pagina: 'RdA',
        ownerContext,
        body: {
          WaId: '5493562554282',
          From: 'whatsapp:+5493562554282',
          Body: contactBody.whatsappMessage,
          ProfileName: 'Cliente Landing',
          MessageSid: 'SM-LANDING-N8N',
          AccountSid: 'AC-LANDING',
          ReceivedAt: '2026-06-06T06:29:13.000Z'
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      pagina: 'RdA',
      telefono: '+5493562554282',
      landingSessionId: 'session_landing_n8n_owner',
      ownerContext
    });
    expect(playerPhoneStore.intakeInputs).toHaveLength(1);
    expect(playerPhoneStore.intakeInputs[0]).toMatchObject({
      ownerContext,
      sourceContext: {
        landingSessionId: 'session_landing_n8n_owner',
        ctaType: 'whatsapp_click',
        whatsappUrl: 'https://wa.me/5493515747477?text=Hola%20quiero%20mi%20usuario%20suertudo%20del%20Rey%20Dorado'
      }
    });
    expect(metaStore.landingLeadInputs[0]).toMatchObject({
      ownerContext
    });

    await server.close();
  });

  it('POST /whatsapp/intake falls back to body.From when WaId and telefono are missing', async () => {
    const queue = new FakeQueue();
    const playerPhoneStore = new FakePlayerPhoneStore();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { playerPhoneStore }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/whatsapp/intake',
      payload: {
        pagina: 'ASN',
        body: {
          From: 'whatsapp:+5493515747477',
          MessageSid: 'SM456'
        },
        ownerContext: {
          ownerKey: 'asnlucas10:vicky',
          ownerLabel: 'Vicky'
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().telefono).toBe('+5493515747477');
    expect(playerPhoneStore.intakeInputs[0]).toEqual({
      pagina: 'ASN',
      telefono: '+5493515747477',
      ownerContext: {
        ownerKey: 'asnlucas10:vicky',
        ownerLabel: 'Vicky'
      },
      sourceContext: {
        messageSid: 'SM456'
      }
    });

    await server.close();
  });

  it('POST /whatsapp/intake respects explicit sourceContext over body referral fields', async () => {
    const queue = new FakeQueue();
    const playerPhoneStore = new FakePlayerPhoneStore();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { playerPhoneStore }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/whatsapp/intake',
      payload: {
        pagina: 'RdA',
        telefono: '+5493515747477',
        body: {
          ReferralCtwaClid: 'body-clid',
          WaId: '5493510000000'
        },
        ownerContext: {
          ownerKey: 'rda:lucas10',
          ownerLabel: 'Lucas10'
        },
        sourceContext: {
          ctwaClid: 'explicit-clid',
          referralSourceType: 'ad',
          waId: '5493515747477',
          receivedAt: '2026-04-07T13:00:00-03:00'
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(playerPhoneStore.intakeInputs[0]).toEqual({
      pagina: 'RdA',
      telefono: '+5493515747477',
      ownerContext: {
        ownerKey: 'rda:lucas10',
        ownerLabel: 'Lucas10'
      },
      sourceContext: {
        ctwaClid: 'explicit-clid',
        referralSourceType: 'ad',
        waId: '5493515747477',
        receivedAt: '2026-04-07T16:00:00.000Z'
      }
    });

    await server.close();
  });

  it('POST /whatsapp/intake returns 400 when no phone can be resolved', async () => {
    const queue = new FakeQueue();
    const playerPhoneStore = new FakePlayerPhoneStore();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { playerPhoneStore }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/whatsapp/intake',
      payload: {
        pagina: 'ASN',
        body: {
          ProfileName: 'Sin telefono'
        },
        ownerContext: {
          ownerKey: 'asnlucas10:lucas10',
          ownerLabel: 'Lucas10'
        }
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      message: 'Invalid payload',
      code: 'INVALID_PAYLOAD',
      details: {
        issues: [{ path: 'telefono', message: 'telefono, body.WaId or body.From is required' }]
      }
    });
    expect(playerPhoneStore.intakeInputs).toHaveLength(0);

    await server.close();
  });

  it('POST /whatsapp/intake resolves ownerContext from existing persisted phone link when missing', async () => {
    const queue = new FakeQueue();
    const playerPhoneStore = new FakePlayerPhoneStore();
    playerPhoneStore.resolveOwnerContextByPhoneBehavior = async () => ({
      ownerKey: 'asnlucas10:lucas10',
      ownerLabel: 'Lucas10',
      actorAlias: 'Lucas10',
      actorPhone: '+5493516549344'
    });
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { playerPhoneStore }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/whatsapp/intake',
      payload: {
        pagina: 'ASN',
        body: {
          WaId: '5493515747477'
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(playerPhoneStore.resolveOwnerContextByPhoneInputs).toEqual([
      {
        pagina: 'ASN',
        telefono: '+5493515747477'
      }
    ]);
    expect(playerPhoneStore.intakeInputs[0]?.ownerContext).toEqual({
      ownerKey: 'asnlucas10:lucas10',
      ownerLabel: 'Lucas10',
      actorAlias: 'Lucas10',
      actorPhone: '+5493516549344'
    });
    expect(response.json().ownerContext).toEqual({
      ownerKey: 'asnlucas10:lucas10',
      ownerLabel: 'Lucas10',
      actorAlias: 'Lucas10',
      actorPhone: '+5493516549344'
    });

    await server.close();
  });

  it('POST /whatsapp/intake returns 400 when ownerContext is missing and no persisted phone link exists', async () => {
    const queue = new FakeQueue();
    const playerPhoneStore = new FakePlayerPhoneStore();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { playerPhoneStore }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/whatsapp/intake',
      payload: {
        pagina: 'ASN',
        body: {
          WaId: '5493515747477'
        }
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      message: 'Invalid payload',
      code: 'OWNER_CONTEXT_REQUIRED',
      details: {
        issues: [
          {
            path: 'ownerContext',
            message: 'ownerContext is required unless the phone already has a persisted owner link'
          }
        ]
      }
    });
    expect(playerPhoneStore.intakeInputs).toHaveLength(0);

    await server.close();
  });

  it('POST /whatsapp/intake returns 400 for unsupported pagina', async () => {
    const queue = new FakeQueue();
    const playerPhoneStore = new FakePlayerPhoneStore();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      { playerPhoneStore }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/whatsapp/intake',
      payload: {
        pagina: 'MGM',
        body: {
          WaId: '5493515747477'
        },
        ownerContext: {
          ownerKey: 'asnlucas10:lucas10',
          ownerLabel: 'Lucas10'
        }
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('INVALID_PAYLOAD');
    expect(response.json().details.issues.some((issue: { path: string }) => issue.path === 'pagina')).toBe(true);
    expect(playerPhoneStore.intakeInputs).toHaveLength(0);

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

  it('POST /users/assign-phone prechecks and assigns RdA users', async () => {
    const queue = new FakeQueue();
    const store = new FakePlayerPhoneStore();
    const rdaChecks: Array<{ usuario: string; agente: string; contrasenaAgente: string }> = [];
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      {
        playerPhoneStore: store,
        asnUserExistsChecker: async () => undefined,
        rdaUserExistsChecker: async (input) => {
          rdaChecks.push({
            usuario: input.usuario,
            agente: input.agente,
            contrasenaAgente: input.contrasenaAgente
          });
        }
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

    expect(response.statusCode).toBe(200);
    expect(rdaChecks).toEqual([{ usuario: 'player_1', agente: 'agent_1', contrasenaAgente: 'secret' }]);
    expect(store.assignByPhoneInputs).toHaveLength(1);
    expect(store.assignByPhoneInputs[0]?.pagina).toBe('RdA');

    await server.close();
  });

  it('POST /users/assign-phone returns 404 when RdA user does not exist', async () => {
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
        rdaUserExistsChecker: async () => {
          throw new RdaUserCheckError('NOT_FOUND', 'No se ha encontrado el usuario missing_player');
        }
      }
    );

    const response = await server.inject({
      method: 'POST',
      url: '/users/assign-phone',
      payload: {
        pagina: 'RdA',
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
      code: 'RDA_USER_NOT_FOUND',
      details: { usuario: 'missing_player' }
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
      expect(queued.options.headless).toBe(true);
      expect(queued.options.debug).toBe(false);
      expect(queued.options.slowMo).toBe(0);
      expect(queued.options.timeoutMs).toBe(15_000);
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

  it('POST /users/deposit enqueues ASN jobs without running the user precheck', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    let checkerCalls = 0;
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue,
      {
        asnUserExistsChecker: async () => {
          checkerCalls += 1;
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

      expect(response.statusCode).toBe(202);
    }

    expect(queue.requests).toHaveLength(4);
    expect(checkerCalls).toBe(0);

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

  it('POST /users/deposit enqueues RdA report job for reporte', async () => {
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

    expect(response.statusCode).toBe(202);
    const body = response.json();
    const queued = queue.requests.find((item) => item.id === body.jobId);
    expect(queued?.jobType).toBe('report');
    if (queued?.jobType === 'report') {
      expect(queued.payload.pagina).toBe('RdA');
      expect(queued.payload.operacion).toBe('reporte');
      expect(queued.payload.usuario).toBe('Ariel728');
      expect(queued.options.headless).toBe(true);
      expect(queued.options.debug).toBe(false);
      expect(queued.options.slowMo).toBe(0);
      expect(queued.options.timeoutMs).toBe(15_000);
    }

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
      expect(queued.options.debug).toBe(false);
      expect(queued.options.slowMo).toBe(0);
      expect(queued.options.timeoutMs).toBe(15_000);
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

  it('GET /jobs/:id returns RDA funds operation result payload when available', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue
    );

    const id = 'job-rda-funds-result';
    queue.entries.set(id, {
      id,
      jobType: 'deposit',
      status: 'succeeded',
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      artifactPaths: [],
      steps: [],
      result: {
        kind: 'rda-funds-operation',
        pagina: 'RdA',
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
      kind: 'rda-funds-operation',
      pagina: 'RdA',
      operacion: 'carga',
      usuario: 'Monica626',
      montoSolicitado: 500,
      montoAplicado: 500,
      montoAplicadoTexto: '500,00',
      saldoAntesNumero: 1000,
      saldoAntesTexto: '1.000,00',
      saldoDespuesNumero: '1.50000',
      saldoDespuesTexto: '1.500,00'
    });

    await server.close();
  });

  it('GET /jobs/:id returns RDA balance result payload when available', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue
    );

    const id = 'job-rda-balance-result';
    queue.entries.set(id, {
      id,
      jobType: 'balance',
      status: 'succeeded',
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      artifactPaths: [],
      steps: [],
      result: {
        kind: 'balance',
        pagina: 'RdA',
        operacion: 'consultar_saldo',
        usuario: 'pruebita',
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
      kind: 'balance',
      pagina: 'RdA',
      operacion: 'consultar_saldo',
      usuario: 'pruebita',
      saldoTexto: '30.525,35',
      saldoNumero: '30.52535'
    });

    await server.close();
  });

  it('GET /jobs/:id keeps RDA descarga_total saldoDespuesNumero unchanged', async () => {
    const queue = new FakeQueue();
    const appConfig = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });
    const logger = createLogger('silent', false);
    const server = createServer(
      appConfig,
      { host: '127.0.0.1', port: 3000, loginConcurrency: 3, jobTtlMinutes: 60 },
      logger,
      queue
    );

    const id = 'job-rda-descarga-total-result';
    queue.entries.set(id, {
      id,
      jobType: 'deposit',
      status: 'succeeded',
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      artifactPaths: [],
      steps: [],
      result: {
        kind: 'rda-funds-operation',
        pagina: 'RdA',
        operacion: 'descarga_total',
        usuario: 'Monica626',
        montoSolicitado: 1500,
        montoAplicado: 1500,
        montoAplicadoTexto: '1.500,00',
        saldoAntesNumero: 1500,
        saldoAntesTexto: '1.500,00',
        saldoDespuesNumero: 0,
        saldoDespuesTexto: '0,00'
      }
    });

    const response = await server.inject({
      method: 'GET',
      url: `/jobs/${id}`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().result).toEqual({
      kind: 'rda-funds-operation',
      pagina: 'RdA',
      operacion: 'descarga_total',
      usuario: 'Monica626',
      montoSolicitado: 1500,
      montoAplicado: 1500,
      montoAplicadoTexto: '1.500,00',
      saldoAntesNumero: 1500,
      saldoAntesTexto: '1.500,00',
      saldoDespuesNumero: 0,
      saldoDespuesTexto: '0,00'
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
