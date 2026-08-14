import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';
import { extractMetaSourceContext } from './meta-source-context';
import type { MetaSourceContext, PaginaCode } from './types';

const scrypt = promisify(scryptCallback);
const PASSWORD_HASH_PREFIX = 'scrypt';
const DEFAULT_KEY_LENGTH = 64;

export type MastercrmUserStoreErrorCode =
  | 'CONFIGURATION'
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'AUTHENTICATION'
  | 'INTERNAL';

export interface MastercrmUserRecord {
  id: number;
  username: string;
  routingKey: string;
  nombre: string;
  telefono: string | null;
  inversion: number;
  isActive: boolean;
  createdAt: string;
}

export interface CreateMastercrmUserInput {
  username: string;
  password: string;
  nombre: string;
  telefono?: string;
}

export interface AuthenticateMastercrmUserInput {
  username: string;
  password: string;
}

export interface LinkCashierToMastercrmUserInput {
  userId: number;
  ownerKey: string;
  pagina?: PaginaCode;
  confirmReplace?: boolean;
}

export interface GetMastercrmClientsDashboardInput {
  userId: number;
  month?: string;
  platform?: PaginaCode | 'all';
  ownerId?: string;
}

export interface UpsertMastercrmOwnerFinancialsInput {
  userId: number;
  month: string;
  adSpendArs: number;
  commissionPct: number;
}

export type MastercrmPaidAnalyticsChannel = 'landing' | 'meta_ctwa';
export type MastercrmAnalyticsChannel = MastercrmPaidAnalyticsChannel | 'organic';
export type MastercrmAnalyticsClientChannel = MastercrmAnalyticsChannel;
export type MastercrmIntakeTransport = 'whatsapp_qr' | 'n8n_webhook' | 'landing' | 'unknown';
export type MastercrmMarketingBudgetLevel = 'ad';

export interface GetMastercrmAnalyticsInput {
  userId: number;
  dateFrom: string;
  dateTo: string;
  channel?: MastercrmAnalyticsChannel | 'all';
  transport?: MastercrmIntakeTransport | 'all';
  campaignKey?: string;
  adKey?: string;
  platform?: PaginaCode | 'all';
  ownerId?: string;
}

export interface UpsertMastercrmMarketingBudgetInput {
  userId: number;
  id?: string;
  channel: MastercrmPaidAnalyticsChannel;
  level: MastercrmMarketingBudgetLevel;
  campaignKey: string;
  campaignName: string;
  adKey?: string | null;
  adName?: string | null;
  linkUrl?: string | null;
  dailyBudgetArs: number;
  activeFrom: string;
  activeTo?: string | null;
}

export interface DistributeMastercrmMarketingBudgetAdInput {
  channel: MastercrmPaidAnalyticsChannel;
  campaignKey: string;
  campaignName: string;
  adKey: string;
  adName?: string | null;
  linkUrl?: string | null;
}

export interface DistributeMastercrmMarketingBudgetsInput {
  userId: number;
  totalDailyBudgetArs: number;
  activeFrom: string;
  activeTo?: string | null;
  ads: DistributeMastercrmMarketingBudgetAdInput[];
}

export interface DeleteMastercrmMarketingBudgetInput {
  userId: number;
  budgetId: string;
}

export interface UpsertMastercrmOrganicQrBudgetInput {
  userId: number;
  id?: string;
  dailyBudgetArs: number;
  activeFrom: string;
  activeTo?: string | null;
}

export interface DeleteMastercrmOrganicQrBudgetInput {
  userId: number;
  budgetId: string;
}

export interface MastercrmUserCashierLinkRecord {
  userId: number;
  ownerKey: string;
  ownerLabel: string;
  pagina: PaginaCode;
  linked: true;
  replaced: boolean;
  previousOwnerKey: string | null;
}

export interface MastercrmLinkedOwnerRecord {
  ownerId: string;
  ownerKey: string;
  ownerLabel: string;
  pagina: PaginaCode;
  telefono: string | null;
}

export interface MastercrmOwnerFinancialInputsRecord {
  month: string;
  adSpendArs: number | null;
  commissionPct: number | null;
}

export interface MastercrmPrimaryKpisRecord {
  cargadoMesArs: number | null;
  gananciaEstimadaArs: number | null;
  roiEstimadoPct: number | null;
  costoPorLeadRealArs: number | null;
  conversionAsignadoPct: number | null;
}

export interface MastercrmStatsKpisRecord {
  clientesTotales: number;
  asignados: number;
  pendientes: number;
  cargadoHoyArs: number | null;
  cargadoMesArs: number | null;
  intakesMes: number;
  reingresosMes: number;
  asignacionesMes: number;
  asignacionesBacklogMes: number;
  tasaIntakeAsignacionPct: number | null;
  clientesConReporte: number;
  promedioCargaGeneralArs: number | null;
  tasaActivacionPct: number | null;
}

export interface MastercrmMonthlyFlowKpisRecord {
  intakesMes: number;
  reingresosMes: number;
  asignacionesMes: number;
  asignacionesBacklogMes: number;
  tasaIntakeAsignacionPct: number | null;
}

export interface MastercrmClosingPortfolioKpisRecord {
  clientesTotales: number;
  asignados: number;
  pendientes: number;
  cargadoHoyArs: number | null;
  cargadoMesArs: number | null;
  clientesConReporte: number;
  promedioCargaGeneralArs: number | null;
  tasaActivacionPct: number | null;
}

export interface MastercrmOwnerSummary {
  totalClients: number;
  assignedClients: number;
  pendingClients: number;
  reportDate: string | null;
  reportUpdatedAt: string | null;
  cargadoHoyTotal: number | null;
  cargadoMesTotal: number | null;
  hasReport: boolean;
  reportExpectedClients: number;
  reportCoveredClients: number;
  reportCoveragePct: number | null;
  cargadoHoyComplete: boolean;
}

export interface MastercrmOwnerClientRecord {
  id: string;
  username: string | null;
  telefono: string | null;
  pagina: PaginaCode;
  estado: 'assigned' | 'pending';
  source?: string | null;
  origen?: string | null;
  Campana?: string | null;
  lastCampaign?: string | null;
  attribution?: MastercrmClientAttribution;
  ownerKey: string;
  ownerLabel: string;
  firstSeenAt: string | null;
  cargadoHoy: number | null;
  cargadoMes: number | null;
  reportDate: string | null;
  isNewIntakeMes: boolean;
  isReingresoMes: boolean;
  assignedEnMes: boolean;
  assignedDesdeBacklogMes: boolean;
  identities?: {
    ASN: { username: string | null; estado: 'assigned' | 'pending'; ownerKey: string } | null;
    RdA: { username: string | null; estado: 'assigned' | 'pending'; ownerKey: string } | null;
  };
  cargadoHoyByPlatform?: { ASN: number | null; RdA: number | null };
  cargadoMesByPlatform?: { ASN: number | null; RdA: number | null };
  isNeutral?: boolean;
}

export type MastercrmClientAttributionKind = 'landing' | 'landing_unmatched' | 'meta_ctwa' | 'unknown';

export interface MastercrmClientAttributionMeta {
  referralSourceId: string | null;
  referralSourceUrl: string | null;
  referralHeadline: string | null;
  referralBody: string | null;
  referralSourceType: string | null;
  ctwaClid: string | null;
}

export interface MastercrmClientAttributionLanding {
  landingSessionId: string | null;
  platform: string | null;
  placement: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmId: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  campaignName: string | null;
  campaignId: string | null;
  adsetName: string | null;
  adsetId: string | null;
  adName: string | null;
  adId: string | null;
  legacyIdsOnly: boolean;
  fbclid: string | null;
  eventSourceUrl: string | null;
  whatsappUrl: string | null;
}

export interface MastercrmClientAttribution {
  kind: MastercrmClientAttributionKind;
  label: string;
  campaign: string | null;
  meta: MastercrmClientAttributionMeta;
  landing: MastercrmClientAttributionLanding;
}

export interface MastercrmMonthlyTrendPoint {
  month: string;
  reportDate: string | null;
  cargadoMesArs: number | null;
}

export interface MastercrmDashboardChartsRecord {
  monthlyTrend: MastercrmMonthlyTrendPoint[];
}

export interface MastercrmClientsDashboardRecord {
  linkedOwner: MastercrmLinkedOwnerRecord | null;
  linkedOwners?: MastercrmLinkedOwnerRecord[];
  routingKey?: string;
  platform?: PaginaCode | 'all';
  summary: MastercrmOwnerSummary | null;
  financialInputs: MastercrmOwnerFinancialInputsRecord;
  primaryKpis: MastercrmPrimaryKpisRecord;
  statsKpis: MastercrmStatsKpisRecord;
  monthlyFlowKpis: MastercrmMonthlyFlowKpisRecord;
  closingPortfolioKpis: MastercrmClosingPortfolioKpisRecord;
  charts: MastercrmDashboardChartsRecord;
  clientes: MastercrmOwnerClientRecord[];
}

export interface MastercrmMarketingBudgetRecord {
  id: string;
  channel: MastercrmPaidAnalyticsChannel;
  level: MastercrmMarketingBudgetLevel;
  campaignKey: string;
  campaignName: string;
  adKey: string | null;
  adName: string | null;
  linkUrl: string | null;
  dailyBudgetArs: number;
  activeFrom: string;
  activeTo: string | null;
  effectiveSpendArs: number;
  updatedAt: string | null;
}

export interface MastercrmOrganicQrBudgetRecord {
  id: string;
  dailyBudgetArs: number;
  activeFrom: string;
  activeTo: string | null;
  effectiveSpendArs: number;
  updatedAt: string | null;
}

export interface MastercrmAnalyticsMetricsRecord {
  investmentArs: number;
  revenueArs: number;
  estimatedProfitArs: number | null;
  roiPct: number | null;
  roas: number | null;
  leads: number;
  assigned: number;
  depositors: number;
  cplArs: number | null;
  costPerDepositorArs: number | null;
  leadToAssignedPct: number | null;
  leadToDepositorPct: number | null;
  averageRevenueArs: number | null;
}

export interface MastercrmAnalyticsChannelRecord extends MastercrmAnalyticsMetricsRecord {
  channel: MastercrmAnalyticsChannel;
  label: string;
  investmentSource: 'manual_budget' | null;
}

export interface MastercrmAnalyticsTransportRecord extends MastercrmAnalyticsMetricsRecord {
  transport: MastercrmIntakeTransport;
  label: string;
  uniqueChats: number;
  newClients: number;
  detectedUsers: number;
  withReport: number;
  reportCoveragePct: number | null;
}

export interface MastercrmAnalyticsFunnelRecord {
  uniqueChats: number;
  newClients: number;
  detectedUsers: number;
  assigned: number;
  withReport: number;
  depositors: number;
  loadArs: number;
  reportCoveragePct: number | null;
}

export interface MastercrmAnalyticsCampaignRecord extends MastercrmAnalyticsMetricsRecord {
  channel: MastercrmPaidAnalyticsChannel;
  campaignKey: string;
  campaignName: string;
  linkUrl: string | null;
  campaignBudgetArs: number;
  adBudgetArs: number;
  undistributedBudgetArs: number;
}

export interface MastercrmAnalyticsAdRecord extends MastercrmAnalyticsMetricsRecord {
  channel: MastercrmPaidAnalyticsChannel;
  campaignKey: string;
  campaignName: string;
  adKey: string;
  adName: string;
  linkUrl: string | null;
  hasOwnBudget: boolean;
}

export interface MastercrmAnalyticsClientRecord {
  clientId: string;
  username: string | null;
  telefono: string | null;
  estado: 'assigned' | 'pending';
  channel: MastercrmAnalyticsClientChannel;
  transport: MastercrmIntakeTransport;
  campaignKey: string;
  campaignName: string;
  adKey: string;
  adName: string;
  linkUrl: string | null;
  acquiredAt: string;
  revenueArs: number;
}

export interface MastercrmAnalyticsAuditRecord {
  unknownLeads: number;
  landingUnmatchedLeads: number;
  organicLeads: number;
  excludedLeads: number;
  reentryLeads: number;
  missingBudgetCampaigns: number;
  missingBudgetAds: number;
  negativeAdjustments: Array<{
    clientId: string;
    username: string | null;
    amountArs: number;
    fromDate: string;
    toDate: string;
  }>;
}

export interface MastercrmAnalyticsRecord {
  linkedOwner: MastercrmLinkedOwnerRecord | null;
  linkedOwners?: MastercrmLinkedOwnerRecord[];
  routingKey?: string;
  platform?: PaginaCode | 'all';
  filters: {
    dateFrom: string;
    dateTo: string;
    channel: MastercrmAnalyticsChannel | 'all';
    transport: MastercrmIntakeTransport | 'all';
    campaignKey: string | null;
    adKey: string | null;
  };
  summary: MastercrmAnalyticsMetricsRecord;
  funnel: MastercrmAnalyticsFunnelRecord;
  channels: MastercrmAnalyticsChannelRecord[];
  transports: MastercrmAnalyticsTransportRecord[];
  campaigns: MastercrmAnalyticsCampaignRecord[];
  ads: MastercrmAnalyticsAdRecord[];
  clients: MastercrmAnalyticsClientRecord[];
  budgets: MastercrmMarketingBudgetRecord[];
  organicQrBudgets: MastercrmOrganicQrBudgetRecord[];
  audit: MastercrmAnalyticsAuditRecord;
}

export interface CentralIntakeInput {
  routingKey: string;
  phoneE164: string;
  channelKey: string;
  actorAlias: string;
  actorPhone: string;
  messageSid?: string | null;
  payload?: Record<string, unknown>;
  occurredAt?: string;
  ttlSeconds?: number;
}

export interface CentralIntakeResult {
  userId: number;
  contactId: string;
  eventType: 'intake' | 'reentry' | 'resolved';
  routingKey: string;
  routeContext: { actorAlias: string; actorPhone: string };
  linkedOwners: MastercrmLinkedOwnerRecord[];
  expiresAt: string;
}

export interface MastercrmUserStore {
  createUser(input: CreateMastercrmUserInput): Promise<MastercrmUserRecord>;
  authenticate(input: AuthenticateMastercrmUserInput): Promise<MastercrmUserRecord>;
  getActiveUserById(id: number): Promise<MastercrmUserRecord>;
  getLinkedOwnerForUser(userId: number): Promise<MastercrmLinkedOwnerRecord | null>;
  getLinkedOwnersForUser?(userId: number): Promise<MastercrmLinkedOwnerRecord[]>;
  linkCashierToUser(input: LinkCashierToMastercrmUserInput): Promise<MastercrmUserCashierLinkRecord>;
  unlinkCashierFromUser?(input: { userId: number; pagina: PaginaCode }): Promise<{ unlinked: true; pagina: PaginaCode }>;
  createCentralIntake?(input: CentralIntakeInput): Promise<CentralIntakeResult>;
  resolveCentralRoute?(input: { channelKey: string; phoneE164: string; now?: string }): Promise<CentralIntakeResult | null>;
  getClientsDashboard(input: GetMastercrmClientsDashboardInput): Promise<MastercrmClientsDashboardRecord>;
  upsertOwnerFinancials(input: UpsertMastercrmOwnerFinancialsInput): Promise<MastercrmOwnerFinancialInputsRecord>;
  getMarketingAnalytics(input: GetMastercrmAnalyticsInput): Promise<MastercrmAnalyticsRecord>;
  upsertMarketingBudget(input: UpsertMastercrmMarketingBudgetInput): Promise<MastercrmMarketingBudgetRecord>;
  distributeMarketingBudgets(input: DistributeMastercrmMarketingBudgetsInput): Promise<MastercrmMarketingBudgetRecord[]>;
  deleteMarketingBudget(input: DeleteMastercrmMarketingBudgetInput): Promise<{ deleted: true; id: string }>;
  upsertOrganicQrBudget(input: UpsertMastercrmOrganicQrBudgetInput): Promise<MastercrmOrganicQrBudgetRecord>;
  deleteOrganicQrBudget(input: DeleteMastercrmOrganicQrBudgetInput): Promise<{ deleted: true; id: string }>;
}

interface MastercrmUserRow {
  id: number | string;
  username: string;
  routing_key: string;
  nombre: string;
  telefono: string | null;
  inversion: number | string | null;
  is_active: boolean;
  created_at: string;
}

interface DatabaseErrorLike {
  code?: string | null;
  message: string;
}

interface OwnerRow {
  id: string;
  owner_key: string;
  owner_label: string;
  pagina: PaginaCode;
}

interface UserOwnerLinkRow {
  id: string;
  owner_id: string;
  pagina: PaginaCode;
  owners: OwnerRow | OwnerRow[];
}

interface ClientRow {
  id: string;
  phone_e164: string | null;
  pagina: PaginaCode;
  created_at?: string | null;
}

interface OwnerClientMonthlyFactRow {
  owner_id: string;
  client_id: string;
  link_id: string;
  month_start: string;
  status_at_month_end: 'assigned' | 'pending';
  identity_id_at_month_end: string | null;
  username_at_month_end: string | null;
  had_intake_in_month: boolean;
  is_new_intake_in_month: boolean;
  is_reentry_in_month: boolean;
  had_assignment_in_month: boolean;
  assigned_from_backlog_in_month: boolean;
  clients: ClientRow | ClientRow[];
}

interface ReportDailySnapshotRow {
  identity_id?: string;
  client_id?: string;
  link_id?: string;
  report_date: string;
  username: string;
  cargado_hoy: number | string | null;
  cargado_mes: number | string | null;
}

interface OwnerNewClientMonthlyFactRow {
  client_id: string;
  month_start: string;
  cargado_mes_ars: number | string | null;
  report_date: string | null;
  has_report: boolean;
}

interface OwnerClientLinkFirstSeenRow {
  id: string;
  first_seen_at: string | null;
}

interface OwnerAliasRow {
  alias_phone: string | null;
  is_active: boolean;
  updated_at: string;
  last_seen_at: string;
}

interface OwnerFinancialSettingsRow {
  commission_pct: number | string | null;
}

