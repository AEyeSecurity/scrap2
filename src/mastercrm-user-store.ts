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
  clientes: MastercrmOwnerClientRecord[];
}

export interface MastercrmUserStore {
  createUser(input: CreateMastercrmUserInput): Promise<MastercrmUserRecord>;
  authenticate(input: AuthenticateMastercrmUserInput): Promise<MastercrmUserRecord>;
  getActiveUserById(id: number): Promise<MastercrmUserRecord>;
  linkCashierToUser(input: LinkCashierToMastercrmUserInput): Promise<MastercrmUserCashierLinkRecord>;
  getClientsDashboard(userId: number): Promise<MastercrmClientsDashboardRecord>;
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

class SupabaseMastercrmUserStore implements MastercrmUserStore {
  constructor(private readonly client: SupabaseClient) {}

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

  async getClientsDashboard(userId: number): Promise<MastercrmClientsDashboardRecord> {
    if (!Number.isInteger(userId) || userId < 1) {
      throw new MastercrmUserStoreError('VALIDATION', 'id must be a positive integer');
    }

    await this.getActiveUserById(userId);

    const { data: linkedOwnerData, error: linkedOwnerError } = await this.client
      .from('mastercrm_user_owner_links')
      .select('id, owner_id, owners!inner(id, owner_key, owner_label, pagina)')
      .eq('mastercrm_user_id', userId)
      .maybeSingle();

    if (linkedOwnerError) {
      throw mapPostgrestError(linkedOwnerError, 'Could not read linked cashier owner');
    }

    const linkedOwnerRow = linkedOwnerData as UserOwnerLinkRow | null;
    const owner = unwrapSingleRelation(linkedOwnerRow?.owners);
    if (!linkedOwnerRow || !owner) {
      return {
        linkedOwner: null,
        summary: null,
        clientes: []
      };
    }

    const { data: ownerAliasesData, error: ownerAliasesError } = await this.client
      .from('owner_aliases')
      .select('alias_phone, is_active, updated_at, last_seen_at')
      .eq('owner_id', owner.id);

    if (ownerAliasesError) {
      throw mapPostgrestError(ownerAliasesError, 'Could not read owner alias phones');
    }

    const ownerAliasRows = (ownerAliasesData as OwnerAliasRow[] | null) ?? [];
    const ownerPhone = pickPreferredAliasPhone(ownerAliasRows);

    const linkedOwner: MastercrmLinkedOwnerRecord = {
      ownerId: owner.id,
      ownerKey: owner.owner_key,
      ownerLabel: owner.owner_label,
      pagina: owner.pagina,
      telefono: ownerPhone
    };

    const { data: ownerClientLinksData, error: ownerClientLinksError } = await this.client
      .from('owner_client_links')
      .select('id, status, client_id, clients!inner(id, username, phone_e164, pagina)')
      .eq('owner_id', owner.id);

    if (ownerClientLinksError) {
      throw mapPostgrestError(ownerClientLinksError, 'Could not read owner client links');
    }

    const ownerClientLinks = (ownerClientLinksData as OwnerClientLinkRow[] | null) ?? [];
    const totalClients = ownerClientLinks.length;
    const assignedClients = ownerClientLinks.filter((link) => link.status === 'assigned').length;
    const pendingClients = ownerClientLinks.filter((link) => link.status === 'pending').length;

    const { data: latestReportDateData, error: latestReportDateError } = await this.client
      .from('report_daily_snapshots')
      .select('report_date')
      .eq('owner_id', owner.id)
      .order('report_date', { ascending: false })
      .limit(1);

    if (latestReportDateError) {
      throw mapPostgrestError(latestReportDateError, 'Could not read owner report date');
    }

    const reportDate = Array.isArray(latestReportDateData) ? latestReportDateData[0]?.report_date ?? null : null;
    let cargadoHoyTotal: number | null = null;
    let cargadoMesTotal: number | null = null;
    const snapshotByUsername = new Map<
      string,
      { cargadoHoy: number | null; cargadoMes: number | null; reportDate: string | null }
    >();

    if (reportDate) {
      const { data: snapshotsData, error: snapshotsError } = await this.client
        .from('report_daily_snapshots')
        .select('report_date, username, cargado_hoy, cargado_mes')
        .eq('owner_id', owner.id)
        .eq('report_date', reportDate);

      if (snapshotsError) {
        throw mapPostgrestError(snapshotsError, 'Could not read owner report snapshots');
      }

      const snapshots = (snapshotsData as ReportDailySnapshotRow[] | null) ?? [];
      cargadoHoyTotal = 0;
      cargadoMesTotal = 0;

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
      }
    }

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
      clientes
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
