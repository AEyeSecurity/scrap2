import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';

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

export interface MastercrmUserCashierLinkRecord {
  userId: number;
  ownerKey: string;
  ownerLabel: string;
  pagina: 'ASN';
  linked: true;
  replaced: boolean;
  previousOwnerKey: string | null;
}

export interface MastercrmLinkedOwnerRecord {
  ownerId: string;
  ownerKey: string;
  ownerLabel: string;
  pagina: 'ASN';
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
  asignacionesMes: number;
  tasaIntakeAsignacionPct: number | null;
  clientesConReporte: number;
  promedioCargaGeneralArs: number | null;
  tasaActivacionPct: number | null;
}

export interface MastercrmOwnerSummary {
  totalClients: number;
  assignedClients: number;
  pendingClients: number;
  reportDate: string | null;
  cargadoHoyTotal: number | null;
  cargadoMesTotal: number | null;
  hasReport: boolean;
}

export interface MastercrmOwnerClientRecord {
  id: string;
  username: string | null;
  telefono: string | null;
  pagina: 'ASN';
  estado: 'assigned' | 'pending';
  ownerKey: string;
  ownerLabel: string;
  cargadoHoy: number | null;
  cargadoMes: number | null;
  reportDate: string | null;
}

export interface MastercrmClientsDashboardRecord {
  linkedOwner: MastercrmLinkedOwnerRecord | null;
  summary: MastercrmOwnerSummary | null;
  financialInputs: MastercrmOwnerFinancialInputsRecord;
  primaryKpis: MastercrmPrimaryKpisRecord;
  statsKpis: MastercrmStatsKpisRecord;
  clientes: MastercrmOwnerClientRecord[];
}

export interface MastercrmUserStore {
  createUser(input: CreateMastercrmUserInput): Promise<MastercrmUserRecord>;
  authenticate(input: AuthenticateMastercrmUserInput): Promise<MastercrmUserRecord>;
  getActiveUserById(id: number): Promise<MastercrmUserRecord>;
  linkCashierToUser(input: LinkCashierToMastercrmUserInput): Promise<MastercrmUserCashierLinkRecord>;
  getClientsDashboard(input: GetMastercrmClientsDashboardInput): Promise<MastercrmClientsDashboardRecord>;
  upsertOwnerFinancials(input: UpsertMastercrmOwnerFinancialsInput): Promise<MastercrmOwnerFinancialInputsRecord>;
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
  pagina: 'ASN';
}

interface UserOwnerLinkRow {
  id: string;
  owner_id: string;
  owners: OwnerRow | OwnerRow[];
}

interface ClientRow {
  id: string;
  username: string | null;
  phone_e164: string | null;
  pagina: 'ASN';
}

interface OwnerClientLinkRow {
  id: string;
  status: 'assigned' | 'pending';
  client_id: string;
  clients: ClientRow | ClientRow[];
}

interface ReportDailySnapshotRow {
  client_id?: string;
  report_date: string;
  username: string;
  cargado_hoy: number | string | null;
  cargado_mes: number | string | null;
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
  event_type: 'intake' | 'assign_username';
}

const MONTH_TOKEN_RE = /^\d{4}-\d{2}$/;

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