interface OwnerMonthlyAdSpendRow {
  ad_spend_ars: number | string | null;
}

interface OwnerClientEventRow {
  client_id: string | null;
  event_type: 'intake' | 'assign_username' | 'unassign_username' | 'create_player' | 'link_sent';
  payload: Record<string, unknown> | null;
  occurred_at: string;
}

interface OwnerMarketingDailyBudgetRow {
  id: string;
  channel: MastercrmPaidAnalyticsChannel;
  level: MastercrmMarketingBudgetLevel;
  campaign_key: string;
  campaign_name: string;
  ad_key: string | null;
  ad_name: string | null;
  link_url: string | null;
  daily_budget_ars: number | string;
  active_from: string;
  active_to: string | null;
  updated_at: string | null;
}

interface OwnerOrganicQrDailyBudgetRow {
  id: string;
  daily_budget_ars: number | string;
  active_from: string;
  active_to: string | null;
  updated_at: string | null;
}

interface ReportRunFinishedAtRow {
  finished_at: string | null;
}

const MONTH_TOKEN_RE = /^\d{4}-\d{2}$/;
const DATE_TOKEN_RE = /^\d{4}-\d{2}-\d{2}$/;
export const SUPABASE_SELECT_PAGE_SIZE = 1000;
const SUPABASE_IN_FILTER_CHUNK_SIZE = 200;

export class MastercrmUserStoreError extends Error {
  constructor(
    public readonly code: MastercrmUserStoreErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'MastercrmUserStoreError';
  }
}

export function normalizeMastercrmUsername(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw new MastercrmUserStoreError('VALIDATION', 'username is required');
  }

  return normalized;
}

export function normalizeMastercrmNombre(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new MastercrmUserStoreError('VALIDATION', 'nombre is required');
  }

  return normalized;
}

export function normalizeMastercrmTelefono(value: string | undefined): string | null {
  if (value == null) {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function normalizeMastercrmOwnerKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw new MastercrmUserStoreError('VALIDATION', 'owner_key is required');
  }

  return normalized;
}

function mapDatabaseError(error: DatabaseErrorLike, fallbackMessage: string): MastercrmUserStoreError {
  const code = error.code ?? '';
  if (code === '23505' || code === '23P01') {
    return new MastercrmUserStoreError('CONFLICT', fallbackMessage);
  }
  if (code === '23514' || code === '22023' || code === '22P02') {
    return new MastercrmUserStoreError('VALIDATION', fallbackMessage);
  }
  if (code === 'PGRST116') {
    return new MastercrmUserStoreError('NOT_FOUND', fallbackMessage);
  }

  const detail = code ? `${fallbackMessage} (${code}: ${error.message})` : `${fallbackMessage}: ${error.message}`;
  return new MastercrmUserStoreError('INTERNAL', detail);
}

function mapPostgrestError(error: PostgrestError, fallbackMessage: string): MastercrmUserStoreError {
  return mapDatabaseError({ code: error.code, message: error.message }, fallbackMessage);
}

type SupabasePagedResult<Row> = {
  data: Row[] | null;
  error: PostgrestError | null;
};

type SupabasePagedQuery<Row> = PromiseLike<SupabasePagedResult<Row>> & {
  range(from: number, to: number): PromiseLike<SupabasePagedResult<Row>>;
};

export async function selectAllSupabasePages<Row>(
  buildQuery: () => SupabasePagedQuery<Row>,
  fallbackMessage: string,
  pageSize = SUPABASE_SELECT_PAGE_SIZE
): Promise<Row[]> {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new MastercrmUserStoreError('INTERNAL', 'Supabase page size must be a positive integer');
  }

  const rows: Row[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await buildQuery().range(offset, offset + pageSize - 1);
    if (error) {
      throw mapPostgrestError(error, fallbackMessage);
    }

    const pageRows = data ?? [];
    rows.push(...pageRows);

    if (pageRows.length < pageSize) {
      return rows;
    }

    offset += pageSize;
  }
}

async function selectAllSupabasePagesByChunks<Row, Value>(
  values: Value[],
  buildQuery: (chunk: Value[]) => SupabasePagedQuery<Row>,
  fallbackMessage: string,
  chunkSize = SUPABASE_IN_FILTER_CHUNK_SIZE
): Promise<Row[]> {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new MastercrmUserStoreError('INTERNAL', 'Supabase chunk size must be a positive integer');
  }

  const rows: Row[] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    const chunk = values.slice(index, index + chunkSize);
    rows.push(...(await selectAllSupabasePages(() => buildQuery(chunk), fallbackMessage)));
  }

  return rows;
}

function parsePasswordHash(passwordHash: string): { salt: Buffer; derivedKey: Buffer } {
  const [prefix, saltHex, keyHex] = passwordHash.split('$');
  if (prefix !== PASSWORD_HASH_PREFIX || !saltHex || !keyHex) {
    throw new MastercrmUserStoreError('INTERNAL', 'mastercrm_users.password_hash has invalid format');
  }

  return {
    salt: Buffer.from(saltHex, 'hex'),
    derivedKey: Buffer.from(keyHex, 'hex')
  };
}

export async function hashMastercrmPassword(password: string): Promise<string> {
  if (!password || password.trim().length === 0) {
    throw new MastercrmUserStoreError('VALIDATION', 'password is required');
  }

  const salt = randomBytes(16);
  const derivedKey = (await scrypt(password, salt, DEFAULT_KEY_LENGTH)) as Buffer;
  return `${PASSWORD_HASH_PREFIX}$${salt.toString('hex')}$${derivedKey.toString('hex')}`;
}

export async function verifyMastercrmPassword(password: string, passwordHash: string): Promise<boolean> {
  if (!password || password.trim().length === 0) {
    return false;
  }

  try {
    const { salt, derivedKey } = parsePasswordHash(passwordHash);
    const candidate = (await scrypt(password, salt, derivedKey.length)) as Buffer;
    return timingSafeEqual(candidate, derivedKey);
  } catch (error) {
    if (error instanceof MastercrmUserStoreError) {
      throw error;
    }
    throw new MastercrmUserStoreError('INTERNAL', 'Could not verify password hash', { cause: error });
  }
}

export function toMastercrmUserRecord(row: MastercrmUserRow): MastercrmUserRecord {
  const inversionValue = row.inversion == null ? 0 : Number(row.inversion);
  return {
    id: Number(row.id),
    username: row.username,
    routingKey: row.routing_key,
    nombre: row.nombre,
    telefono: row.telefono,
    inversion: Number.isFinite(inversionValue) ? inversionValue : 0,
    isActive: row.is_active,
    createdAt: row.created_at
  };
}

function unwrapSingleRelation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

function toFiniteNumber(value: number | string | null | undefined): number | null {
  if (value == null) {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function roundTo(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function compareIsoDatesDesc(left: string, right: string): number {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  const normalizedLeft = Number.isFinite(leftTime) ? leftTime : 0;
  const normalizedRight = Number.isFinite(rightTime) ? rightTime : 0;

  return normalizedRight - normalizedLeft;
}

function nullableText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function emptyAttribution(): MastercrmClientAttribution {
  return {
    kind: 'unknown',
    label: 'Sin dato',
    campaign: null,
    meta: {
      referralSourceId: null,
      referralSourceUrl: null,
      referralHeadline: null,
      referralBody: null,
      referralSourceType: null,
      ctwaClid: null
    },
    landing: {
      landingSessionId: null,
      platform: null,
      placement: null,
      utmSource: null,
      utmMedium: null,
      utmId: null,
      utmCampaign: null,
      utmContent: null,
      utmTerm: null,
      campaignName: null,
      campaignId: null,
      adsetName: null,
      adsetId: null,
      adName: null,
      adId: null,
      legacyIdsOnly: false,
      fbclid: null,
      eventSourceUrl: null,
      whatsappUrl: null
    }
  };
}

function isNumericMetaId(value: string | null): boolean {
  return typeof value === 'string' && /^\d+$/.test(value);
}

export function attributionFromSourceContext(sourceContext: MetaSourceContext | null): MastercrmClientAttribution {
  if (!sourceContext) {
    return emptyAttribution();
  }

  const meta: MastercrmClientAttributionMeta = {
    referralSourceId: nullableText(sourceContext.referralSourceId),
    referralSourceUrl: nullableText(sourceContext.referralSourceUrl),
    referralHeadline: nullableText(sourceContext.referralHeadline),
    referralBody: nullableText(sourceContext.referralBody),
    referralSourceType: nullableText(sourceContext.referralSourceType),
    ctwaClid: nullableText(sourceContext.ctwaClid)
  };
  const utmId = nullableText(sourceContext.utmId);
  const utmCampaign = nullableText(sourceContext.utmCampaign);
  const utmContent = nullableText(sourceContext.utmContent);
  const utmTerm = nullableText(sourceContext.utmTerm);
  const explicitAdsetId = nullableText(sourceContext.adsetId);
  const explicitAdId = nullableText(sourceContext.adId);
  const legacyCampaignId = !utmId && isNumericMetaId(utmCampaign) ? utmCampaign : null;
  const legacyAdsetId = !explicitAdsetId && isNumericMetaId(utmTerm) ? utmTerm : null;
  const legacyAdId = !explicitAdId && isNumericMetaId(utmContent) ? utmContent : null;
  const landing: MastercrmClientAttributionLanding = {
    landingSessionId: nullableText(sourceContext.landingSessionId),
    platform: nullableText(sourceContext.utmSource),
    placement: nullableText(sourceContext.placement),
    utmSource: nullableText(sourceContext.utmSource),
    utmMedium: nullableText(sourceContext.utmMedium),
    utmId,
    utmCampaign,
    utmContent,
    utmTerm,
    campaignName: legacyCampaignId ? null : utmCampaign,
    campaignId: utmId ?? legacyCampaignId,
    adsetName: legacyAdsetId ? null : utmTerm,
    adsetId: explicitAdsetId ?? legacyAdsetId,
    adName: legacyAdId ? null : utmContent,
    adId: explicitAdId ?? legacyAdId,
    legacyIdsOnly: Boolean(legacyCampaignId || legacyAdsetId || legacyAdId),
    fbclid: nullableText(sourceContext.fbclid),
    eventSourceUrl: nullableText(sourceContext.eventSourceUrl),
    whatsappUrl: nullableText(sourceContext.whatsappUrl)
  };
  const hasLandingSignal = Object.entries(landing).some(
    ([key, value]) => key !== 'legacyIdsOnly' && value !== null
  );
  const hasMetaSignal = Object.values(meta).some((value) => value !== null);

  if (landing.landingSessionId) {
    return {
      kind: 'landing',
      label: 'Landing',
      campaign:
        landing.campaignName ??
        landing.campaignId ??
        landing.adName ??
        landing.adId ??
        landing.fbclid ??
        landing.eventSourceUrl,
      meta,
      landing
    };
  }

  if (hasLandingSignal) {
    return {
      kind: 'landing_unmatched',
      label: 'Landing sin match',
      campaign:
        landing.campaignName ??
        landing.campaignId ??
        landing.adName ??
        landing.adId ??
        landing.fbclid ??
        landing.eventSourceUrl,
      meta,
      landing
    };
  }

  if (hasMetaSignal) {
    return {
      kind: 'meta_ctwa',
      label: 'Meta WhatsApp',
      campaign: meta.referralHeadline ?? meta.referralSourceId ?? meta.referralSourceUrl,
      meta,
      landing
    };
  }

  return emptyAttribution();
}

function pickFirstAttributionEvent(rows: OwnerClientEventRow[]): OwnerClientEventRow | null {
  const attributedRows = rows.filter((row) => attributionFromSourceContext(extractMetaSourceContext(row.payload)).kind !== 'unknown');
  const candidates = attributedRows.length > 0 ? attributedRows : rows;
  return [...candidates].sort((left, right) => compareIsoDatesDesc(right.occurred_at, left.occurred_at))[0] ?? null;
}

function pickFirstChronologicalEvent(rows: OwnerClientEventRow[]): OwnerClientEventRow | null {
  return [...rows].sort((left, right) => compareIsoDatesDesc(right.occurred_at, left.occurred_at))[0] ?? null;
}

export function isOrganicQrAcquisition(
  transport: MastercrmIntakeTransport,
  sourceContexts: Array<MetaSourceContext | null>
): boolean {
  return (
    transport === 'whatsapp_qr' &&
    sourceContexts.every((sourceContext) => attributionFromSourceContext(sourceContext).kind === 'unknown')
  );
}

interface AnalyticsAttributionShape {
  channel: MastercrmPaidAnalyticsChannel;
  label: string;
  campaignKey: string;
  campaignName: string;
  adKey: string;
  adName: string;
  linkUrl: string | null;
}

interface MutableAnalyticsMetrics {
  investmentArs: number;
  revenueArs: number;
  leads: number;
  assigned: number;
  depositors: number;
}

interface MutableCampaignAnalytics extends MutableAnalyticsMetrics {
  channel: MastercrmPaidAnalyticsChannel;
  campaignKey: string;
  campaignName: string;
  linkUrl: string | null;
  campaignBudgetArs: number;
  adBudgetArs: number;
  undistributedBudgetArs: number;
}

interface MutableAdAnalytics extends MutableAnalyticsMetrics {
  channel: MastercrmPaidAnalyticsChannel;
  campaignKey: string;
  campaignName: string;
  adKey: string;
  adName: string;
  linkUrl: string | null;
  hasOwnBudget: boolean;
}

function makeMutableMetrics(): MutableAnalyticsMetrics {
  return {
    investmentArs: 0,
    revenueArs: 0,
    leads: 0,
    assigned: 0,
    depositors: 0
  };
}

function buildMetaAdsManagerAdUrl(adId: string | null): string | null {
  if (!adId || !/^\d+$/.test(adId)) {
    return null;
  }

  const params = new URLSearchParams({ selected_ad_ids: adId });
  return `https://business.facebook.com/adsmanager/manage/ads?${params.toString()}`;
}

function buildAnalyticsAttribution(attribution: MastercrmClientAttribution): AnalyticsAttributionShape | null {
  if (attribution.kind === 'landing') {
    const landing = attribution.landing;
    const campaignKey = landing.campaignId ?? landing.campaignName ?? attribution.campaign ?? '';
    const campaignName = landing.campaignName ?? landing.campaignId ?? attribution.campaign ?? '';
    const adKey = landing.adId ?? landing.adName ?? landing.utmContent ?? landing.fbclid ?? landing.eventSourceUrl ?? '';
    const adName = landing.adName ?? landing.adId ?? landing.utmContent ?? adKey;
    const linkUrl = buildMetaAdsManagerAdUrl(landing.adId) ?? landing.eventSourceUrl ?? landing.whatsappUrl;

    if (!campaignKey || !adKey) {
      return null;
    }

    return {
      channel: 'landing',
      label: 'Landing',
      campaignKey,
      campaignName,
      adKey,
      adName,
      linkUrl
    };
  }

  if (attribution.kind === 'meta_ctwa') {
    const meta = attribution.meta;
    const campaignKey = meta.referralHeadline ?? meta.referralSourceId ?? meta.referralSourceUrl ?? '';
    const campaignName = meta.referralHeadline ?? meta.referralSourceId ?? meta.referralSourceUrl ?? '';
    const adKey = meta.referralSourceId ?? meta.referralSourceUrl ?? meta.ctwaClid ?? campaignKey;
    const adName = meta.referralHeadline ?? meta.referralSourceId ?? adKey;
    const linkUrl = meta.referralSourceUrl ?? buildMetaAdsManagerAdUrl(meta.referralSourceId);

    if (!campaignKey || !adKey) {
      return null;
    }

    return {
      channel: 'meta_ctwa',
      label: 'Meta WhatsApp',
      campaignKey,
      campaignName,
      adKey,
      adName,
      linkUrl
    };
  }

  return null;
}

function analyticsChannelLabel(channel: MastercrmAnalyticsChannel): string {
  if (channel === 'landing') {
    return 'Landing';
  }
  return channel === 'meta_ctwa' ? 'Meta WhatsApp' : 'Orgánico QR';
}

function analyticsGroupKey(...parts: Array<string | null | undefined>): string {
  return parts.map((part) => part ?? '').join('\u001f');
}

function normalizedPhoneKey(value: string | null | undefined): string {
  return (value ?? '').replace(/[^0-9]/g, '');
}

function calculateBudgetOverlapSpend(
  budget: Pick<OwnerMarketingDailyBudgetRow | OwnerOrganicQrDailyBudgetRow, 'daily_budget_ars' | 'active_from' | 'active_to'>,
  dateFrom: string,
  dateTo: string
): number {
  const overlapFrom = maxDateToken(budget.active_from, dateFrom);
  const overlapTo = minDateToken(budget.active_to ?? dateTo, dateTo);
  if (overlapFrom > overlapTo) {
    return 0;
  }

  const dailyBudget = toFiniteNumber(budget.daily_budget_ars) ?? 0;
  return roundTo(dailyBudget * countInclusiveDays(overlapFrom, overlapTo));
}

function normalizeOrganicQrBudgetRow(
  row: OwnerOrganicQrDailyBudgetRow,
  dateFrom: string,
  dateTo: string
): MastercrmOrganicQrBudgetRecord {
  return {
    id: row.id,
    dailyBudgetArs: toFiniteNumber(row.daily_budget_ars) ?? 0,
    activeFrom: row.active_from,
    activeTo: row.active_to,
    effectiveSpendArs: calculateBudgetOverlapSpend(row, dateFrom, dateTo),
    updatedAt: row.updated_at
  };
}

function normalizeBudgetRow(row: OwnerMarketingDailyBudgetRow, dateFrom: string, dateTo: string): MastercrmMarketingBudgetRecord {
  const adKey = nullableText(row.ad_key ?? '');
  return {
    id: row.id,
    channel: row.channel,
    level: row.level,
    campaignKey: row.campaign_key,
    campaignName: row.campaign_name,
    adKey,
    adName: row.ad_name,
    linkUrl: row.link_url,
    dailyBudgetArs: toFiniteNumber(row.daily_budget_ars) ?? 0,
    activeFrom: row.active_from,
    activeTo: row.active_to,
    effectiveSpendArs: calculateBudgetOverlapSpend(row, dateFrom, dateTo),
    updatedAt: row.updated_at
  };
}

function normalizeDistributedBudgetAds(
  ads: DistributeMastercrmMarketingBudgetAdInput[]
): DistributeMastercrmMarketingBudgetAdInput[] {
  if (!Array.isArray(ads) || ads.length < 2) {
    throw new MastercrmUserStoreError('VALIDATION', 'ads must include at least two ads');
  }

  const normalized = ads.map((ad) => {
    if (ad.channel !== 'landing' && ad.channel !== 'meta_ctwa') {
      throw new MastercrmUserStoreError('VALIDATION', 'all ads must use channel landing or meta_ctwa');
    }

    const campaignKey = nullableText(ad.campaignKey);
    const campaignName = nullableText(ad.campaignName);
    const adKey = nullableText(ad.adKey);
    const adName = nullableText(ad.adName ?? undefined) ?? adKey;

    if (!campaignKey || !campaignName || !adKey) {
      throw new MastercrmUserStoreError('VALIDATION', 'each ad must include campaign_key, campaign_name and ad_key');
    }

    return {
      channel: ad.channel,
      campaignKey,
      campaignName,
      adKey,
      adName,
      linkUrl: nullableText(ad.linkUrl ?? undefined)
    };
  });

  const channels = new Set(normalized.map((ad) => ad.channel));
  if (channels.size !== 1) {
    throw new MastercrmUserStoreError('VALIDATION', 'all ads must use the same channel');
  }

  const seen = new Set<string>();
  for (const ad of normalized) {
    const key = analyticsGroupKey(ad.channel, ad.campaignKey, ad.adKey);
    if (seen.has(key)) {
      throw new MastercrmUserStoreError('VALIDATION', 'ads must not include duplicates');
    }
    seen.add(key);
  }

  return normalized;
}

function mapDistributedBudgetRpcError(error: PostgrestError): MastercrmUserStoreError {
  if (error.code === '23505') {
    return new MastercrmUserStoreError(
      'CONFLICT',
      error.message || 'Marketing budget overlaps existing ads'
    );
  }
  if (error.code === '22023' || error.code === '23514') {
    return new MastercrmUserStoreError('VALIDATION', error.message || 'Invalid distributed marketing budget payload');
  }

  return mapPostgrestError(error, 'Could not distribute owner marketing budgets');
}

function finalizeAnalyticsMetrics(
  metrics: MutableAnalyticsMetrics,
  commissionPct: number | null
): MastercrmAnalyticsMetricsRecord {
  const investmentArs = roundTo(metrics.investmentArs);
  const revenueArs = roundTo(metrics.revenueArs);
  const estimatedProfitArs = commissionPct !== null ? roundTo(revenueArs * (commissionPct / 100)) : null;

  return {
    investmentArs,
    revenueArs,
    estimatedProfitArs,
    roiPct:
      estimatedProfitArs !== null && investmentArs > 0
        ? roundTo(((estimatedProfitArs - investmentArs) / investmentArs) * 100)
        : null,
    roas: investmentArs > 0 ? roundTo(revenueArs / investmentArs) : null,
    leads: metrics.leads,
    assigned: metrics.assigned,
    depositors: metrics.depositors,
    cplArs: metrics.leads > 0 ? roundTo(investmentArs / metrics.leads) : null,
    costPerDepositorArs: metrics.depositors > 0 ? roundTo(investmentArs / metrics.depositors) : null,
    leadToAssignedPct: metrics.leads > 0 ? roundTo((metrics.assigned / metrics.leads) * 100) : null,
    leadToDepositorPct: metrics.leads > 0 ? roundTo((metrics.depositors / metrics.leads) * 100) : null,
    averageRevenueArs: metrics.depositors > 0 ? roundTo(revenueArs / metrics.depositors) : null
  };
}

function pickPreferredAliasPhone(rows: OwnerAliasRow[]): string | null {
  const rowsWithPhone = rows.filter((row) => typeof row.alias_phone === 'string' && row.alias_phone.trim().length > 0);
  if (rowsWithPhone.length === 0) {
    return null;
  }

  const sorted = [...rowsWithPhone].sort((left, right) => {
    if (left.is_active !== right.is_active) {
      return left.is_active ? -1 : 1;
    }

    const updatedComparison = compareIsoDatesDesc(left.updated_at, right.updated_at);
    if (updatedComparison !== 0) {
      return updatedComparison;
    }

    return compareIsoDatesDesc(left.last_seen_at, right.last_seen_at);
  });

  return sorted[0]?.alias_phone ?? null;
}

function getBuenosAiresMonthToken(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(now);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;

  if (!year || !month) {
    throw new MastercrmUserStoreError('INTERNAL', 'Could not resolve Buenos Aires month token');
  }

  return `${year}-${month}`;
}

function normalizeMastercrmMonth(value: string | undefined): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) {
    return getBuenosAiresMonthToken();
  }

  if (!MONTH_TOKEN_RE.test(normalized)) {
    throw new MastercrmUserStoreError('VALIDATION', 'month must use YYYY-MM format');
  }

  const [, monthToken] = normalized.split('-');
  const monthValue = Number(monthToken);
  if (!Number.isInteger(monthValue) || monthValue < 1 || monthValue > 12) {
    throw new MastercrmUserStoreError('VALIDATION', 'month must use a valid YYYY-MM value');
  }

  return normalized;
}

function buildMonthWindow(month: string): {
  month: string;
  monthStartDate: string;
  nextMonthStartDate: string;
  startedAtIso: string;
  endedAtIso: string;
} {
  const normalizedMonth = normalizeMastercrmMonth(month);
  const [yearToken, monthToken] = normalizedMonth.split('-');
  const year = Number(yearToken);
  const monthIndex = Number(monthToken) - 1;
  const nextMonthYear = monthIndex === 11 ? year + 1 : year;
  const nextMonthIndex = (monthIndex + 1) % 12;
  const monthStartDate = `${normalizedMonth}-01`;
  const nextMonthStartDate = `${nextMonthYear}-${String(nextMonthIndex + 1).padStart(2, '0')}-01`;

  // Buenos Aires is UTC-3 and this project uses month boundaries in local BA time.
  const startedAtIso = new Date(Date.UTC(year, monthIndex, 1, 3, 0, 0, 0)).toISOString();
  const endedAtIso = new Date(Date.UTC(nextMonthYear, nextMonthIndex, 1, 3, 0, 0, 0)).toISOString();

  return {
    month: normalizedMonth,
    monthStartDate,
    nextMonthStartDate,
    startedAtIso,
    endedAtIso
  };
}

function buildMonthTrail(month: string, count = 6): Array<{
  month: string;
  monthStartDate: string;
  nextMonthStartDate: string;
}> {
  const normalizedMonth = normalizeMastercrmMonth(month);
  const [yearToken, monthToken] = normalizedMonth.split('-');
  const baseYear = Number(yearToken);
  const baseMonthIndex = Number(monthToken) - 1;
  const trail = [];

  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const currentDate = new Date(Date.UTC(baseYear, baseMonthIndex - offset, 1));
    const year = currentDate.getUTCFullYear();
    const monthIndex = currentDate.getUTCMonth();
    const nextDate = new Date(Date.UTC(year, monthIndex + 1, 1));
    const monthValue = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;

    trail.push({
      month: monthValue,
      monthStartDate: `${monthValue}-01`,
      nextMonthStartDate: `${nextDate.getUTCFullYear()}-${String(nextDate.getUTCMonth() + 1).padStart(2, '0')}-01`
    });
  }

  return trail;
}

