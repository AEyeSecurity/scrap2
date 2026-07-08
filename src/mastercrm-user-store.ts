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
}

export interface GetMastercrmClientsDashboardInput {
  userId: number;
  month?: string;
}

export interface UpsertMastercrmOwnerFinancialsInput {
  userId: number;
  month: string;
  adSpendArs: number;
  commissionPct: number;
}

export type MastercrmAnalyticsChannel = 'landing' | 'meta_ctwa';
export type MastercrmAnalyticsClientChannel = MastercrmAnalyticsChannel | 'organic';
export type MastercrmMarketingBudgetLevel = 'ad';

export interface GetMastercrmAnalyticsInput {
  userId: number;
  dateFrom: string;
  dateTo: string;
  channel?: MastercrmAnalyticsChannel | 'all';
  campaignKey?: string;
  adKey?: string;
}

export interface UpsertMastercrmMarketingBudgetInput {
  userId: number;
  id?: string;
  channel: MastercrmAnalyticsChannel;
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
  channel: MastercrmAnalyticsChannel;
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
  channel: MastercrmAnalyticsChannel;
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
}

export interface MastercrmAnalyticsCampaignRecord extends MastercrmAnalyticsMetricsRecord {
  channel: MastercrmAnalyticsChannel;
  campaignKey: string;
  campaignName: string;
  linkUrl: string | null;
  campaignBudgetArs: number;
  adBudgetArs: number;
  undistributedBudgetArs: number;
}

export interface MastercrmAnalyticsAdRecord extends MastercrmAnalyticsMetricsRecord {
  channel: MastercrmAnalyticsChannel;
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
  filters: {
    dateFrom: string;
    dateTo: string;
    channel: MastercrmAnalyticsChannel | 'all';
    campaignKey: string | null;
    adKey: string | null;
  };
  summary: MastercrmAnalyticsMetricsRecord;
  channels: MastercrmAnalyticsChannelRecord[];
  campaigns: MastercrmAnalyticsCampaignRecord[];
  ads: MastercrmAnalyticsAdRecord[];
  clients: MastercrmAnalyticsClientRecord[];
  budgets: MastercrmMarketingBudgetRecord[];
  audit: MastercrmAnalyticsAuditRecord;
}

export interface MastercrmUserStore {
  createUser(input: CreateMastercrmUserInput): Promise<MastercrmUserRecord>;
  authenticate(input: AuthenticateMastercrmUserInput): Promise<MastercrmUserRecord>;
  getActiveUserById(id: number): Promise<MastercrmUserRecord>;
  getLinkedOwnerForUser(userId: number): Promise<MastercrmLinkedOwnerRecord | null>;
  linkCashierToUser(input: LinkCashierToMastercrmUserInput): Promise<MastercrmUserCashierLinkRecord>;
  getClientsDashboard(input: GetMastercrmClientsDashboardInput): Promise<MastercrmClientsDashboardRecord>;
  upsertOwnerFinancials(input: UpsertMastercrmOwnerFinancialsInput): Promise<MastercrmOwnerFinancialInputsRecord>;
  getMarketingAnalytics(input: GetMastercrmAnalyticsInput): Promise<MastercrmAnalyticsRecord>;
  upsertMarketingBudget(input: UpsertMastercrmMarketingBudgetInput): Promise<MastercrmMarketingBudgetRecord>;
  distributeMarketingBudgets(input: DistributeMastercrmMarketingBudgetsInput): Promise<MastercrmMarketingBudgetRecord[]>;
  deleteMarketingBudget(input: DeleteMastercrmMarketingBudgetInput): Promise<{ deleted: true; id: string }>;
}