function buildEmptyDashboard(month: string): MastercrmClientsDashboardRecord {
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
    await this.getActiveUserById(input.userId);

    const { data: ownerData, error: ownerError } = await this.client
      .from('owners')
      .select('id, owner_key, owner_label, pagina')
      .eq('pagina', 'ASN')
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
    const owner = await this.getLinkedOwnerRow(input.userId);
    if (!owner) {
      return buildEmptyDashboard(monthWindow.month);
    }

    const [ownerPhone, ownerClientLinksResult, latestReportDateResult, financialSettingsResult, adSpendResult, eventsResult] =
      await Promise.all([
        this.getOwnerPhone(owner.id),
        this.client
          .from('owner_client_links')
          .select('id, status, client_id, clients!inner(id, username, phone_e164, pagina)')
          .eq('owner_id', owner.id),
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
          .maybeSingle(),
        this.client
          .from('owner_client_events')
          .select('event_type')
          .eq('owner_id', owner.id)
          .gte('created_at', monthWindow.startedAtIso)
          .lt('created_at', monthWindow.endedAtIso)
      ]);

    if (ownerClientLinksResult.error) {
      throw mapPostgrestError(ownerClientLinksResult.error, 'Could not read owner client links');
    }
    if (latestReportDateResult.error) {
      throw mapPostgrestError(latestReportDateResult.error, 'Could not read owner report date');
    }
    if (financialSettingsResult.error) {
      throw mapPostgrestError(financialSettingsResult.error, 'Could not read owner financial settings');
    }
    if (adSpendResult.error) {
      throw mapPostgrestError(adSpendResult.error, 'Could not read owner monthly ad spend');
    }
    if (eventsResult.error) {
      throw mapPostgrestError(eventsResult.error, 'Could not read owner events');
    }

    const linkedOwner: MastercrmLinkedOwnerRecord = {
      ownerId: owner.id,
      ownerKey: owner.owner_key,
      ownerLabel: owner.owner_label,
      pagina: owner.pagina,
      telefono: ownerPhone
    };

    const ownerClientLinks = (ownerClientLinksResult.data as OwnerClientLinkRow[] | null) ?? [];
    const totalClients = ownerClientLinks.length;
    const assignedClients = ownerClientLinks.filter((link) => link.status === 'assigned').length;
    const pendingClients = ownerClientLinks.filter((link) => link.status === 'pending').length;
    const conversionAsignadoPct =
      totalClients > 0 ? roundTo((assignedClients / totalClients) * 100) : null;

    const latestReportDateRows = (latestReportDateResult.data as Array<{ report_date: string }> | null) ?? [];
    const reportDate = latestReportDateRows[0]?.report_date ?? null;

    let cargadoHoyTotal: number | null = null;
    let cargadoMesTotal: number | null = null;
    let clientesConReporte = 0;
    const snapshotByUsername = new Map<
      string,
      { cargadoHoy: number | null; cargadoMes: number | null; reportDate: string | null }
    >();

    if (reportDate) {
      const { data: snapshotsData, error: snapshotsError } = await this.client
        .from('report_daily_snapshots')
        .select('client_id, report_date, username, cargado_hoy, cargado_mes')
        .eq('owner_id', owner.id)
        .eq('report_date', reportDate);

      if (snapshotsError) {
        throw mapPostgrestError(snapshotsError, 'Could not read owner report snapshots');
      }

      const snapshots = (snapshotsData as ReportDailySnapshotRow[] | null) ?? [];
      cargadoHoyTotal = 0;
      cargadoMesTotal = 0;
      const reportClientIds = new Set<string>();

      for (const snapshot of snapshots) {
        const cargadoHoy = toFiniteNumber(snapshot.cargado_hoy);
        const cargadoMes = toFiniteNumber(snapshot.cargado_mes);
        snapshotByUsername.set(snapshot.username, {
          cargadoHoy,
          cargadoMes,
          reportDate: snapshot.report_date
        });
        cargadoHoyTotal += cargadoHoy ?? 0;
        cargadoMesTotal += cargadoMes ?? 0;
        if (typeof snapshot.client_id === 'string' && snapshot.client_id.length > 0) {
          reportClientIds.add(snapshot.client_id);
        }
      }

      clientesConReporte = reportClientIds.size;
    }

    const financialSettings = financialSettingsResult.data as OwnerFinancialSettingsRow | null;
    const adSpendRow = adSpendResult.data as OwnerMonthlyAdSpendRow | null;
    const commissionPct = toFiniteNumber(financialSettings?.commission_pct);
    const adSpendArs = toFiniteNumber(adSpendRow?.ad_spend_ars);
    const events = (eventsResult.data as OwnerClientEventRow[] | null) ?? [];
    const intakesMes = events.filter((event) => event.event_type === 'intake').length;
    const asignacionesMes = events.filter((event) => event.event_type === 'assign_username').length;
    const tasaIntakeAsignacionPct = intakesMes > 0 ? roundTo((asignacionesMes / intakesMes) * 100) : null;
    const promedioCargaGeneralArs =
      cargadoMesTotal !== null && totalClients > 0 ? roundTo(cargadoMesTotal / totalClients) : null;
    const tasaActivacionPct =
      assignedClients > 0 ? roundTo((clientesConReporte / assignedClients) * 100) : null;
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

    const clientes: MastercrmOwnerClientRecord[] = ownerClientLinks.map((link) => {
      const client = unwrapSingleRelation(link.clients);
      const username = client?.username ?? null;
      const snapshot = username ? snapshotByUsername.get(username) : undefined;

      return {
        id: link.id,
        username,
        telefono: client?.phone_e164 ?? null,
        pagina: client?.pagina ?? owner.pagina,
        estado: link.status,
        ownerKey: owner.owner_key,
        ownerLabel: owner.owner_label,
        cargadoHoy: snapshot?.cargadoHoy ?? null,
        cargadoMes: snapshot?.cargadoMes ?? null,
        reportDate: snapshot?.reportDate ?? reportDate
      };
    });

    return {
      linkedOwner,
      summary: {
        totalClients,
        assignedClients,
        pendingClients,
        reportDate,
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
      statsKpis: {
        clientesTotales: totalClients,
        asignados: assignedClients,
        pendientes: pendingClients,
        cargadoHoyArs: cargadoHoyTotal,
        cargadoMesArs: cargadoMesTotal,
        intakesMes,
        asignacionesMes,
        tasaIntakeAsignacionPct,
        clientesConReporte,
        promedioCargaGeneralArs,
        tasaActivacionPct
      },
      clientes
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