function normalizeMastercrmDate(value: string, label: string): string {
  const normalized = value.trim();
  if (!DATE_TOKEN_RE.test(normalized)) {
    throw new MastercrmUserStoreError('VALIDATION', `${label} must use YYYY-MM-DD format`);
  }

  const [yearToken, monthToken, dayToken] = normalized.split('-');
  const year = Number(yearToken);
  const month = Number(monthToken);
  const day = Number(dayToken);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new MastercrmUserStoreError('VALIDATION', `${label} must be a real calendar date`);
  }

  return normalized;
}

function addDaysToDateToken(dateToken: string, days: number): string {
  const [yearToken, monthToken, dayToken] = dateToken.split('-');
  const date = new Date(Date.UTC(Number(yearToken), Number(monthToken) - 1, Number(dayToken) + days));
  return date.toISOString().slice(0, 10);
}

function toBuenosAiresStartIso(dateToken: string): string {
  const [yearToken, monthToken, dayToken] = dateToken.split('-');
  return new Date(Date.UTC(Number(yearToken), Number(monthToken) - 1, Number(dayToken), 3, 0, 0, 0)).toISOString();
}

function maxDateToken(left: string, right: string): string {
  return left >= right ? left : right;
}

function minDateToken(left: string, right: string): string {
  return left <= right ? left : right;
}

function countInclusiveDays(fromDate: string, toDate: string): number {
  const [fromYear, fromMonth, fromDay] = fromDate.split('-').map(Number);
  const [toYear, toMonth, toDay] = toDate.split('-').map(Number);
  const fromTime = Date.UTC(fromYear, fromMonth - 1, fromDay);
  const toTime = Date.UTC(toYear, toMonth - 1, toDay);
  return Math.max(0, Math.floor((toTime - fromTime) / 86_400_000) + 1);
}

function buildDateRangeWindow(dateFrom: string, dateTo: string): {
  dateFrom: string;
  dateTo: string;
  startedAtIso: string;
  endedAtIso: string;
  firstMonthStartDate: string;
  afterLastMonthStartDate: string;
  dayAfterDateTo: string;
  segments: Array<{
    month: string;
    monthStartDate: string;
    nextMonthStartDate: string;
    fromDate: string;
    toDate: string;
  }>;
} {
  const normalizedFrom = normalizeMastercrmDate(dateFrom, 'date_from');
  const normalizedTo = normalizeMastercrmDate(dateTo, 'date_to');

  if (normalizedFrom > normalizedTo) {
    throw new MastercrmUserStoreError('VALIDATION', 'date_from must be before or equal to date_to');
  }

  const firstMonth = normalizedFrom.slice(0, 7);
  const lastMonth = normalizedTo.slice(0, 7);
  const segments = [];
  let cursorMonth = firstMonth;

  while (cursorMonth <= lastMonth) {
    const monthWindow = buildMonthWindow(cursorMonth);
    const monthEndDate = addDaysToDateToken(monthWindow.nextMonthStartDate, -1);
    segments.push({
      month: cursorMonth,
      monthStartDate: monthWindow.monthStartDate,
      nextMonthStartDate: monthWindow.nextMonthStartDate,
      fromDate: maxDateToken(normalizedFrom, monthWindow.monthStartDate),
      toDate: minDateToken(normalizedTo, monthEndDate)
    });
    cursorMonth = monthWindow.nextMonthStartDate.slice(0, 7);
  }

  const afterLastMonthStartDate = buildMonthWindow(lastMonth).nextMonthStartDate;
  const dayAfterDateTo = addDaysToDateToken(normalizedTo, 1);

  return {
    dateFrom: normalizedFrom,
    dateTo: normalizedTo,
    startedAtIso: toBuenosAiresStartIso(normalizedFrom),
    endedAtIso: toBuenosAiresStartIso(dayAfterDateTo),
    firstMonthStartDate: `${firstMonth}-01`,
    afterLastMonthStartDate,
    dayAfterDateTo,
    segments
  };
}