interface MastercrmUserRow {
  id: number | string;
  username: string;
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
  channel: MastercrmAnalyticsChannel;
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
  if (code === '23505') {
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

interface AnalyticsAttributionShape {
  channel: MastercrmAnalyticsChannel;
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
  channel: MastercrmAnalyticsChannel;
  campaignKey: string;
  campaignName: string;
  linkUrl: string | null;
  campaignBudgetArs: number;
  adBudgetArs: number;
  undistributedBudgetArs: number;
}

interface MutableAdAnalytics extends MutableAnalyticsMetrics {
  channel: MastercrmAnalyticsChannel;
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
  return channel === 'landing' ? 'Landing' : 'Meta WhatsApp';
}

function analyticsGroupKey(...parts: Array<string | null | undefined>): string {
  return parts.map((part) => part ?? '').join('\u001f');
}

function calculateBudgetOverlapSpend(
  budget: Pick<OwnerMarketingDailyBudgetRow, 'daily_budget_ars' | 'active_from' | 'active_to'>,
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
    cplArs: metrics.leads > 0 && investmentArs > 0 ? roundTo(investmentArs / metrics.leads) : null,
    costPerDepositorArs:
      metrics.depositors > 0 && investmentArs > 0 ? roundTo(investmentArs / metrics.depositors) : null,
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

function buildEmptyAnalytics(
  window: ReturnType<typeof buildDateRangeWindow>,
  linkedOwner: MastercrmLinkedOwnerRecord | null = null,
  filters: Pick<MastercrmAnalyticsRecord['filters'], 'channel' | 'campaignKey' | 'adKey'> = {
    channel: 'all',
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
      campaignKey: filters.campaignKey,
      adKey: filters.adKey
    },
    summary: finalizeAnalyticsMetrics(makeMutableMetrics(), null),
    channels: [],
    campaigns: [],
    ads: [],
    clients: [],
    budgets: [],
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

class SupabaseMastercrmUserStore implements MastercrmUserStore {
  constructor(private readonly client: SupabaseClient) {}

  private async getLinkedOwnerRow(userId: number): Promise<OwnerRow | null> {
    const { data, error } = await this.client
      .from('mastercrm_user_owner_links')
      .select('id, owner_id, owners!inner(id, owner_key, owner_label, pagina)')
      .eq('mastercrm_user_id', userId)
      .maybeSingle();

    if (error) {
      throw mapPostgrestError(error, 'Could not read linked cashier owner');
    }

    const linkedOwnerRow = data as UserOwnerLinkRow | null;
    return unwrapSingleRelation(linkedOwnerRow?.owners);
  }

  private async getOwnerPhone(ownerId: string): Promise<string | null> {
    const { data, error } = await this.client
      .from('owner_aliases')
      .select('alias_phone, is_active, updated_at, last_seen_at')
      .eq('owner_id', ownerId);

    if (error) {
      throw mapPostgrestError(error, 'Could not read owner alias phones');
    }

    return pickPreferredAliasPhone((data as OwnerAliasRow[] | null) ?? []);
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

  async createUser(input: CreateMastercrmUserInput): Promise<MastercrmUserRecord> {
    const username = normalizeMastercrmUsername(input.username);
    const nombre = normalizeMastercrmNombre(input.nombre);
    const telefono = normalizeMastercrmTelefono(input.telefono);
    const passwordHash = await hashMastercrmPassword(input.password);

    const { data, error } = await this.client
      .from('mastercrm_users')
      .insert({
        username,
        password_hash: passwordHash,
        nombre,
        telefono
      })
      .select('id, username, nombre, telefono, inversion, is_active, created_at')
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
      .select('id, username, nombre, telefono, inversion, is_active, created_at, password_hash')
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

    const { data, error } = await this.client
      .from('mastercrm_users')
      .select('id, username, nombre, telefono, inversion, is_active, created_at')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      throw mapPostgrestError(error, 'MasterCRM user not found');
    }
    if (!data || !(data as MastercrmUserRow).is_active) {
      throw new MastercrmUserStoreError('NOT_FOUND', 'MasterCRM user not found');
    }

    return toMastercrmUserRecord(data as MastercrmUserRow);
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
      .select('id, owner_id, owners!inner(id, owner_key, owner_label, pagina)')
      .eq('mastercrm_user_id', input.userId)
      .maybeSingle();

    if (existingLinkError) {
      throw mapPostgrestError(existingLinkError, 'Could not read existing MasterCRM user-owner link');
    }

    const existingLink = existingLinkData as UserOwnerLinkRow | null;
    const existingOwner = unwrapSingleRelation(existingLink?.owners);
    const previousOwnerKey = existingOwner?.owner_key ?? null;
    const replaced = Boolean(previousOwnerKey && previousOwnerKey !== owner.owner_key);

    if (!existingLink) {
      const { error: linkError } = await this.client.from('mastercrm_user_owner_links').insert({
        mastercrm_user_id: input.userId,
        owner_id: owner.id
      });

      if (linkError) {
        throw mapPostgrestError(linkError, 'Could not link MasterCRM user to cashier');
      }
    } else if (existingLink.owner_id !== owner.id) {
      const { error: updateError } = await this.client
        .from('mastercrm_user_owner_links')
        .update({
          owner_id: owner.id
        })
        .eq('id', existingLink.id);

      if (updateError) {
        throw mapPostgrestError(updateError, 'Could not replace MasterCRM user cashier link');
      }
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

  async getClientsDashboard(input: GetMastercrmClientsDashboardInput): Promise<MastercrmClientsDashboardRecord> {
    if (!Number.isInteger(input.userId) || input.userId < 1) {
      throw new MastercrmUserStoreError('VALIDATION', 'id must be a positive integer');
    }

    await this.getActiveUserById(input.userId);
    const monthWindow = buildMonthWindow(input.month ?? getBuenosAiresMonthToken());
    const monthTrail = buildMonthTrail(monthWindow.month);
    const owner = await this.getLinkedOwnerRow(input.userId);
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
          .from('owner_financial_settings')
          .select('commission_pct')
          .eq('owner_id', owner.id)
          .maybeSingle(),
        this.client
          .from('owner_monthly_ad_spend')
          .select('ad_spend_ars')
          .eq('owner_id', owner.id)
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

      for (const snapshot of snapshots) {
        const clientId = typeof snapshot.client_id === 'string' && snapshot.client_id.length > 0 ? snapshot.client_id : null;
        if (!clientId || !dashboardClientIds.has(clientId)) {
          continue;
        }

        const cargadoHoy = toFiniteNumber(snapshot.cargado_hoy);
        const cargadoMes = toFiniteNumber(snapshot.cargado_mes);
        const existing = snapshotByClientId.get(clientId);
        snapshotByClientId.set(clientId, {
          cargadoHoy: roundTo((existing?.cargadoHoy ?? 0) + (cargadoHoy ?? 0)),
          cargadoMes: roundTo((existing?.cargadoMes ?? 0) + (cargadoMes ?? 0)),
          reportDate: snapshot.report_date
        });
        cargadoHoyTotal += cargadoHoy ?? 0;
        cargadoMesTotal += cargadoMes ?? 0;
      }

      const { data: reportRunData, error: reportRunError } = await this.client
        .from('report_runs')
        .select('finished_at')
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
        hasReport: Boolean(reportDate)
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
    if (requestedChannel !== 'all' && requestedChannel !== 'landing' && requestedChannel !== 'meta_ctwa') {
      throw new MastercrmUserStoreError('VALIDATION', 'channel must be landing, meta_ctwa or all');
    }

    const campaignFilter = nullableText(input.campaignKey);
    const adFilter = nullableText(input.adKey);

    await this.getActiveUserById(input.userId);
    const owner = await this.getLinkedOwnerRow(input.userId);
    if (!owner) {
      return buildEmptyAnalytics(window, null, {
        channel: requestedChannel,
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
      budgetSourceRows
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
        .from('owner_financial_settings')
        .select('commission_pct')
        .eq('owner_id', owner.id)
        .maybeSingle(),
      selectAllSupabasePages<OwnerMarketingDailyBudgetRow>(
        () =>
          this.client
            .from('owner_marketing_daily_budgets')
            .select(
              'id, channel, level, campaign_key, campaign_name, ad_key, ad_name, link_url, daily_budget_ars, active_from, active_to, updated_at'
            )
            .eq('owner_id', owner.id)
            .order('channel', { ascending: true })
            .order('campaign_key', { ascending: true })
            .order('ad_key', { ascending: true })
            .order('active_from', { ascending: true })
            .order('id', { ascending: true }),
        'Could not read owner marketing budgets'
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
    const includeOrganicInSummary = requestedChannel === 'all' && !campaignFilter && !adFilter;
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

      const attributionEvent = pickFirstAttributionEvent(clientEvents) ?? firstEvent;
      const attribution = attributionFromSourceContext(extractMetaSourceContext(attributionEvent.payload));
      const analyticsAttribution = buildAnalyticsAttribution(attribution);
      if (!analyticsAttribution) {
        if (attribution.kind === 'landing_unmatched') {
          audit.landingUnmatchedLeads += 1;
        } else {
          audit.unknownLeads += 1;
        }
        audit.organicLeads += 1;

        const fact = factByClientId.get(clientId);
        const client = unwrapSingleRelation(fact?.clients);
        const revenueArs = revenueByClientId.get(clientId) ?? 0;
        const isAssigned = fact?.status_at_month_end === 'assigned';
        const isDepositor = revenueArs > 0;

        if (includeOrganicInSummary) {
          organicSummary.leads += 1;
          organicSummary.revenueArs = roundTo(organicSummary.revenueArs + revenueArs);
          organicSummary.assigned += isAssigned ? 1 : 0;
          organicSummary.depositors += isDepositor ? 1 : 0;
        } else {
          audit.excludedLeads += 1;
        }

        if (includeOrganicInSummary) {
          clients.push({
            clientId,
            username: fact?.username_at_month_end ?? usernameByClientId.get(clientId) ?? null,
            telefono: client?.phone_e164 ?? null,
            estado: fact?.status_at_month_end ?? 'pending',
            channel: 'organic',
            campaignKey: '',
            campaignName: 'Sin atribucion',
            adKey: '',
            adName: 'Sin atribucion',
            linkUrl: null,
            acquiredAt: firstEvent.occurred_at,
            revenueArs
          });
        }
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

    const finalizedChannels = [...channelsByKey.entries()]
      .map(([channel, metrics]) => ({
        ...finalizeAnalyticsMetrics(metrics, commissionPct),
        channel,
        label: analyticsChannelLabel(channel)
      }))
      .sort((left, right) => right.revenueArs - left.revenueArs);

    const summaryMutable = makeMutableMetrics();
    for (const channel of channelsByKey.values()) {
      summaryMutable.investmentArs = roundTo(summaryMutable.investmentArs + channel.investmentArs);
      summaryMutable.revenueArs = roundTo(summaryMutable.revenueArs + channel.revenueArs);
      summaryMutable.leads += channel.leads;
      summaryMutable.assigned += channel.assigned;
      summaryMutable.depositors += channel.depositors;
    }
    if (includeOrganicInSummary) {
      summaryMutable.revenueArs = roundTo(summaryMutable.revenueArs + organicSummary.revenueArs);
      summaryMutable.leads += organicSummary.leads;
      summaryMutable.assigned += organicSummary.assigned;
      summaryMutable.depositors += organicSummary.depositors;
    }

    return {
      linkedOwner,
      filters: {
        dateFrom: window.dateFrom,
        dateTo: window.dateTo,
        channel: requestedChannel,
        campaignKey: campaignFilter,
        adKey: adFilter
      },
      summary: finalizeAnalyticsMetrics(summaryMutable, commissionPct),
      channels: finalizedChannels,
      campaigns: finalizedCampaigns,
      ads: finalizedAds,
      clients: clients.sort((left, right) => right.revenueArs - left.revenueArs),
      budgets: budgetRows.sort((left, right) => {
        if (left.channel !== right.channel) return left.channel.localeCompare(right.channel);
        if (left.campaignName !== right.campaignName) return left.campaignName.localeCompare(right.campaignName);
        return (left.adName ?? '').localeCompare(right.adName ?? '');
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
    const owner = await this.getLinkedOwnerRow(input.userId);
    if (!owner) {
      throw new MastercrmUserStoreError('NOT_FOUND', 'Cashier owner link not found for user');
    }

    const [financialSettingsResult, adSpendResult] = await Promise.all([
      this.client.from('owner_financial_settings').upsert(
        {
          owner_id: owner.id,
          commission_pct: roundTo(commissionPct),
          updated_by_mastercrm_user_id: input.userId
        },
        { onConflict: 'owner_id' }
      ),
      this.client.from('owner_monthly_ad_spend').upsert(
        {
          owner_id: owner.id,
          month_start: monthWindow.monthStartDate,
          ad_spend_ars: roundTo(adSpendArs),
          updated_by_mastercrm_user_id: input.userId
        },
        { onConflict: 'owner_id,month_start' }
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
    const owner = await this.getLinkedOwnerRow(input.userId);
    if (!owner) {
      throw new MastercrmUserStoreError('NOT_FOUND', 'Cashier owner link not found for user');
    }

    const payload = {
      owner_id: owner.id,
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
          .from('owner_marketing_daily_budgets')
          .update(payload)
          .eq('owner_id', owner.id)
          .eq('id', input.id)
          .select(
            'id, channel, level, campaign_key, campaign_name, ad_key, ad_name, link_url, daily_budget_ars, active_from, active_to, updated_at'
          )
          .single()
      : this.client
          .from('owner_marketing_daily_budgets')
          .upsert(payload, {
            onConflict: 'owner_id,channel,level,campaign_key,ad_key,active_from'
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
    const owner = await this.getLinkedOwnerRow(input.userId);
    if (!owner) {
      throw new MastercrmUserStoreError('NOT_FOUND', 'Cashier owner link not found for user');
    }

    const { data, error } = await this.client.rpc('distribute_owner_marketing_ad_budgets_v1', {
      p_owner_id: owner.id,
      p_mastercrm_user_id: input.userId,
      p_total_daily_budget_ars: roundTo(totalDailyBudgetArs),
      p_active_from: activeFrom,
      p_active_to: activeTo,
      p_ads: ads.map((ad) => ({
        channel: ad.channel,
        campaign_key: ad.campaignKey,
        campaign_name: ad.campaignName,
        ad_key: ad.adKey,
        ad_name: ad.adName ?? null,
        link_url: ad.linkUrl ?? null
      }))
    });

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
    const owner = await this.getLinkedOwnerRow(input.userId);
    if (!owner) {
      throw new MastercrmUserStoreError('NOT_FOUND', 'Cashier owner link not found for user');
    }

    const { error } = await this.client
      .from('owner_marketing_daily_budgets')
      .delete()
      .eq('owner_id', owner.id)
      .eq('id', input.budgetId);

    if (error) {
      throw mapPostgrestError(error, 'Could not delete owner marketing budget');
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