function buildEmptyDashboard(month: string): MastercrmClientsDashboardRecord {
  const monthTrail = buildMonthTrail(month);
  const statsKpis: MastercrmStatsKpisRecord = {
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
  };

  return {
    linkedOwner: null,
    summary: null,
    financialInputs: {
      month,
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
    statsKpis,
    monthlyFlowKpis: {
      intakesMes: statsKpis.intakesMes,
      reingresosMes: statsKpis.reingresosMes,
      asignacionesMes: statsKpis.asignacionesMes,
      asignacionesBacklogMes: statsKpis.asignacionesBacklogMes,
      tasaIntakeAsignacionPct: statsKpis.tasaIntakeAsignacionPct
    },
    closingPortfolioKpis: {
      clientesTotales: statsKpis.clientesTotales,
      asignados: statsKpis.asignados,
      pendientes: statsKpis.pendientes,
      cargadoHoyArs: statsKpis.cargadoHoyArs,
      cargadoMesArs: statsKpis.cargadoMesArs,
      clientesConReporte: statsKpis.clientesConReporte,
      promedioCargaGeneralArs: statsKpis.promedioCargaGeneralArs,
      tasaActivacionPct: statsKpis.tasaActivacionPct
    },
    charts: {
      monthlyTrend: monthTrail.map((point) => ({
        month: point.month,
        reportDate: null,
        cargadoMesArs: null
      }))
    },
    clientes: []
  };
}

function mergePlatformDashboards(
  dashboards: MastercrmClientsDashboardRecord[],
  linkedOwners: MastercrmLinkedOwnerRecord[],
  routingKey: string,
  platform: PaginaCode | 'all'
): MastercrmClientsDashboardRecord {
  if (dashboards.length === 0) {
    const empty = buildEmptyDashboard(getBuenosAiresMonthToken());
    return { ...empty, linkedOwners, routingKey, platform };
  }

  const byPhone = new Map<string, MastercrmOwnerClientRecord>();
  for (const dashboard of dashboards) {
    for (const client of dashboard.clientes) {
      const phone = client.telefono ?? `id:${client.id}`;
      const existing = byPhone.get(phone);
      const identities = existing?.identities ?? { ASN: null, RdA: null };
      identities[client.pagina] = {
        username: client.username,
        estado: client.estado,
        ownerKey: client.ownerKey
      };
      const hoy = existing?.cargadoHoyByPlatform ?? { ASN: null, RdA: null };
      const mes = existing?.cargadoMesByPlatform ?? { ASN: null, RdA: null };
      hoy[client.pagina] = client.cargadoHoy;
      mes[client.pagina] = client.cargadoMes;
      const cargadoHoyValues = [hoy.ASN, hoy.RdA].filter((value): value is number => value !== null);
      const cargadoMesValues = [mes.ASN, mes.RdA].filter((value): value is number => value !== null);
      byPhone.set(phone, {
        ...(existing ?? client),
        id: existing?.id ?? client.id,
        username: existing?.username ?? client.username,
        estado: existing?.estado === 'assigned' || client.estado === 'assigned' ? 'assigned' : 'pending',
        firstSeenAt:
          existing?.firstSeenAt && client.firstSeenAt
            ? existing.firstSeenAt < client.firstSeenAt
              ? existing.firstSeenAt
              : client.firstSeenAt
            : existing?.firstSeenAt ?? client.firstSeenAt,
        cargadoHoy: cargadoHoyValues.length > 0 ? roundTo(cargadoHoyValues.reduce((sum, value) => sum + value, 0)) : null,
        cargadoMes: cargadoMesValues.length > 0 ? roundTo(cargadoMesValues.reduce((sum, value) => sum + value, 0)) : null,
        reportDate: [existing?.reportDate, client.reportDate].filter(Boolean).sort().pop() ?? null,
        isNewIntakeMes: Boolean(existing?.isNewIntakeMes || client.isNewIntakeMes),
        isReingresoMes: Boolean(existing?.isReingresoMes || client.isReingresoMes),
        assignedEnMes: Boolean(existing?.assignedEnMes || client.assignedEnMes),
        assignedDesdeBacklogMes: Boolean(existing?.assignedDesdeBacklogMes || client.assignedDesdeBacklogMes),
        identities,
        cargadoHoyByPlatform: hoy,
        cargadoMesByPlatform: mes,
        isNeutral: false
      });
    }
  }

  const clientes = [...byPhone.values()];
  const totalClients = clientes.length;
  const assignedClients = clientes.filter((client) => client.estado === 'assigned').length;
  const pendingClients = totalClients - assignedClients;
  const cargadoHoyValues = clientes.map((client) => client.cargadoHoy).filter((value): value is number => value !== null);
  const cargadoMesValues = clientes.map((client) => client.cargadoMes).filter((value): value is number => value !== null);
  const cargadoHoyTotal = cargadoHoyValues.length ? roundTo(cargadoHoyValues.reduce((sum, value) => sum + value, 0)) : null;
  const cargadoMesTotal = cargadoMesValues.length ? roundTo(cargadoMesValues.reduce((sum, value) => sum + value, 0)) : null;
  const first = dashboards[0];
  const adSpendArs = first.financialInputs.adSpendArs;
  const commissionPct = first.financialInputs.commissionPct;
  const intakesMes = clientes.filter((client) => client.isNewIntakeMes).length;
  const reingresosMes = clientes.filter((client) => client.isReingresoMes).length;
  const asignacionesMes = clientes.filter((client) => client.assignedEnMes && !client.assignedDesdeBacklogMes).length;
  const asignacionesBacklogMes = clientes.filter((client) => client.assignedDesdeBacklogMes).length;
  const clientesConReporte = clientes.filter((client) => client.reportDate).length;
  const gananciaEstimadaArs = commissionPct !== null && cargadoMesTotal !== null
    ? roundTo(cargadoMesTotal * (commissionPct / 100))
    : null;
  const statsKpis: MastercrmStatsKpisRecord = {
    clientesTotales: totalClients,
    asignados: assignedClients,
    pendientes: pendingClients,
    cargadoHoyArs: cargadoHoyTotal,
    cargadoMesArs: cargadoMesTotal,
    intakesMes,
    reingresosMes,
    asignacionesMes,
    asignacionesBacklogMes,
    tasaIntakeAsignacionPct: intakesMes ? roundTo((clientes.filter((client) => client.isNewIntakeMes && client.estado === 'assigned').length / intakesMes) * 100) : null,
    clientesConReporte,
    promedioCargaGeneralArs: cargadoMesTotal !== null && totalClients ? roundTo(cargadoMesTotal / totalClients) : null,
    tasaActivacionPct: totalClients ? roundTo((clientesConReporte / totalClients) * 100) : null
  };
  const trendByMonth = new Map<string, MastercrmMonthlyTrendPoint>();
  for (const dashboard of dashboards) {
    for (const point of dashboard.charts.monthlyTrend) {
      const previous = trendByMonth.get(point.month);
      const values = [previous?.cargadoMesArs, point.cargadoMesArs].filter((value): value is number => value !== null && value !== undefined);
      trendByMonth.set(point.month, {
        month: point.month,
        reportDate: [previous?.reportDate, point.reportDate].filter(Boolean).sort().pop() ?? null,
        cargadoMesArs: values.length ? roundTo(values.reduce((sum, value) => sum + value, 0)) : null
      });
    }
  }

  return {
    linkedOwner: linkedOwners[0] ?? null,
    linkedOwners,
    routingKey,
    platform,
    summary: {
      totalClients,
      assignedClients,
      pendingClients,
      reportDate: dashboards.map((dashboard) => dashboard.summary?.reportDate).filter(Boolean).sort().pop() ?? null,
      reportUpdatedAt: dashboards.map((dashboard) => dashboard.summary?.reportUpdatedAt).filter(Boolean).sort().pop() ?? null,
      cargadoHoyTotal,
      cargadoMesTotal,
      hasReport: clientesConReporte > 0,
      reportExpectedClients: totalClients,
      reportCoveredClients: clientesConReporte,
      reportCoveragePct: totalClients ? roundTo((clientesConReporte / totalClients) * 100) : null,
      cargadoHoyComplete: cargadoHoyTotal !== null
    },
    financialInputs: first.financialInputs,
    primaryKpis: {
      cargadoMesArs: cargadoMesTotal,
      gananciaEstimadaArs,
      roiEstimadoPct: gananciaEstimadaArs !== null && adSpendArs !== null && adSpendArs > 0
        ? roundTo(((gananciaEstimadaArs - adSpendArs) / adSpendArs) * 100)
        : null,
      costoPorLeadRealArs: adSpendArs !== null && intakesMes ? roundTo(adSpendArs / intakesMes) : null,
      conversionAsignadoPct: totalClients ? roundTo((assignedClients / totalClients) * 100) : null
    },
    statsKpis,
    monthlyFlowKpis: {
      intakesMes,
      reingresosMes,
      asignacionesMes,
      asignacionesBacklogMes,
      tasaIntakeAsignacionPct: statsKpis.tasaIntakeAsignacionPct
    },
    closingPortfolioKpis: {
      clientesTotales: totalClients,
      asignados: assignedClients,
      pendientes: pendingClients,
      cargadoHoyArs: cargadoHoyTotal,
      cargadoMesArs: cargadoMesTotal,
      clientesConReporte,
      promedioCargaGeneralArs: statsKpis.promedioCargaGeneralArs,
      tasaActivacionPct: statsKpis.tasaActivacionPct
    },
    charts: { monthlyTrend: [...trendByMonth.values()].sort((a, b) => a.month.localeCompare(b.month)) },
    clientes
  };
}

function buildEmptyAnalytics(
  window: ReturnType<typeof buildDateRangeWindow>,
  linkedOwner: MastercrmLinkedOwnerRecord | null = null,
  filters: Pick<MastercrmAnalyticsRecord['filters'], 'channel' | 'transport' | 'campaignKey' | 'adKey'> = {
    channel: 'all',
    transport: 'all',
    campaignKey: null,
    adKey: null
  }
): MastercrmAnalyticsRecord {
  return {
    linkedOwner,
    filters: {
      dateFrom: window.dateFrom,
      dateTo: window.dateTo,
      channel: filters.channel,
      transport: filters.transport,
      campaignKey: filters.campaignKey,
      adKey: filters.adKey
    },
    summary: finalizeAnalyticsMetrics(makeMutableMetrics(), null),
    funnel: {
      uniqueChats: 0,
      newClients: 0,
      detectedUsers: 0,
      assigned: 0,
      withReport: 0,
      depositors: 0,
      loadArs: 0,
      reportCoveragePct: null
    },
    channels: [],
    transports: [],
    campaigns: [],
    ads: [],
    clients: [],
    budgets: [],
    organicQrBudgets: [],
    audit: {
      unknownLeads: 0,
      landingUnmatchedLeads: 0,
      organicLeads: 0,
      excludedLeads: 0,
      reentryLeads: 0,
      missingBudgetCampaigns: 0,
      missingBudgetAds: 0,
      negativeAdjustments: []
    }
  };
}

function mergeAnalyticsRecords(
  records: MastercrmAnalyticsRecord[],
  linkedOwners: MastercrmLinkedOwnerRecord[],
  routingKey: string,
  platform: PaginaCode | 'all',
  window: ReturnType<typeof buildDateRangeWindow>,
  filters: Pick<MastercrmAnalyticsRecord['filters'], 'channel' | 'transport' | 'campaignKey' | 'adKey'>
): MastercrmAnalyticsRecord {
  if (records.length === 0) {
    return {
      ...buildEmptyAnalytics(window, null, filters),
      linkedOwners,
      routingKey,
      platform
    };
  }

  const clientByPhone = new Map<string, MastercrmAnalyticsClientRecord>();
  for (const record of records) {
    for (const client of record.clients) {
      const key = client.telefono ? normalizedPhoneKey(client.telefono) : `id:${client.clientId}`;
      const previous = clientByPhone.get(key);
      if (!previous) {
        clientByPhone.set(key, { ...client });
        continue;
      }
      clientByPhone.set(key, {
        ...previous,
        username: previous.username ?? client.username,
        estado: previous.estado === 'assigned' || client.estado === 'assigned' ? 'assigned' : 'pending',
        acquiredAt: previous.acquiredAt < client.acquiredAt ? previous.acquiredAt : client.acquiredAt,
        revenueArs: roundTo(previous.revenueArs + client.revenueArs)
      });
    }
  }

  const clients = [...clientByPhone.values()].sort((left, right) => right.revenueArs - left.revenueArs);
  const first = records[0];
  const budgets = first.budgets;
  const organicQrBudgets = first.organicQrBudgets;
  const commissionPct =
    first.summary.revenueArs > 0 && first.summary.estimatedProfitArs !== null
      ? roundTo((first.summary.estimatedProfitArs / first.summary.revenueArs) * 100)
      : null;

  const investmentByChannel = new Map<MastercrmAnalyticsChannel, number>([
    ['landing', roundTo(budgets.filter((budget) => budget.channel === 'landing').reduce((sum, budget) => sum + budget.effectiveSpendArs, 0))],
    ['meta_ctwa', roundTo(budgets.filter((budget) => budget.channel === 'meta_ctwa').reduce((sum, budget) => sum + budget.effectiveSpendArs, 0))],
    ['organic', roundTo(organicQrBudgets.reduce((sum, budget) => sum + budget.effectiveSpendArs, 0))]
  ]);

  const groupMetrics = <Key extends string>(keyOf: (client: MastercrmAnalyticsClientRecord) => Key) => {
    const grouped = new Map<Key, MutableAnalyticsMetrics>();
    for (const client of clients) {
      const key = keyOf(client);
      const metrics = grouped.get(key) ?? makeMutableMetrics();
      metrics.leads += 1;
      metrics.assigned += client.estado === 'assigned' ? 1 : 0;
      metrics.depositors += client.revenueArs > 0 ? 1 : 0;
      metrics.revenueArs = roundTo(metrics.revenueArs + client.revenueArs);
      grouped.set(key, metrics);
    }
    return grouped;
  };

  const channelMetrics = groupMetrics((client) => client.channel);
  const channels = [...channelMetrics.entries()].map(([channel, metrics]) => {
    metrics.investmentArs = investmentByChannel.get(channel) ?? 0;
    return {
      channel,
      label: analyticsChannelLabel(channel),
      investmentSource: metrics.investmentArs > 0 ? ('manual_budget' as const) : null,
      ...finalizeAnalyticsMetrics(metrics, commissionPct)
    };
  });

  const transportMetrics = groupMetrics((client) => client.transport);
  const transports = [...transportMetrics.entries()].map(([transport, metrics]) => {
    const transportClients = clients.filter((client) => client.transport === transport);
    metrics.investmentArs = roundTo(
      [...new Set(transportClients.map((client) => client.channel))]
        .reduce((sum, channel) => sum + (investmentByChannel.get(channel) ?? 0), 0)
    );
    const withReport = records
      .flatMap((record) => record.transports)
      .filter((row) => row.transport === transport)
      .reduce((sum, row) => sum + row.withReport, 0);
    return {
      transport,
      label: first.transports.find((row) => row.transport === transport)?.label ?? transport,
      ...finalizeAnalyticsMetrics(metrics, commissionPct),
      uniqueChats: transportClients.length,
      newClients: transportClients.length,
      detectedUsers: transportClients.filter((client) => Boolean(client.username)).length,
      withReport: Math.min(withReport, transportClients.length),
      reportCoveragePct: transportClients.length ? roundTo((Math.min(withReport, transportClients.length) / transportClients.length) * 100) : null
    };
  });

  const summaryMutable = makeMutableMetrics();
  summaryMutable.investmentArs = roundTo([...investmentByChannel.values()].reduce((sum, value) => sum + value, 0));
  summaryMutable.revenueArs = roundTo(clients.reduce((sum, client) => sum + client.revenueArs, 0));
  summaryMutable.leads = clients.length;
  summaryMutable.assigned = clients.filter((client) => client.estado === 'assigned').length;
  summaryMutable.depositors = clients.filter((client) => client.revenueArs > 0).length;
  const summary = finalizeAnalyticsMetrics(summaryMutable, commissionPct);
  const withReport = Math.min(records.reduce((sum, record) => sum + record.funnel.withReport, 0), clients.length);

  return {
    linkedOwner: linkedOwners[0] ?? null,
    linkedOwners,
    routingKey,
    platform,
    filters: { dateFrom: window.dateFrom, dateTo: window.dateTo, ...filters },
    summary,
    funnel: {
      uniqueChats: clients.length,
      newClients: clients.length,
      detectedUsers: clients.filter((client) => Boolean(client.username)).length,
      assigned: summary.assigned,
      withReport,
      depositors: summary.depositors,
      loadArs: summary.revenueArs,
      reportCoveragePct: clients.length ? roundTo((withReport / clients.length) * 100) : null
    },
    channels,
    transports,
    campaigns: first.campaigns,
    ads: first.ads,
    clients,
    budgets,
    organicQrBudgets,
    audit: {
      unknownLeads: records.reduce((sum, record) => sum + record.audit.unknownLeads, 0),
      landingUnmatchedLeads: records.reduce((sum, record) => sum + record.audit.landingUnmatchedLeads, 0),
      organicLeads: records.reduce((sum, record) => sum + record.audit.organicLeads, 0),
      excludedLeads: records.reduce((sum, record) => sum + record.audit.excludedLeads, 0),
      reentryLeads: records.reduce((sum, record) => sum + record.audit.reentryLeads, 0),
      missingBudgetCampaigns: first.audit.missingBudgetCampaigns,
      missingBudgetAds: first.audit.missingBudgetAds,
      negativeAdjustments: records.flatMap((record) => record.audit.negativeAdjustments)
    }
  };
}

class SupabaseMastercrmUserStore implements MastercrmUserStore {
  private readonly linkedOwnerCache = new Map<string, OwnerRow>();
  private readonly activeUserCache = new Map<number, MastercrmUserRecord>();
  private readonly ownerPhoneCache = new Map<string, string | null>();

  constructor(private readonly client: SupabaseClient) {}

  private async getLinkedOwnerRows(userId: number): Promise<OwnerRow[]> {
    const { data, error } = await this.client
      .from('mastercrm_user_owner_links')
      .select('id, owner_id, pagina, created_at, owners!inner(id, owner_key, owner_label, pagina)')
      .eq('mastercrm_user_id', userId)
      .order('created_at', { ascending: true });

    if (error) {
      throw mapPostgrestError(error, 'Could not read linked cashier owner');
    }

    const rows = data ? (Array.isArray(data) ? data : [data]) as UserOwnerLinkRow[] : [];
    const owners = rows
      .map((row) => unwrapSingleRelation(row.owners))
      .filter((owner): owner is OwnerRow => Boolean(owner));
    for (const owner of owners) this.linkedOwnerCache.set(`${userId}:${owner.id}`, owner);
    return owners;
  }

  private async getLinkedOwnerRow(userId: number, ownerId?: string): Promise<OwnerRow | null> {
    if (ownerId) {
      const cached = this.linkedOwnerCache.get(`${userId}:${ownerId}`);
      if (cached) return cached;
    }
    const owners = await this.getLinkedOwnerRows(userId);
    return ownerId ? owners.find((owner) => owner.id === ownerId) ?? null : owners[0] ?? null;
  }

  private async getOwnerPhone(ownerId: string): Promise<string | null> {
    if (this.ownerPhoneCache.has(ownerId)) return this.ownerPhoneCache.get(ownerId) ?? null;
    const { data, error } = await this.client
      .from('owner_aliases')
      .select('alias_phone, is_active, updated_at, last_seen_at')
      .eq('owner_id', ownerId);

    if (error) {
      throw mapPostgrestError(error, 'Could not read owner alias phones');
    }

    const phone = pickPreferredAliasPhone((data as OwnerAliasRow[] | null) ?? []);
    this.ownerPhoneCache.set(ownerId, phone);
    return phone;
  }

  async getLinkedOwnerForUser(userId: number): Promise<MastercrmLinkedOwnerRecord | null> {
    const owner = await this.getLinkedOwnerRow(userId);
    if (!owner) {
      return null;
    }

    return {
      ownerId: owner.id,
      ownerKey: owner.owner_key,
      ownerLabel: owner.owner_label,
      pagina: owner.pagina,
      telefono: await this.getOwnerPhone(owner.id)
    };
  }

  async getLinkedOwnersForUser(userId: number): Promise<MastercrmLinkedOwnerRecord[]> {
    const owners = await this.getLinkedOwnerRows(userId);
    return Promise.all(
      owners.map(async (owner) => ({
        ownerId: owner.id,
        ownerKey: owner.owner_key,
        ownerLabel: owner.owner_label,
        pagina: owner.pagina,
        telefono: await this.getOwnerPhone(owner.id)
      }))
    );
  }

  async createUser(input: CreateMastercrmUserInput): Promise<MastercrmUserRecord> {
    const username = normalizeMastercrmUsername(input.username);
    const nombre = normalizeMastercrmNombre(input.nombre);
    const telefono = normalizeMastercrmTelefono(input.telefono);
    const passwordHash = await hashMastercrmPassword(input.password);

    const { data, error } = await this.client
      .from('mastercrm_users')
      .insert({
        username,
        routing_key: username,
        password_hash: passwordHash,
        nombre,
        telefono
      })
      .select('id, username, routing_key, nombre, telefono, inversion, is_active, created_at')
      .single();

    if (error) {
      throw mapPostgrestError(error, 'Could not create mastercrm user');
    }

    return toMastercrmUserRecord(data as MastercrmUserRow);
  }

  async authenticate(input: AuthenticateMastercrmUserInput): Promise<MastercrmUserRecord> {
    const username = normalizeMastercrmUsername(input.username);
    if (!input.password || input.password.trim().length === 0) {
      throw new MastercrmUserStoreError('VALIDATION', 'password is required');
    }

    const { data, error } = await this.client
      .from('mastercrm_users')
      .select('id, username, routing_key, nombre, telefono, inversion, is_active, created_at, password_hash')
      .eq('username', username)
      .maybeSingle();

    if (error) {
      throw mapPostgrestError(error, 'Could not read mastercrm user');
    }
    if (!data) {
      throw new MastercrmUserStoreError('AUTHENTICATION', 'Invalid username or password');
    }

    const row = data as MastercrmUserRow & { password_hash: string };
    if (!row.is_active) {
      throw new MastercrmUserStoreError('AUTHENTICATION', 'Invalid username or password');
    }

    const validPassword = await verifyMastercrmPassword(input.password, row.password_hash);
    if (!validPassword) {
      throw new MastercrmUserStoreError('AUTHENTICATION', 'Invalid username or password');
    }

    return toMastercrmUserRecord(row);
  }

  async getActiveUserById(id: number): Promise<MastercrmUserRecord> {
    if (!Number.isInteger(id) || id < 1) {
      throw new MastercrmUserStoreError('VALIDATION', 'id must be a positive integer');
    }
    const cached = this.activeUserCache.get(id);
    if (cached) return cached;

    const { data, error } = await this.client
      .from('mastercrm_users')
      .select('id, username, routing_key, nombre, telefono, inversion, is_active, created_at')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      throw mapPostgrestError(error, 'MasterCRM user not found');
    }
    if (!data || !(data as MastercrmUserRow).is_active) {
      throw new MastercrmUserStoreError('NOT_FOUND', 'MasterCRM user not found');
    }

    const user = toMastercrmUserRecord(data as MastercrmUserRow);
    this.activeUserCache.set(id, user);
    return user;
  }

  async linkCashierToUser(input: LinkCashierToMastercrmUserInput): Promise<MastercrmUserCashierLinkRecord> {
    if (!Number.isInteger(input.userId) || input.userId < 1) {
      throw new MastercrmUserStoreError('VALIDATION', 'user_id must be a positive integer');
    }

    const ownerKey = normalizeMastercrmOwnerKey(input.ownerKey);
    const pagina = input.pagina ?? 'ASN';
    await this.getActiveUserById(input.userId);

    const { data: ownerData, error: ownerError } = await this.client
      .from('owners')
      .select('id, owner_key, owner_label, pagina')
      .eq('pagina', pagina)
      .eq('owner_key', ownerKey)
      .maybeSingle();

    if (ownerError) {
      throw mapPostgrestError(ownerError, 'Cashier owner_key not found');
    }
    if (!ownerData) {
      throw new MastercrmUserStoreError('NOT_FOUND', 'Cashier owner_key not found');
    }

    const owner = ownerData as OwnerRow;
    const { data: existingLinkData, error: existingLinkError } = await this.client
      .from('mastercrm_user_owner_links')
      .select('id, owner_id, pagina, owners!inner(id, owner_key, owner_label, pagina)')
      .eq('mastercrm_user_id', input.userId)
      .eq('pagina', pagina)
      .maybeSingle();

    if (existingLinkError) {
      throw mapPostgrestError(existingLinkError, 'Could not read existing MasterCRM user-owner link');
    }

    const existingLink = existingLinkData as UserOwnerLinkRow | null;
    const existingOwner = unwrapSingleRelation(existingLink?.owners);
    const previousOwnerKey = existingOwner?.owner_key ?? null;
    const replaced = Boolean(previousOwnerKey && previousOwnerKey !== owner.owner_key);

    if (replaced && !input.confirmReplace) {
      throw new MastercrmUserStoreError('CONFLICT', 'OWNER_REPLACEMENT_CONFIRMATION_REQUIRED');
    }

    const { error: linkError } = await this.client.rpc('mastercrm_link_platform_owner_v1', {
      p_mastercrm_user_id: input.userId,
      p_owner_id: owner.id,
      p_pagina: pagina,
      p_confirm_replace: Boolean(input.confirmReplace),
      p_edited_by: `mastercrm:${input.userId}`
    });
    if (linkError) {
      throw mapPostgrestError(linkError, 'Could not link MasterCRM user to cashier');
    }
    for (const key of this.linkedOwnerCache.keys()) {
      if (key.startsWith(`${input.userId}:`)) this.linkedOwnerCache.delete(key);
    }

    return {
      userId: input.userId,
      ownerKey: owner.owner_key,
      ownerLabel: owner.owner_label,
      pagina: owner.pagina,
      linked: true,
      replaced,
      previousOwnerKey
    };
  }

  async unlinkCashierFromUser(input: { userId: number; pagina: PaginaCode }): Promise<{ unlinked: true; pagina: PaginaCode }> {
    await this.getActiveUserById(input.userId);
    const { data, error } = await this.client.rpc('mastercrm_unlink_platform_owner_v1', {
      p_mastercrm_user_id: input.userId,
      p_pagina: input.pagina,
      p_edited_by: `mastercrm:${input.userId}`
    });
    if (error) throw mapPostgrestError(error, 'Could not unlink MasterCRM platform owner');
    if (data !== true) throw new MastercrmUserStoreError('NOT_FOUND', 'Panel not linked');
    for (const key of this.linkedOwnerCache.keys()) {
      if (key.startsWith(`${input.userId}:`)) this.linkedOwnerCache.delete(key);
    }
    return { unlinked: true, pagina: input.pagina };
  }

  async createCentralIntake(input: CentralIntakeInput): Promise<CentralIntakeResult> {
    const { data, error } = await this.client.rpc('mastercrm_central_intake_v1', {
      p_routing_key: normalizeMastercrmUsername(input.routingKey),
      p_phone_e164: input.phoneE164,
      p_channel_key: input.channelKey,
      p_actor_alias: input.actorAlias.trim(),
      p_actor_phone: input.actorPhone,
      p_message_sid: input.messageSid ?? null,
      p_payload: input.payload ?? {},
      p_occurred_at: input.occurredAt ?? new Date().toISOString(),
      p_ttl_seconds: input.ttlSeconds ?? 86_400
    });
    if (error) {
      if (error.message.includes('MASTERCRM_ROUTING_KEY_NOT_FOUND')) {
        throw new MastercrmUserStoreError('NOT_FOUND', 'MasterCRM routingKey not found');
      }
      throw mapPostgrestError(error, 'Could not persist central WhatsApp intake');
    }
    const row = (Array.isArray(data) ? data[0] : data) as {
      mastercrm_user_id: number | string;
      contact_id: string;
      event_type: 'intake' | 'reentry';
      routing_key: string;
      actor_alias?: string;
      actor_phone?: string;
      expires_at: string;
    } | null;
    if (!row) throw new MastercrmUserStoreError('INTERNAL', 'Central intake returned no row');
    return {
      userId: Number(row.mastercrm_user_id),
      contactId: row.contact_id,
      eventType: row.event_type,
      routingKey: row.routing_key,
      routeContext: {
        actorAlias: row.actor_alias ?? input.actorAlias.trim(),
        actorPhone: row.actor_phone ?? input.actorPhone
      },
      linkedOwners: await this.getLinkedOwnersForUser(Number(row.mastercrm_user_id)),
      expiresAt: row.expires_at
    };
  }

  async resolveCentralRoute(input: { channelKey: string; phoneE164: string; now?: string }): Promise<CentralIntakeResult | null> {
    const { data, error } = await this.client
      .from('mastercrm_portfolio_routes')
      .select('mastercrm_user_id, contact_id, routing_key, actor_alias, actor_phone, expires_at')
      .eq('channel_key', input.channelKey)
      .eq('phone_e164', input.phoneE164)
      .gt('expires_at', input.now ?? new Date().toISOString())
      .maybeSingle();
    if (error) throw mapPostgrestError(error, 'Could not resolve central WhatsApp route');
    if (!data) return null;
    const row = data as {
      mastercrm_user_id: number | string;
      contact_id: string;
      routing_key: string;
      actor_alias: string;
      actor_phone: string;
      expires_at: string;
    };
    return {
      userId: Number(row.mastercrm_user_id),
      contactId: row.contact_id,
      eventType: 'resolved',
      routingKey: row.routing_key,
      routeContext: { actorAlias: row.actor_alias, actorPhone: row.actor_phone },
      linkedOwners: await this.getLinkedOwnersForUser(Number(row.mastercrm_user_id)),
      expiresAt: row.expires_at
    };
  }

  private async addCentralContactsToDashboard(
    dashboard: MastercrmClientsDashboardRecord,
    userId: number,
    linkedOwners: MastercrmLinkedOwnerRecord[],
    routingKey: string,
    platform: PaginaCode | 'all',
    month: string
  ): Promise<MastercrmClientsDashboardRecord> {
    const base = { ...dashboard, linkedOwner: linkedOwners[0] ?? null, linkedOwners, routingKey, platform };
    if (platform !== 'all') return base;
    const window = buildMonthWindow(month);
    const contacts = await selectAllSupabasePages<{
      id: string;
      phone_e164: string;
      first_seen_at: string;
      last_seen_at: string;
    }>(
      () =>
        this.client
          .from('mastercrm_portfolio_contacts')
          .select('id, phone_e164, first_seen_at, last_seen_at')
          .eq('mastercrm_user_id', userId)
          .gte('first_seen_at', `${window.monthStartDate}T00:00:00.000Z`)
          .lt('first_seen_at', `${window.nextMonthStartDate}T00:00:00.000Z`)
          .order('first_seen_at', { ascending: true }),
      'Could not read central portfolio contacts'
    );
    const existingPhones = new Set(base.clientes.map((client) => client.telefono).filter(Boolean));
    const missing = contacts.filter((contact) => !existingPhones.has(contact.phone_e164));
    if (missing.length === 0) return base;
    const onlyOwner = linkedOwners.length === 1 ? linkedOwners[0] : null;
    const fallbackPagina = onlyOwner?.pagina ?? linkedOwners[0]?.pagina ?? 'RdA';
    const extraClients: MastercrmOwnerClientRecord[] = missing.map((contact) => ({
      id: contact.id,
      username: null,
      telefono: contact.phone_e164,
      pagina: fallbackPagina,
      estado: 'pending',
      source: 'Webhook WhatsApp',
      origen: 'Webhook WhatsApp',
      Campana: null,
      lastCampaign: null,
      attribution: emptyAttribution(),
      ownerKey: onlyOwner?.ownerKey ?? routingKey,
      ownerLabel: onlyOwner?.ownerLabel ?? routingKey,
      firstSeenAt: contact.first_seen_at,
      cargadoHoy: null,
      cargadoMes: null,
      reportDate: null,
      isNewIntakeMes: true,
      isReingresoMes: false,
      assignedEnMes: false,
      assignedDesdeBacklogMes: false,
      identities: {
        ASN: onlyOwner?.pagina === 'ASN' ? { username: null, estado: 'pending', ownerKey: onlyOwner.ownerKey } : null,
        RdA: onlyOwner?.pagina === 'RdA' ? { username: null, estado: 'pending', ownerKey: onlyOwner.ownerKey } : null
      },
      cargadoHoyByPlatform: { ASN: null, RdA: null },
      cargadoMesByPlatform: { ASN: null, RdA: null },
      isNeutral: linkedOwners.length !== 1
    }));
    const clientes = [...base.clientes, ...extraClients];
    const totalClients = clientes.length;
    const assignedClients = clientes.filter((client) => client.estado === 'assigned').length;
    const pendingClients = totalClients - assignedClients;
    const intakesMes = base.statsKpis.intakesMes + missing.length;
    const adSpendArs = base.financialInputs.adSpendArs;
    return {
      ...base,
      clientes,
      summary: base.summary
        ? {
            ...base.summary,
            totalClients,
            assignedClients,
            pendingClients,
            reportExpectedClients: totalClients,
            reportCoveragePct: totalClients
              ? roundTo((base.summary.reportCoveredClients / totalClients) * 100)
              : null
          }
        : {
            totalClients,
            assignedClients,
            pendingClients,
            reportDate: null,
            reportUpdatedAt: null,
            cargadoHoyTotal: null,
            cargadoMesTotal: null,
            hasReport: false,
            reportExpectedClients: totalClients,
            reportCoveredClients: 0,
            reportCoveragePct: null,
            cargadoHoyComplete: false
          },
      primaryKpis: {
        ...base.primaryKpis,
        costoPorLeadRealArs: adSpendArs !== null && intakesMes ? roundTo(adSpendArs / intakesMes) : null,
        conversionAsignadoPct: totalClients ? roundTo((assignedClients / totalClients) * 100) : null
      },
      statsKpis: {
        ...base.statsKpis,
        clientesTotales: totalClients,
        asignados: assignedClients,
        pendientes: pendingClients,
        intakesMes,
        tasaIntakeAsignacionPct: intakesMes
          ? roundTo((clientes.filter((client) => client.isNewIntakeMes && client.estado === 'assigned').length / intakesMes) * 100)
          : null,
        promedioCargaGeneralArs:
          base.statsKpis.cargadoMesArs !== null && totalClients
            ? roundTo(base.statsKpis.cargadoMesArs / totalClients)
            : null,
        tasaActivacionPct: totalClients
          ? roundTo((base.statsKpis.clientesConReporte / totalClients) * 100)
          : null
      },
      monthlyFlowKpis: { ...base.monthlyFlowKpis, intakesMes },
      closingPortfolioKpis: {
        ...base.closingPortfolioKpis,
        clientesTotales: totalClients,
        asignados: assignedClients,
        pendientes: pendingClients
      }
    };
  }

  async getClientsDashboard(input: GetMastercrmClientsDashboardInput): Promise<MastercrmClientsDashboardRecord> {
    if (!Number.isInteger(input.userId) || input.userId < 1) {
      throw new MastercrmUserStoreError('VALIDATION', 'id must be a positive integer');
    }

    const user = await this.getActiveUserById(input.userId);
    const monthWindow = buildMonthWindow(input.month ?? getBuenosAiresMonthToken());
    const monthTrail = buildMonthTrail(monthWindow.month);
    if (!input.ownerId) {
      const linkedOwners = await this.getLinkedOwnersForUser(input.userId);
      const platform = input.platform ?? 'all';
      const selectedOwners = platform === 'all'
        ? linkedOwners
        : linkedOwners.filter((owner) => owner.pagina === platform);
      const dashboards = await Promise.all(
        selectedOwners.map((owner) =>
          this.getClientsDashboard({
            ...input,
            platform,
            ownerId: owner.ownerId
          })
        )
      );
      const merged = mergePlatformDashboards(dashboards, linkedOwners, user.routingKey, platform);
      return this.addCentralContactsToDashboard(
        merged,
        input.userId,
        linkedOwners,
        user.routingKey,
        platform,
        monthWindow.month
      );
    }
    const owner = await this.getLinkedOwnerRow(input.userId, input.ownerId);
    if (!owner) {
      return buildEmptyDashboard(monthWindow.month);
    }

    const [
      ownerPhone,
      factsForSelectedMonth,
      latestReportDateResult,
      financialSettingsResult,
      adSpendResult
    ] =
      await Promise.all([
        this.getOwnerPhone(owner.id),
        selectAllSupabasePages<OwnerClientMonthlyFactRow>(
          () =>
            this.client
              .from('owner_client_monthly_facts')
              .select(
                'owner_id, client_id, link_id, month_start, status_at_month_end, identity_id_at_month_end, username_at_month_end, had_intake_in_month, is_new_intake_in_month, is_reentry_in_month, had_assignment_in_month, assigned_from_backlog_in_month, clients!inner(id, phone_e164, pagina, created_at)'
              )
              .eq('owner_id', owner.id)
              .eq('month_start', monthWindow.monthStartDate)
              .order('client_id', { ascending: true }),
          'Could not read owner client monthly facts'
        ),
        this.client
          .from('report_daily_snapshots')
          .select('report_date')
          .eq('owner_id', owner.id)
          .gte('report_date', monthWindow.monthStartDate)
          .lt('report_date', monthWindow.nextMonthStartDate)
          .order('report_date', { ascending: false })
          .limit(1),
        this.client
          .from('mastercrm_portfolio_financial_settings')
          .select('commission_pct')
          .eq('mastercrm_user_id', input.userId)
          .maybeSingle(),
        this.client
          .from('mastercrm_portfolio_monthly_ad_spend')
          .select('ad_spend_ars')
          .eq('mastercrm_user_id', input.userId)
          .eq('month_start', monthWindow.monthStartDate)
          .maybeSingle()
      ]);

    if (latestReportDateResult.error) {
      throw mapPostgrestError(latestReportDateResult.error, 'Could not read owner report date');
    }
    if (financialSettingsResult.error) {
      throw mapPostgrestError(financialSettingsResult.error, 'Could not read owner financial settings');
    }
    if (adSpendResult.error) {
      throw mapPostgrestError(adSpendResult.error, 'Could not read owner monthly ad spend');
    }

    const monthlyClientSnapshotRows = await selectAllSupabasePages<{ client_id: string | null }>(
      () =>
        this.client
          .from('report_daily_snapshots')
          .select('client_id')
          .eq('owner_id', owner.id)
          .gte('report_date', monthWindow.monthStartDate)
          .lt('report_date', monthWindow.nextMonthStartDate)
          .order('report_date', { ascending: true })
          .order('client_id', { ascending: true }),
      'Could not read owner monthly client snapshots'
    );

    const monthlyTrendSnapshots = await selectAllSupabasePages<{
      client_id: string | null;
      report_date: string;
      cargado_mes: number | string | null;
    }>(
      () =>
        this.client
          .from('report_daily_snapshots')
          .select('client_id, report_date, cargado_mes')
          .eq('owner_id', owner.id)
          .gte('report_date', monthTrail[0]?.monthStartDate ?? monthWindow.monthStartDate)
          .lt('report_date', monthWindow.nextMonthStartDate)
          .order('report_date', { ascending: true })
          .order('identity_id', { ascending: true }),
      'Could not read owner monthly trend snapshots'
    );

    const closedMonthlyFacts = await selectAllSupabasePages<OwnerNewClientMonthlyFactRow>(
      () =>
        this.client
          .from('owner_new_client_monthly_facts')
          .select('client_id, month_start, cargado_mes_ars, report_date, has_report')
          .eq('owner_id', owner.id)
          .gte('month_start', monthTrail[0]?.monthStartDate ?? monthWindow.monthStartDate)
          .lt('month_start', monthWindow.monthStartDate)
          .order('month_start', { ascending: true })
          .order('client_id', { ascending: true }),
      'Could not read closed owner monthly facts'
    );

    const linkedOwner: MastercrmLinkedOwnerRecord = {
      ownerId: owner.id,
      ownerKey: owner.owner_key,
      ownerLabel: owner.owner_label,
      pagina: owner.pagina,
      telefono: ownerPhone
    };
    const factsForTrendMonths = factsForSelectedMonth;

    const dashboardMonthFacts = factsForSelectedMonth.filter((fact) => fact.is_new_intake_in_month);
    const dashboardClientIds = new Set(dashboardMonthFacts.map((fact) => fact.client_id));
    const ownerClientLinkIds = dashboardMonthFacts
      .map((fact) => (typeof fact.link_id === 'string' && fact.link_id.length > 0 ? fact.link_id : null))
      .filter((linkId): linkId is string => Boolean(linkId));
    const linkFirstSeenById = new Map<string, string | null>();
    const attributionByClientId = new Map<string, MastercrmClientAttribution>();

    if (ownerClientLinkIds.length > 0) {
      const ownerClientLinks = await selectAllSupabasePagesByChunks<OwnerClientLinkFirstSeenRow, string>(
        ownerClientLinkIds,
        (chunk) =>
          this.client
            .from('owner_client_links')
            .select('id, first_seen_at')
            .eq('owner_id', owner.id)
            .in('id', chunk)
            .order('id', { ascending: true }),
        'Could not read owner client links'
      );
      for (const link of ownerClientLinks) {
        linkFirstSeenById.set(link.id, link.first_seen_at ?? null);
      }
    }

    if (dashboardClientIds.size > 0) {
      const ownerClientEvents = await selectAllSupabasePagesByChunks<OwnerClientEventRow, string>(
        [...dashboardClientIds],
        (chunk) =>
          this.client
            .from('owner_client_events')
            .select('client_id, event_type, payload, occurred_at')
            .eq('owner_id', owner.id)
            .eq('event_type', 'intake')
            .in('client_id', chunk)
            .order('client_id', { ascending: true })
            .order('occurred_at', { ascending: true }),
        'Could not read owner client attribution events'
      );
      const eventsByClientId = new Map<string, OwnerClientEventRow[]>();
      for (const event of ownerClientEvents) {
        if (!event.client_id || !dashboardClientIds.has(event.client_id)) {
          continue;
        }

        const events = eventsByClientId.get(event.client_id) ?? [];
        events.push(event);
        eventsByClientId.set(event.client_id, events);
      }

      for (const [clientId, events] of eventsByClientId.entries()) {
        const event = pickFirstAttributionEvent(events);
        attributionByClientId.set(clientId, attributionFromSourceContext(extractMetaSourceContext(event?.payload)));
      }
    }

    const totalClients = dashboardMonthFacts.length;
    const assignedClients = dashboardMonthFacts.filter((fact) => fact.status_at_month_end === 'assigned').length;
    const pendingClients = dashboardMonthFacts.filter((fact) => fact.status_at_month_end === 'pending').length;
    const conversionAsignadoPct =
      totalClients > 0 ? roundTo((assignedClients / totalClients) * 100) : null;

    const latestReportDateRows = (latestReportDateResult.data as Array<{ report_date: string }> | null) ?? [];
    const reportDate = latestReportDateRows[0]?.report_date ?? null;
    const principalKey = owner.owner_key.split(':')[0] ?? owner.owner_key;
    let reportUpdatedAt: string | null = null;

    let cargadoHoyTotal: number | null = null;
    let cargadoMesTotal: number | null = null;
    const reportClientIds = new Set(
      monthlyClientSnapshotRows
        .map((snapshot) => (typeof snapshot.client_id === 'string' ? snapshot.client_id : null))
        .filter((clientId): clientId is string => Boolean(clientId))
        .filter((clientId) => dashboardClientIds.has(clientId))
    );
    let clientesConReporte = reportClientIds.size;
    const snapshotByClientId = new Map<
      string,
      { cargadoHoy: number | null; cargadoMes: number | null; reportDate: string | null }
    >();

    if (reportDate) {
      const snapshots = await selectAllSupabasePages<ReportDailySnapshotRow>(
        () =>
          this.client
            .from('report_daily_snapshots')
            .select('identity_id, client_id, report_date, username, cargado_hoy, cargado_mes')
            .eq('owner_id', owner.id)
            .eq('report_date', reportDate)
            .order('client_id', { ascending: true })
            .order('identity_id', { ascending: true }),
        'Could not read owner report snapshots'
      );
      cargadoHoyTotal = 0;
      cargadoMesTotal = 0;
      let cargadoHoyIncomplete = false;

      for (const snapshot of snapshots) {
        const clientId = typeof snapshot.client_id === 'string' && snapshot.client_id.length > 0 ? snapshot.client_id : null;
        if (!clientId || !dashboardClientIds.has(clientId)) {
          continue;
        }

        const cargadoHoy = toFiniteNumber(snapshot.cargado_hoy);
        const cargadoMes = toFiniteNumber(snapshot.cargado_mes);
        const existing = snapshotByClientId.get(clientId);
        const combinedCargadoHoy =
          cargadoHoy === null || existing?.cargadoHoy === null
            ? null
            : roundTo((existing?.cargadoHoy ?? 0) + cargadoHoy);
        snapshotByClientId.set(clientId, {
          cargadoHoy: combinedCargadoHoy,
          cargadoMes: roundTo((existing?.cargadoMes ?? 0) + (cargadoMes ?? 0)),
          reportDate: snapshot.report_date
        });
        if (cargadoHoy === null) {
          cargadoHoyIncomplete = true;
        } else {
          cargadoHoyTotal += cargadoHoy;
        }
        cargadoMesTotal += cargadoMes ?? 0;
      }
      clientesConReporte = snapshotByClientId.size;
      if (cargadoHoyIncomplete) {
        cargadoHoyTotal = null;
      }

      const { data: reportRunData, error: reportRunError } = await this.client
        .from('report_runs')
        .select('finished_at')
        .eq('pagina', owner.pagina)
        .eq('principal_key', principalKey)
        .eq('report_date', reportDate)
        .in('status', ['completed', 'completed_with_errors'])
        .order('finished_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (reportRunError) {
        throw mapPostgrestError(reportRunError, 'Could not read owner report run timestamp');
      }

      reportUpdatedAt = (reportRunData as ReportRunFinishedAtRow | null)?.finished_at ?? null;
    }

    const financialSettings = financialSettingsResult.data as OwnerFinancialSettingsRow | null;
    const adSpendRow = adSpendResult.data as OwnerMonthlyAdSpendRow | null;
    const monthlyTrendByMonth = new Map<string, { reportDate: string; cargadoMesArs: number }>();
    const newClientIdsByMonth = new Map<string, Set<string>>();
    const closedTrendMonths = new Set<string>();

    for (const fact of closedMonthlyFacts) {
      const monthToken = fact.month_start.slice(0, 7);
      const clientIds = newClientIdsByMonth.get(monthToken) ?? new Set<string>();
      clientIds.add(fact.client_id);
      newClientIdsByMonth.set(monthToken, clientIds);
      closedTrendMonths.add(monthToken);

      if (!fact.has_report || !fact.report_date) {
        continue;
      }
      const existing = monthlyTrendByMonth.get(monthToken);
      monthlyTrendByMonth.set(monthToken, {
        reportDate: fact.report_date,
        cargadoMesArs: roundTo((existing?.cargadoMesArs ?? 0) + (toFiniteNumber(fact.cargado_mes_ars) ?? 0))
      });
    }

    for (const fact of factsForTrendMonths) {
      if (!fact.is_new_intake_in_month) {
        continue;
      }

      const monthToken = fact.month_start.slice(0, 7);
      const clientIds = newClientIdsByMonth.get(monthToken) ?? new Set<string>();
      clientIds.add(fact.client_id);
      newClientIdsByMonth.set(monthToken, clientIds);
    }

    for (const snapshot of monthlyTrendSnapshots) {
      const monthToken = snapshot.report_date.slice(0, 7);
      if (!monthTrail.some((point) => point.month === monthToken)) {
        continue;
      }
      if (closedTrendMonths.has(monthToken)) {
        continue;
      }
      const clientId = typeof snapshot.client_id === 'string' && snapshot.client_id.length > 0 ? snapshot.client_id : null;
      if (!clientId || !newClientIdsByMonth.get(monthToken)?.has(clientId)) {
        continue;
      }

      const cargadoMes = toFiniteNumber(snapshot.cargado_mes) ?? 0;
      const existing = monthlyTrendByMonth.get(monthToken);
      if (!existing || compareIsoDatesDesc(existing.reportDate, snapshot.report_date) > 0) {
        monthlyTrendByMonth.set(monthToken, {
          reportDate: snapshot.report_date,
          cargadoMesArs: cargadoMes
        });
        continue;
      }

      if (existing.reportDate === snapshot.report_date) {
        monthlyTrendByMonth.set(monthToken, {
          reportDate: existing.reportDate,
          cargadoMesArs: roundTo(existing.cargadoMesArs + cargadoMes)
        });
      }
    }

    const monthlyTrend: MastercrmMonthlyTrendPoint[] = monthTrail.map((point) => {
      const entry = monthlyTrendByMonth.get(point.month);
      return {
        month: point.month,
        reportDate: entry?.reportDate ?? null,
        cargadoMesArs: entry?.cargadoMesArs ?? null
      };
    });

    const commissionPct = toFiniteNumber(financialSettings?.commission_pct);
    const adSpendArs = toFiniteNumber(adSpendRow?.ad_spend_ars);
    const intakesMes = dashboardMonthFacts.filter((fact) => fact.is_new_intake_in_month).length;
    const reingresosMes = dashboardMonthFacts.filter((fact) => fact.is_reentry_in_month).length;
    const asignacionesBacklogMes = dashboardMonthFacts.filter((fact) => fact.assigned_from_backlog_in_month).length;
    const asignacionesMes = dashboardMonthFacts.filter(
      (fact) => fact.had_assignment_in_month && !fact.assigned_from_backlog_in_month
    ).length;
    const assignedIntakeClientCount = dashboardMonthFacts.filter(
      (fact) => fact.is_new_intake_in_month && fact.status_at_month_end === 'assigned'
    ).length;
    const tasaIntakeAsignacionPct = intakesMes > 0 ? roundTo((assignedIntakeClientCount / intakesMes) * 100) : null;
    const promedioCargaGeneralArs =
      cargadoMesTotal !== null && totalClients > 0 ? roundTo(cargadoMesTotal / totalClients) : null;
    const tasaActivacionPct =
      totalClients > 0 ? roundTo((clientesConReporte / totalClients) * 100) : null;
    const gananciaEstimadaArs =
      commissionPct !== null && cargadoMesTotal !== null
        ? roundTo(cargadoMesTotal * (commissionPct / 100))
        : null;
    const costoPorLeadRealArs =
      adSpendArs !== null && intakesMes > 0 ? roundTo(adSpendArs / intakesMes) : null;
    const roiEstimadoPct =
      gananciaEstimadaArs !== null && adSpendArs !== null && adSpendArs > 0
        ? roundTo(((gananciaEstimadaArs - adSpendArs) / adSpendArs) * 100)
        : null;
    const statsKpis: MastercrmStatsKpisRecord = {
      clientesTotales: totalClients,
      asignados: assignedClients,
      pendientes: pendingClients,
      cargadoHoyArs: cargadoHoyTotal,
      cargadoMesArs: cargadoMesTotal,
      intakesMes,
      reingresosMes,
      asignacionesMes,
      asignacionesBacklogMes,
      tasaIntakeAsignacionPct,
      clientesConReporte,
      promedioCargaGeneralArs,
      tasaActivacionPct
    };

    const clientes: MastercrmOwnerClientRecord[] = dashboardMonthFacts
      .map((fact) => {
        const client = unwrapSingleRelation(fact.clients);
        const snapshot = snapshotByClientId.get(fact.client_id);
        const attribution = attributionByClientId.get(fact.client_id) ?? emptyAttribution();

        return {
          id: fact.link_id,
          username: fact.status_at_month_end === 'assigned' ? fact.username_at_month_end ?? null : null,
          telefono: client?.phone_e164 ?? null,
          pagina: client?.pagina ?? owner.pagina,
          estado: fact.status_at_month_end,
          source: attribution.label === 'Sin dato' ? null : attribution.label,
          origen: attribution.label === 'Sin dato' ? null : attribution.label,
          Campana: attribution.campaign,
          lastCampaign: attribution.campaign,
          attribution,
          ownerKey: owner.owner_key,
          ownerLabel: owner.owner_label,
          firstSeenAt: linkFirstSeenById.get(fact.link_id) ?? client?.created_at ?? null,
          cargadoHoy: snapshot?.cargadoHoy ?? null,
          cargadoMes: snapshot?.cargadoMes ?? null,
          reportDate: snapshot?.reportDate ?? null,
          isNewIntakeMes: fact.is_new_intake_in_month,
          isReingresoMes: fact.is_reentry_in_month,
          assignedEnMes: fact.had_assignment_in_month,
          assignedDesdeBacklogMes: fact.assigned_from_backlog_in_month
        };
      })
      .sort((left, right) => {
        if (left.estado !== right.estado) {
          return left.estado === 'assigned' ? -1 : 1;
        }

        const leftLabel = left.username ?? left.telefono ?? '';
        const rightLabel = right.username ?? right.telefono ?? '';
        return leftLabel.localeCompare(rightLabel);
      });

    return {
      linkedOwner,
      summary: {
        totalClients,
        assignedClients,
        pendingClients,
        reportDate,
        reportUpdatedAt,
        cargadoHoyTotal,
        cargadoMesTotal,
        hasReport: Boolean(reportDate),
        reportExpectedClients: totalClients,
        reportCoveredClients: clientesConReporte,
        reportCoveragePct: totalClients > 0 ? roundTo((clientesConReporte / totalClients) * 100) : null,
        cargadoHoyComplete: Boolean(reportDate) && cargadoHoyTotal !== null
      },
      financialInputs: {
        month: monthWindow.month,
        adSpendArs,
        commissionPct
      },
      primaryKpis: {
        cargadoMesArs: cargadoMesTotal,
        gananciaEstimadaArs,
        roiEstimadoPct,
        costoPorLeadRealArs,
        conversionAsignadoPct
      },
      statsKpis,
      monthlyFlowKpis: {
        intakesMes: statsKpis.intakesMes,
        reingresosMes: statsKpis.reingresosMes,
        asignacionesMes: statsKpis.asignacionesMes,
        asignacionesBacklogMes: statsKpis.asignacionesBacklogMes,
        tasaIntakeAsignacionPct: statsKpis.tasaIntakeAsignacionPct
      },
      closingPortfolioKpis: {
        clientesTotales: statsKpis.clientesTotales,
        asignados: statsKpis.asignados,
        pendientes: statsKpis.pendientes,
        cargadoHoyArs: statsKpis.cargadoHoyArs,
        cargadoMesArs: statsKpis.cargadoMesArs,
        clientesConReporte: statsKpis.clientesConReporte,
        promedioCargaGeneralArs: statsKpis.promedioCargaGeneralArs,
        tasaActivacionPct: statsKpis.tasaActivacionPct
      },
      charts: {
        monthlyTrend
      },
      clientes
    };
  }

  async getMarketingAnalytics(input: GetMastercrmAnalyticsInput): Promise<MastercrmAnalyticsRecord> {
    if (!Number.isInteger(input.userId) || input.userId < 1) {
      throw new MastercrmUserStoreError('VALIDATION', 'id must be a positive integer');
    }

    const window = buildDateRangeWindow(input.dateFrom, input.dateTo);
    const requestedChannel = input.channel ?? 'all';
    if (
      requestedChannel !== 'all' &&
      requestedChannel !== 'landing' &&
      requestedChannel !== 'meta_ctwa' &&
      requestedChannel !== 'organic'
    ) {
      throw new MastercrmUserStoreError('VALIDATION', 'channel must be landing, meta_ctwa, organic or all');
    }
    const requestedTransport = input.transport ?? 'all';
    if (!['all', 'whatsapp_qr', 'n8n_webhook', 'landing', 'unknown'].includes(requestedTransport)) {
      throw new MastercrmUserStoreError(
        'VALIDATION',
        'transport must be whatsapp_qr, n8n_webhook, landing, unknown or all'
      );
    }

    const campaignFilter = nullableText(input.campaignKey);
    const adFilter = nullableText(input.adKey);

    const user = await this.getActiveUserById(input.userId);
    if (!input.ownerId) {
      const linkedOwners = await this.getLinkedOwnersForUser(input.userId);
      const platform = input.platform ?? 'all';
      const selectedOwners = platform === 'all'
        ? linkedOwners
        : linkedOwners.filter((candidate) => candidate.pagina === platform);
      const records = await Promise.all(
        selectedOwners.map((candidate) =>
          this.getMarketingAnalytics({ ...input, ownerId: candidate.ownerId, platform })
        )
      );
      return mergeAnalyticsRecords(records, linkedOwners, user.routingKey, platform, window, {
        channel: requestedChannel,
        transport: requestedTransport,
        campaignKey: campaignFilter,
        adKey: adFilter
      });
    }
    const owner = await this.getLinkedOwnerRow(input.userId, input.ownerId);
    if (!owner) {
      return buildEmptyAnalytics(window, null, {
        channel: requestedChannel,
        transport: requestedTransport,
        campaignKey: campaignFilter,
        adKey: adFilter
      });
    }

    const [
      ownerPhone,
      events,
      facts,
      snapshotRows,
      financialSettingsResult,
      budgetSourceRows,
      organicQrBudgetSourceRows,
      qrMessageRows,
      qrMatchRows
    ] = await Promise.all([
      this.getOwnerPhone(owner.id),
      selectAllSupabasePages<OwnerClientEventRow>(
        () =>
          this.client
            .from('owner_client_events')
            .select('client_id, event_type, payload, occurred_at')
            .eq('owner_id', owner.id)
            .eq('event_type', 'intake')
            .lt('occurred_at', window.endedAtIso)
            .order('occurred_at', { ascending: true })
            .order('client_id', { ascending: true }),
        'Could not read owner client acquisition events'
      ),
      selectAllSupabasePages<OwnerClientMonthlyFactRow>(
        () =>
          this.client
            .from('owner_client_monthly_facts')
            .select(
              'owner_id, client_id, link_id, month_start, status_at_month_end, identity_id_at_month_end, username_at_month_end, had_intake_in_month, is_new_intake_in_month, is_reentry_in_month, had_assignment_in_month, assigned_from_backlog_in_month, clients!inner(id, phone_e164, pagina, created_at)'
            )
            .eq('owner_id', owner.id)
            .gte('month_start', window.firstMonthStartDate)
            .lt('month_start', window.afterLastMonthStartDate)
            .order('month_start', { ascending: true })
            .order('client_id', { ascending: true }),
        'Could not read owner client monthly facts'
      ),
      selectAllSupabasePages<ReportDailySnapshotRow>(
        () =>
          this.client
            .from('report_daily_snapshots')
            .select('identity_id, client_id, link_id, report_date, username, cargado_hoy, cargado_mes')
            .eq('owner_id', owner.id)
            .gte('report_date', window.firstMonthStartDate)
            .lt('report_date', window.dayAfterDateTo)
            .order('report_date', { ascending: true })
            .order('client_id', { ascending: true })
            .order('identity_id', { ascending: true }),
        'Could not read owner report snapshots'
      ),
      this.client
        .from('mastercrm_portfolio_financial_settings')
        .select('commission_pct')
        .eq('mastercrm_user_id', input.userId)
        .maybeSingle(),
      selectAllSupabasePages<OwnerMarketingDailyBudgetRow>(
        () =>
          this.client
            .from('mastercrm_portfolio_marketing_daily_budgets')
            .select(
              'id, channel, level, campaign_key, campaign_name, ad_key, ad_name, link_url, daily_budget_ars, active_from, active_to, updated_at'
            )
            .eq('mastercrm_user_id', input.userId)
            .order('channel', { ascending: true })
            .order('campaign_key', { ascending: true })
            .order('ad_key', { ascending: true })
            .order('active_from', { ascending: true })
            .order('id', { ascending: true }),
        'Could not read owner marketing budgets'
      ),
      selectAllSupabasePages<OwnerOrganicQrDailyBudgetRow>(
        () =>
          this.client
            .from('mastercrm_portfolio_organic_qr_daily_budgets')
            .select('id, daily_budget_ars, active_from, active_to, updated_at')
            .eq('mastercrm_user_id', input.userId)
            .order('active_from', { ascending: true })
            .order('id', { ascending: true }),
        'Could not read owner organic QR budgets'
      ),
      selectAllSupabasePages<{ client_phone_e164: string; event_at: string }>(
        () =>
          this.client
            .from('mastercrm_whatsapp_qr_messages')
            .select('client_phone_e164, event_at')
            .eq('owner_id', owner.id)
            .eq('route_status', 'resolved')
            .gte('event_at', window.startedAtIso)
            .lt('event_at', window.endedAtIso)
            .order('event_at', { ascending: true }),
        'Could not read QR chats for analytics'
      ),
      selectAllSupabasePages<{ client_phone_e164: string; status: string; event_at: string }>(
        () =>
          this.client
            .from('mastercrm_whatsapp_qr_matches')
            .select('client_phone_e164, status, event_at, mastercrm_whatsapp_qr_messages!inner(route_status)')
            .eq('owner_id', owner.id)
            .eq('mastercrm_whatsapp_qr_messages.route_status', 'resolved')
            .gte('event_at', window.startedAtIso)
            .lt('event_at', window.endedAtIso)
            .order('event_at', { ascending: true }),
        'Could not read QR matches for analytics'
      )
    ]);

    if (financialSettingsResult.error) {
      throw mapPostgrestError(financialSettingsResult.error, 'Could not read owner financial settings');
    }

    const linkedOwner: MastercrmLinkedOwnerRecord = {
      ownerId: owner.id,
      ownerKey: owner.owner_key,
      ownerLabel: owner.owner_label,
      pagina: owner.pagina,
      telefono: ownerPhone
    };
    const commissionPct = toFiniteNumber((financialSettingsResult.data as OwnerFinancialSettingsRow | null)?.commission_pct);
    const sortedEvents = events
      .filter((event) => event.client_id)
      .sort((left, right) => compareIsoDatesDesc(right.occurred_at, left.occurred_at));
    const eventsByClientId = new Map<string, OwnerClientEventRow[]>();
    for (const event of sortedEvents) {
      if (!event.client_id) {
        continue;
      }
      const list = eventsByClientId.get(event.client_id) ?? [];
      list.push(event);
      eventsByClientId.set(event.client_id, list);
    }

    const factByClientId = new Map<string, OwnerClientMonthlyFactRow>();
    for (const fact of facts) {
      const existing = factByClientId.get(fact.client_id);
      if (!existing || fact.month_start > existing.month_start) {
        factByClientId.set(fact.client_id, fact);
      }
    }

    const monthlySnapshotByClientId = new Map<string, Map<string, number>>();
    const usernameByClientId = new Map<string, string | null>();
    for (const snapshot of snapshotRows) {
      const clientId = typeof snapshot.client_id === 'string' && snapshot.client_id.length > 0 ? snapshot.client_id : null;
      if (!clientId) {
        continue;
      }

      const dateMap = monthlySnapshotByClientId.get(clientId) ?? new Map<string, number>();
      const cargadoMes = toFiniteNumber(snapshot.cargado_mes) ?? 0;
      dateMap.set(snapshot.report_date, roundTo((dateMap.get(snapshot.report_date) ?? 0) + cargadoMes));
      monthlySnapshotByClientId.set(clientId, dateMap);
      usernameByClientId.set(clientId, snapshot.username || null);
    }

    const revenueByClientId = new Map<string, number>();
    const negativeAdjustments: MastercrmAnalyticsAuditRecord['negativeAdjustments'] = [];
    for (const [clientId, dateMap] of monthlySnapshotByClientId.entries()) {
      const sortedDates = [...dateMap.keys()].sort();
      let clientRevenue = 0;

      for (const segment of window.segments) {
        const latestDateInRange = [...sortedDates]
          .filter((date) => date >= segment.fromDate && date <= segment.toDate)
          .pop();
        if (!latestDateInRange) {
          continue;
        }

        const baselineDate = [...sortedDates]
          .filter((date) => date >= segment.monthStartDate && date < segment.fromDate)
          .pop();
        const latestValue = dateMap.get(latestDateInRange) ?? 0;
        const baselineValue = baselineDate ? dateMap.get(baselineDate) ?? 0 : 0;
        const delta = roundTo(latestValue - baselineValue);

        if (delta < 0) {
          negativeAdjustments.push({
            clientId,
            username: usernameByClientId.get(clientId) ?? null,
            amountArs: delta,
            fromDate: segment.fromDate,
            toDate: latestDateInRange
          });
          continue;
        }

        clientRevenue += delta;
      }

      revenueByClientId.set(clientId, roundTo(clientRevenue));
    }

    const budgetRows = budgetSourceRows
      .filter((row) => {
        if (row.level !== 'ad') {
          return false;
        }
        if (row.active_from > window.dateTo) {
          return false;
        }
        if (row.active_to && row.active_to < window.dateFrom) {
          return false;
        }
        if (requestedChannel !== 'all' && row.channel !== requestedChannel) {
          return false;
        }
        if (campaignFilter && row.campaign_key !== campaignFilter) {
          return false;
        }
        if (adFilter && row.ad_key !== adFilter) {
          return false;
        }
        return true;
      })
      .map((row) => normalizeBudgetRow(row, window.dateFrom, window.dateTo));

    const includeOrganic =
      (requestedChannel === 'all' || requestedChannel === 'organic') &&
      (requestedTransport === 'all' || requestedTransport === 'whatsapp_qr') &&
      !campaignFilter &&
      !adFilter;
    const organicQrBudgetRows = organicQrBudgetSourceRows
      .filter((row) => {
        if (!includeOrganic || row.active_from > window.dateTo) {
          return false;
        }
        return !row.active_to || row.active_to >= window.dateFrom;
      })
      .map((row) => normalizeOrganicQrBudgetRow(row, window.dateFrom, window.dateTo));
    const organicQrInvestmentArs = roundTo(
      organicQrBudgetRows.reduce((total, budget) => total + budget.effectiveSpendArs, 0)
    );

    const adBudgetByKey = new Map<string, number>();
    for (const budget of budgetRows) {
      if (budget.effectiveSpendArs <= 0) {
        continue;
      }

      if (budget.adKey) {
        const adKey = analyticsGroupKey(budget.channel, budget.campaignKey, budget.adKey);
        adBudgetByKey.set(adKey, roundTo((adBudgetByKey.get(adKey) ?? 0) + budget.effectiveSpendArs));
      }
    }

    const campaigns = new Map<string, MutableCampaignAnalytics>();
    const ads = new Map<string, MutableAdAnalytics>();
    const clients: MastercrmAnalyticsClientRecord[] = [];
    const organicSummary = makeMutableMetrics();
    organicSummary.investmentArs = organicQrInvestmentArs;
    const audit: MastercrmAnalyticsAuditRecord = {
      unknownLeads: 0,
      landingUnmatchedLeads: 0,
      organicLeads: 0,
      excludedLeads: 0,
      reentryLeads: 0,
      missingBudgetCampaigns: 0,
      missingBudgetAds: 0,
      negativeAdjustments
    };

    for (const [clientId, clientEvents] of eventsByClientId.entries()) {
      const firstEvent = pickFirstChronologicalEvent(clientEvents);
      if (!firstEvent) {
        continue;
      }

      const firstEventInRange =
        firstEvent.occurred_at >= window.startedAtIso && firstEvent.occurred_at < window.endedAtIso;
      const intakeInRangeCount = clientEvents.filter(
        (event) => event.occurred_at >= window.startedAtIso && event.occurred_at < window.endedAtIso
      ).length;

      if (!firstEventInRange) {
        if (intakeInRangeCount > 0) {
          audit.reentryLeads += intakeInRangeCount;
        }
        continue;
      }

      const firstSourceContext = extractMetaSourceContext(firstEvent.payload);
      const transport: MastercrmIntakeTransport =
        firstSourceContext?.intakeTransport ?? (firstSourceContext?.landingSessionId ? 'landing' : 'unknown');
      if (requestedTransport !== 'all' && transport !== requestedTransport) {
        continue;
      }
      const isOrganicQr = isOrganicQrAcquisition(
        transport,
        clientEvents.map((event) => extractMetaSourceContext(event.payload))
      );
      if (isOrganicQr) {
        audit.organicLeads += 1;

        const fact = factByClientId.get(clientId);
        const client = unwrapSingleRelation(fact?.clients);
        const revenueArs = revenueByClientId.get(clientId) ?? 0;
        const isAssigned = fact?.status_at_month_end === 'assigned';
        const isDepositor = revenueArs > 0;

        if (includeOrganic) {
          organicSummary.leads += 1;
          organicSummary.revenueArs = roundTo(organicSummary.revenueArs + revenueArs);
          organicSummary.assigned += isAssigned ? 1 : 0;
          organicSummary.depositors += isDepositor ? 1 : 0;
          clients.push({
            clientId,
            username: fact?.username_at_month_end ?? usernameByClientId.get(clientId) ?? null,
            telefono: client?.phone_e164 ?? null,
            estado: fact?.status_at_month_end ?? 'pending',
            channel: 'organic',
            transport,
            campaignKey: '',
            campaignName: 'Orgánico QR',
            adKey: '',
            adName: 'Orgánico QR',
            linkUrl: null,
            acquiredAt: firstEvent.occurred_at,
            revenueArs
          });
        } else {
          audit.excludedLeads += 1;
        }
        continue;
      }

      const attributionEvent = pickFirstAttributionEvent(clientEvents) ?? firstEvent;
      const sourceContext = extractMetaSourceContext(attributionEvent.payload);
      const attribution = attributionFromSourceContext(sourceContext);
      const analyticsAttribution = buildAnalyticsAttribution(attribution);
      if (!analyticsAttribution) {
        if (attribution.kind === 'landing_unmatched') {
          audit.landingUnmatchedLeads += 1;
        } else {
          audit.unknownLeads += 1;
        }
        audit.excludedLeads += 1;
        continue;
      }

      if (requestedChannel !== 'all' && analyticsAttribution.channel !== requestedChannel) {
        continue;
      }
      if (campaignFilter && analyticsAttribution.campaignKey !== campaignFilter) {
        continue;
      }
      if (adFilter && analyticsAttribution.adKey !== adFilter) {
        continue;
      }

      const fact = factByClientId.get(clientId);
      const client = unwrapSingleRelation(fact?.clients);
      const revenueArs = revenueByClientId.get(clientId) ?? 0;
      const isAssigned = fact?.status_at_month_end === 'assigned';
      const isDepositor = revenueArs > 0;
      const campaignKey = analyticsGroupKey(analyticsAttribution.channel, analyticsAttribution.campaignKey);
      const adKey = analyticsGroupKey(
        analyticsAttribution.channel,
        analyticsAttribution.campaignKey,
        analyticsAttribution.adKey
      );

      const campaign =
        campaigns.get(campaignKey) ??
        {
          ...makeMutableMetrics(),
          channel: analyticsAttribution.channel,
          campaignKey: analyticsAttribution.campaignKey,
          campaignName: analyticsAttribution.campaignName,
          linkUrl: analyticsAttribution.linkUrl,
          campaignBudgetArs: 0,
          adBudgetArs: 0,
          undistributedBudgetArs: 0
        };
      campaign.leads += 1;
      campaign.revenueArs = roundTo(campaign.revenueArs + revenueArs);
      campaign.assigned += isAssigned ? 1 : 0;
      campaign.depositors += isDepositor ? 1 : 0;
      campaigns.set(campaignKey, campaign);

      const ad =
        ads.get(adKey) ??
        {
          ...makeMutableMetrics(),
          channel: analyticsAttribution.channel,
          campaignKey: analyticsAttribution.campaignKey,
          campaignName: analyticsAttribution.campaignName,
          adKey: analyticsAttribution.adKey,
          adName: analyticsAttribution.adName,
          linkUrl: analyticsAttribution.linkUrl,
          hasOwnBudget: false
        };
      ad.leads += 1;
      ad.revenueArs = roundTo(ad.revenueArs + revenueArs);
      ad.assigned += isAssigned ? 1 : 0;
      ad.depositors += isDepositor ? 1 : 0;
      ads.set(adKey, ad);

      clients.push({
        clientId,
        username: fact?.username_at_month_end ?? usernameByClientId.get(clientId) ?? null,
        telefono: client?.phone_e164 ?? null,
        estado: fact?.status_at_month_end ?? 'pending',
        channel: analyticsAttribution.channel,
        transport,
        campaignKey: analyticsAttribution.campaignKey,
        campaignName: analyticsAttribution.campaignName,
        adKey: analyticsAttribution.adKey,
        adName: analyticsAttribution.adName,
        linkUrl: analyticsAttribution.linkUrl,
        acquiredAt: firstEvent.occurred_at,
        revenueArs
      });
    }

    for (const budget of budgetRows) {
      const campaignKey = analyticsGroupKey(budget.channel, budget.campaignKey);
      if (!campaigns.has(campaignKey)) {
        campaigns.set(campaignKey, {
          ...makeMutableMetrics(),
          channel: budget.channel,
          campaignKey: budget.campaignKey,
          campaignName: budget.campaignName,
          linkUrl: budget.linkUrl,
          campaignBudgetArs: 0,
          adBudgetArs: 0,
          undistributedBudgetArs: 0
        });
      }

      if (budget.level === 'ad' && budget.adKey && !ads.has(analyticsGroupKey(budget.channel, budget.campaignKey, budget.adKey))) {
        ads.set(analyticsGroupKey(budget.channel, budget.campaignKey, budget.adKey), {
          ...makeMutableMetrics(),
          channel: budget.channel,
          campaignKey: budget.campaignKey,
          campaignName: budget.campaignName,
          adKey: budget.adKey,
          adName: budget.adName ?? budget.adKey,
          linkUrl: budget.linkUrl,
          hasOwnBudget: false
        });
      }
    }

    for (const campaign of campaigns.values()) {
      const campaignKey = analyticsGroupKey(campaign.channel, campaign.campaignKey);
      const adBudget = [...adBudgetByKey.entries()]
        .filter(([key]) => key.startsWith(`${campaignKey}\u001f`))
        .reduce((total, [, spend]) => total + spend, 0);
      campaign.campaignBudgetArs = 0;
      campaign.adBudgetArs = roundTo(adBudget);
      campaign.undistributedBudgetArs = 0;
      campaign.investmentArs = roundTo(adBudget);
      if (campaign.leads > 0 && campaign.investmentArs <= 0) {
        audit.missingBudgetCampaigns += 1;
      }
    }

    for (const ad of ads.values()) {
      const budget = adBudgetByKey.get(analyticsGroupKey(ad.channel, ad.campaignKey, ad.adKey)) ?? 0;
      ad.investmentArs = roundTo(budget);
      ad.hasOwnBudget = budget > 0;
      if (ad.leads > 0 && budget <= 0) {
        audit.missingBudgetAds += 1;
      }
    }

    const finalizedCampaigns = [...campaigns.values()]
      .map((campaign) => ({
        ...finalizeAnalyticsMetrics(campaign, commissionPct),
        channel: campaign.channel,
        campaignKey: campaign.campaignKey,
        campaignName: campaign.campaignName,
        linkUrl: campaign.linkUrl,
        campaignBudgetArs: campaign.campaignBudgetArs,
        adBudgetArs: campaign.adBudgetArs,
        undistributedBudgetArs: campaign.undistributedBudgetArs
      }))
      .sort((left, right) => {
        if ((right.roiPct ?? -Infinity) !== (left.roiPct ?? -Infinity)) {
          return (right.roiPct ?? -Infinity) - (left.roiPct ?? -Infinity);
        }
        return right.revenueArs - left.revenueArs;
      });

    const finalizedAds = [...ads.values()]
      .map((ad) => ({
        ...finalizeAnalyticsMetrics(ad, commissionPct),
        channel: ad.channel,
        campaignKey: ad.campaignKey,
        campaignName: ad.campaignName,
        adKey: ad.adKey,
        adName: ad.adName,
        linkUrl: ad.linkUrl,
        hasOwnBudget: ad.hasOwnBudget
      }))
      .sort((left, right) => {
        if ((right.roiPct ?? -Infinity) !== (left.roiPct ?? -Infinity)) {
          return (right.roiPct ?? -Infinity) - (left.roiPct ?? -Infinity);
        }
        return right.revenueArs - left.revenueArs;
      });

    const channelsByKey = new Map<MastercrmAnalyticsChannel, MutableAnalyticsMetrics>();
    for (const campaign of campaigns.values()) {
      const channelMetrics = channelsByKey.get(campaign.channel) ?? makeMutableMetrics();
      channelMetrics.investmentArs = roundTo(channelMetrics.investmentArs + campaign.investmentArs);
      channelMetrics.revenueArs = roundTo(channelMetrics.revenueArs + campaign.revenueArs);
      channelMetrics.leads += campaign.leads;
      channelMetrics.assigned += campaign.assigned;
      channelMetrics.depositors += campaign.depositors;
      channelsByKey.set(campaign.channel, channelMetrics);
    }
    if (includeOrganic && (requestedChannel === 'organic' || organicSummary.leads > 0 || organicQrBudgetRows.length > 0)) {
      channelsByKey.set('organic', organicSummary);
    }

    const finalizedChannels = [...channelsByKey.entries()]
      .map(([channel, metrics]) => ({
        ...finalizeAnalyticsMetrics(metrics, commissionPct),
        channel,
        label: analyticsChannelLabel(channel),
        investmentSource: channel === 'organic' ? ('manual_budget' as const) : null
      }))
      .sort((left, right) => right.revenueArs - left.revenueArs);

    const transportsByKey = new Map<MastercrmIntakeTransport, MutableAnalyticsMetrics>();
    for (const client of clients) {
      const metrics = transportsByKey.get(client.transport) ?? makeMutableMetrics();
      metrics.leads += 1;
      metrics.assigned += client.estado === 'assigned' ? 1 : 0;
      metrics.depositors += client.revenueArs > 0 ? 1 : 0;
      metrics.revenueArs = roundTo(metrics.revenueArs + client.revenueArs);
      transportsByKey.set(client.transport, metrics);
    }
    if (includeOrganic && organicQrInvestmentArs > 0) {
      const qrMetrics = transportsByKey.get('whatsapp_qr') ?? makeMutableMetrics();
      qrMetrics.investmentArs = roundTo(qrMetrics.investmentArs + organicQrInvestmentArs);
      transportsByKey.set('whatsapp_qr', qrMetrics);
    }
    const transportLabels: Record<MastercrmIntakeTransport, string> = {
      whatsapp_qr: 'WhatsApp QR',
      n8n_webhook: 'Webhook WhatsApp',
      landing: 'Landing',
      unknown: 'Sin identificar'
    };
    const phoneKey = (value: string | null | undefined): string => (value ?? '').replace(/[^0-9]/g, '');
    const qrChatPhones = new Set(qrMessageRows.map((row) => phoneKey(row.client_phone_e164)).filter(Boolean));
    const qrDetectedPhones = new Set(qrMatchRows.map((row) => phoneKey(row.client_phone_e164)).filter(Boolean));
    const finalizedTransports = [...transportsByKey.entries()]
      .map(([transport, metrics]) => {
        const transportClients = clients.filter((client) => client.transport === transport);
        const withReport = transportClients.filter((client) => monthlySnapshotByClientId.has(client.clientId)).length;
        const detectedUsers = transportClients.filter((client) =>
          transport === 'whatsapp_qr'
            ? qrDetectedPhones.has(phoneKey(client.telefono))
            : Boolean(client.username)
        ).length;
        const uniqueChats =
          transport === 'whatsapp_qr'
            ? transportClients.filter((client) => qrChatPhones.has(phoneKey(client.telefono))).length
            : transportClients.length;
        return {
          ...finalizeAnalyticsMetrics(metrics, commissionPct),
          transport,
          label: transportLabels[transport],
          uniqueChats,
          newClients: transportClients.length,
          detectedUsers,
          withReport,
          reportCoveragePct:
            transportClients.length > 0 ? roundTo((withReport / transportClients.length) * 100) : null
        };
      })
      .sort((left, right) => right.leads - left.leads);

    const summaryMutable = makeMutableMetrics();
    for (const channel of channelsByKey.values()) {
      summaryMutable.investmentArs = roundTo(summaryMutable.investmentArs + channel.investmentArs);
      summaryMutable.revenueArs = roundTo(summaryMutable.revenueArs + channel.revenueArs);
      summaryMutable.leads += channel.leads;
      summaryMutable.assigned += channel.assigned;
      summaryMutable.depositors += channel.depositors;
    }
    const summary = finalizeAnalyticsMetrics(summaryMutable, commissionPct);
    const funnelWithReport = clients.filter((client) => monthlySnapshotByClientId.has(client.clientId)).length;
    const funnelQrClients = clients.filter((client) => client.transport === 'whatsapp_qr');
    const funnel: MastercrmAnalyticsFunnelRecord = {
      uniqueChats:
        funnelQrClients.filter((client) => qrChatPhones.has(phoneKey(client.telefono))).length +
        clients.filter((client) => client.transport !== 'whatsapp_qr').length,
      newClients: clients.length,
      detectedUsers: clients.filter((client) =>
        client.transport === 'whatsapp_qr'
          ? qrDetectedPhones.has(phoneKey(client.telefono))
          : Boolean(client.username)
      ).length,
      assigned: summary.assigned,
      withReport: funnelWithReport,
      depositors: summary.depositors,
      loadArs: summary.revenueArs,
      reportCoveragePct: clients.length > 0 ? roundTo((funnelWithReport / clients.length) * 100) : null
    };

    return {
      linkedOwner,
      filters: {
        dateFrom: window.dateFrom,
        dateTo: window.dateTo,
        channel: requestedChannel,
        transport: requestedTransport,
        campaignKey: campaignFilter,
        adKey: adFilter
      },
      summary,
      funnel,
      channels: finalizedChannels,
      transports: finalizedTransports,
      campaigns: finalizedCampaigns,
      ads: finalizedAds,
      clients: clients.sort((left, right) => right.revenueArs - left.revenueArs),
      budgets: budgetRows.sort((left, right) => {
        if (left.channel !== right.channel) return left.channel.localeCompare(right.channel);
        if (left.campaignName !== right.campaignName) return left.campaignName.localeCompare(right.campaignName);
        return (left.adName ?? '').localeCompare(right.adName ?? '');
      }),
      organicQrBudgets: organicQrBudgetRows.sort((left, right) => {
        if (left.activeFrom !== right.activeFrom) return left.activeFrom.localeCompare(right.activeFrom);
        return left.id.localeCompare(right.id);
      }),
      audit
    };
  }

  async upsertOwnerFinancials(input: UpsertMastercrmOwnerFinancialsInput): Promise<MastercrmOwnerFinancialInputsRecord> {
    if (!Number.isInteger(input.userId) || input.userId < 1) {
      throw new MastercrmUserStoreError('VALIDATION', 'user_id must be a positive integer');
    }

    const monthWindow = buildMonthWindow(input.month);
    const adSpendArs = Number(input.adSpendArs);
    const commissionPct = Number(input.commissionPct);

    if (!Number.isFinite(adSpendArs) || adSpendArs < 0) {
      throw new MastercrmUserStoreError('VALIDATION', 'ad_spend_ars must be a positive number or zero');
    }
    if (!Number.isFinite(commissionPct) || commissionPct < 0 || commissionPct > 100) {
      throw new MastercrmUserStoreError('VALIDATION', 'commission_pct must be between 0 and 100');
    }

    await this.getActiveUserById(input.userId);

    const [financialSettingsResult, adSpendResult] = await Promise.all([
      this.client.from('mastercrm_portfolio_financial_settings').upsert(
        {
          mastercrm_user_id: input.userId,
          commission_pct: roundTo(commissionPct),
          updated_by_mastercrm_user_id: input.userId
        },
        { onConflict: 'mastercrm_user_id' }
      ),
      this.client.from('mastercrm_portfolio_monthly_ad_spend').upsert(
        {
          mastercrm_user_id: input.userId,
          month_start: monthWindow.monthStartDate,
          ad_spend_ars: roundTo(adSpendArs),
          updated_by_mastercrm_user_id: input.userId
        },
        { onConflict: 'mastercrm_user_id,month_start' }
      )
    ]);

    if (financialSettingsResult.error) {
      throw mapPostgrestError(financialSettingsResult.error, 'Could not persist owner financial settings');
    }
    if (adSpendResult.error) {
      throw mapPostgrestError(adSpendResult.error, 'Could not persist owner monthly ad spend');
    }

    return {
      month: monthWindow.month,
      adSpendArs: roundTo(adSpendArs),
      commissionPct: roundTo(commissionPct)
    };
  }

  async upsertMarketingBudget(input: UpsertMastercrmMarketingBudgetInput): Promise<MastercrmMarketingBudgetRecord> {
    if (!Number.isInteger(input.userId) || input.userId < 1) {
      throw new MastercrmUserStoreError('VALIDATION', 'user_id must be a positive integer');
    }
    if (input.channel !== 'landing' && input.channel !== 'meta_ctwa') {
      throw new MastercrmUserStoreError('VALIDATION', 'channel must be landing or meta_ctwa');
    }
    if (input.level !== 'ad') {
      throw new MastercrmUserStoreError('VALIDATION', 'level must be ad');
    }

    const campaignKey = nullableText(input.campaignKey);
    const campaignName = nullableText(input.campaignName);
    const adKey = input.level === 'ad' ? nullableText(input.adKey ?? undefined) : null;
    const adName = input.level === 'ad' ? nullableText(input.adName ?? undefined) ?? adKey : nullableText(input.adName ?? undefined);
    const activeFrom = normalizeMastercrmDate(input.activeFrom, 'active_from');
    const activeTo = input.activeTo ? normalizeMastercrmDate(input.activeTo, 'active_to') : null;
    const dailyBudgetArs = Number(input.dailyBudgetArs);

    if (!campaignKey || !campaignName) {
      throw new MastercrmUserStoreError('VALIDATION', 'campaign_key and campaign_name are required');
    }
    if (input.level === 'ad' && !adKey) {
      throw new MastercrmUserStoreError('VALIDATION', 'ad_key is required for ad budgets');
    }
    if (activeTo && activeTo < activeFrom) {
      throw new MastercrmUserStoreError('VALIDATION', 'active_to must be after active_from');
    }
    if (!Number.isFinite(dailyBudgetArs) || dailyBudgetArs < 0) {
      throw new MastercrmUserStoreError('VALIDATION', 'daily_budget_ars must be a positive number or zero');
    }

    await this.getActiveUserById(input.userId);

    const payload = {
      mastercrm_user_id: input.userId,
      channel: input.channel,
      level: input.level,
      campaign_key: campaignKey,
      campaign_name: campaignName,
      ad_key: adKey ?? '',
      ad_name: adName,
      link_url: nullableText(input.linkUrl ?? undefined),
      daily_budget_ars: roundTo(dailyBudgetArs),
      active_from: activeFrom,
      active_to: activeTo,
      updated_by_mastercrm_user_id: input.userId
    };

    const query = input.id
      ? this.client
          .from('mastercrm_portfolio_marketing_daily_budgets')
          .update(payload)
          .eq('mastercrm_user_id', input.userId)
          .eq('id', input.id)
          .select(
            'id, channel, level, campaign_key, campaign_name, ad_key, ad_name, link_url, daily_budget_ars, active_from, active_to, updated_at'
          )
          .single()
      : this.client
          .from('mastercrm_portfolio_marketing_daily_budgets')
          .upsert(payload, {
            onConflict: 'mastercrm_user_id,channel,level,campaign_key,ad_key,active_from'
          })
          .select(
            'id, channel, level, campaign_key, campaign_name, ad_key, ad_name, link_url, daily_budget_ars, active_from, active_to, updated_at'
          )
          .single();

    const { data, error } = await query;
    if (error) {
      throw mapPostgrestError(error, 'Could not persist owner marketing budget');
    }

    return normalizeBudgetRow(data as OwnerMarketingDailyBudgetRow, activeFrom, activeTo ?? activeFrom);
  }

  async distributeMarketingBudgets(
    input: DistributeMastercrmMarketingBudgetsInput
  ): Promise<MastercrmMarketingBudgetRecord[]> {
    if (!Number.isInteger(input.userId) || input.userId < 1) {
      throw new MastercrmUserStoreError('VALIDATION', 'user_id must be a positive integer');
    }

    const totalDailyBudgetArs = Number(input.totalDailyBudgetArs);
    if (!Number.isFinite(totalDailyBudgetArs) || totalDailyBudgetArs < 0) {
      throw new MastercrmUserStoreError('VALIDATION', 'total_daily_budget_ars must be a positive number or zero');
    }

    const activeFrom = normalizeMastercrmDate(input.activeFrom, 'active_from');
    const activeTo = input.activeTo ? normalizeMastercrmDate(input.activeTo, 'active_to') : null;
    if (activeTo && activeTo < activeFrom) {
      throw new MastercrmUserStoreError('VALIDATION', 'active_to must be after active_from');
    }

    const ads = normalizeDistributedBudgetAds(input.ads);

    await this.getActiveUserById(input.userId);
    const totalCents = Math.round(totalDailyBudgetArs * 100);
    const baseCents = Math.floor(totalCents / ads.length);
    const remainderCents = totalCents - baseCents * ads.length;
    const payload = ads.map((ad, index) => ({
      mastercrm_user_id: input.userId,
      channel: ad.channel,
      level: 'ad',
      campaign_key: ad.campaignKey,
      campaign_name: ad.campaignName,
      ad_key: ad.adKey,
      ad_name: ad.adName ?? null,
      link_url: ad.linkUrl ?? null,
      daily_budget_ars: (baseCents + (index < remainderCents ? 1 : 0)) / 100,
      active_from: activeFrom,
      active_to: activeTo,
      updated_by_mastercrm_user_id: input.userId
    }));
    const { data, error } = await this.client
      .from('mastercrm_portfolio_marketing_daily_budgets')
      .upsert(payload, { onConflict: 'mastercrm_user_id,channel,level,campaign_key,ad_key,active_from' })
      .select(
        'id, channel, level, campaign_key, campaign_name, ad_key, ad_name, link_url, daily_budget_ars, active_from, active_to, updated_at'
      );

    if (error) {
      throw mapDistributedBudgetRpcError(error);
    }

    const rows = Array.isArray(data) ? data : [];
    return rows.map((row) => normalizeBudgetRow(row as OwnerMarketingDailyBudgetRow, activeFrom, activeTo ?? activeFrom));
  }

  async deleteMarketingBudget(input: DeleteMastercrmMarketingBudgetInput): Promise<{ deleted: true; id: string }> {
    if (!Number.isInteger(input.userId) || input.userId < 1) {
      throw new MastercrmUserStoreError('VALIDATION', 'user_id must be a positive integer');
    }
    if (!nullableText(input.budgetId)) {
      throw new MastercrmUserStoreError('VALIDATION', 'budget_id is required');
    }

    await this.getActiveUserById(input.userId);

    const { error } = await this.client
      .from('mastercrm_portfolio_marketing_daily_budgets')
      .delete()
      .eq('mastercrm_user_id', input.userId)
      .eq('id', input.budgetId);

    if (error) {
      throw mapPostgrestError(error, 'Could not delete owner marketing budget');
    }

    return { deleted: true, id: input.budgetId };
  }

  async upsertOrganicQrBudget(input: UpsertMastercrmOrganicQrBudgetInput): Promise<MastercrmOrganicQrBudgetRecord> {
    if (!Number.isInteger(input.userId) || input.userId < 1) {
      throw new MastercrmUserStoreError('VALIDATION', 'user_id must be a positive integer');
    }

    const activeFrom = normalizeMastercrmDate(input.activeFrom, 'active_from');
    const activeTo = input.activeTo ? normalizeMastercrmDate(input.activeTo, 'active_to') : null;
    const dailyBudgetArs = Number(input.dailyBudgetArs);
    if (activeTo && activeTo < activeFrom) {
      throw new MastercrmUserStoreError('VALIDATION', 'active_to must be after active_from');
    }
    if (!Number.isFinite(dailyBudgetArs) || dailyBudgetArs < 0) {
      throw new MastercrmUserStoreError('VALIDATION', 'daily_budget_ars must be a positive number or zero');
    }

    await this.getActiveUserById(input.userId);
    const payload = {
      mastercrm_user_id: input.userId,
      daily_budget_ars: roundTo(dailyBudgetArs),
      active_from: activeFrom,
      active_to: activeTo,
      updated_by_mastercrm_user_id: input.userId
    };
    const query = nullableText(input.id)
      ? this.client
          .from('mastercrm_portfolio_organic_qr_daily_budgets')
          .update(payload)
          .eq('mastercrm_user_id', input.userId)
          .eq('id', input.id!)
          .select('id, daily_budget_ars, active_from, active_to, updated_at')
          .single()
      : this.client
          .from('mastercrm_portfolio_organic_qr_daily_budgets')
          .insert(payload)
          .select('id, daily_budget_ars, active_from, active_to, updated_at')
          .single();
    const { data, error } = await query;
    if (error) {
      throw mapPostgrestError(error, 'Could not persist owner organic QR budget');
    }

    const row = data as OwnerOrganicQrDailyBudgetRow | null;
    if (!row) {
      throw new MastercrmUserStoreError('INTERNAL', 'Organic QR budget RPC returned no row');
    }
    return normalizeOrganicQrBudgetRow(row, activeFrom, activeTo ?? activeFrom);
  }

  async deleteOrganicQrBudget(input: DeleteMastercrmOrganicQrBudgetInput): Promise<{ deleted: true; id: string }> {
    if (!Number.isInteger(input.userId) || input.userId < 1) {
      throw new MastercrmUserStoreError('VALIDATION', 'user_id must be a positive integer');
    }
    if (!nullableText(input.budgetId)) {
      throw new MastercrmUserStoreError('VALIDATION', 'budget_id is required');
    }

    await this.getActiveUserById(input.userId);

    const { error } = await this.client
      .from('mastercrm_portfolio_organic_qr_daily_budgets')
      .delete()
      .eq('mastercrm_user_id', input.userId)
      .eq('id', input.budgetId);
    if (error) {
      throw mapPostgrestError(error, 'Could not delete owner organic QR budget');
    }

    return { deleted: true, id: input.budgetId };
  }
}

export function createMastercrmUserStore(client: SupabaseClient): MastercrmUserStore {
  return new SupabaseMastercrmUserStore(client);
}

export function toMastercrmHttpError(error: unknown): { statusCode: number; message: string } | null {
  if (!(error instanceof MastercrmUserStoreError)) {
    return null;
  }

  if (error.code === 'VALIDATION') {
    return { statusCode: 400, message: error.message };
  }
  if (error.code === 'NOT_FOUND') {
    return { statusCode: 404, message: error.message };
  }
  if (error.code === 'CONFLICT') {
    return { statusCode: 409, message: error.message };
  }
  if (error.code === 'AUTHENTICATION') {
    return { statusCode: 401, message: error.message };
  }
  if (error.code === 'CONFIGURATION') {
    return { statusCode: 500, message: error.message };
  }

  return { statusCode: 500, message: 'Unexpected mastercrm auth error' };
}

export function createMastercrmUserStoreFromEnv(env: NodeJS.ProcessEnv = process.env): MastercrmUserStore {
  const url = env.SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url || !serviceRoleKey) {
    throw new MastercrmUserStoreError(
      'CONFIGURATION',
      'Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'
    );
  }

  if (serviceRoleKey.startsWith('sb_publishable_')) {
    throw new MastercrmUserStoreError(
      'CONFIGURATION',
      'SUPABASE_SERVICE_ROLE_KEY is invalid: got a publishable key. Use the service_role/secret key.'
    );
  }

  const client = createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  return createMastercrmUserStore(client);
}
