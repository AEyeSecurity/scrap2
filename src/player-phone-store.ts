import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';
import { normalizeMetaSourceContext } from './meta-source-context';
import type { MetaSourceContext, PaginaCode } from './types';

type PlayerPhoneStoreErrorCode = 'CONFIGURATION' | 'VALIDATION' | 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL';

export type PlayerPhoneStoreErrorReason =
  | 'OWNER_CONTEXT_REQUIRED'
  | 'INVALID_PHONE_FORMAT'
  | 'USERNAME_ASSIGNED_TO_OTHER_OWNER'
  | 'USERNAME_ALREADY_EXISTS_IN_PAGINA'
  | 'PHONE_ALREADY_ASSIGNED_FOR_OWNER'
  | 'OWNER_CLIENT_LINK_NOT_FOUND'
  | 'INVALID_OWNER_CONTEXT'
  | 'CONFIGURATION_ERROR'
  | 'UNEXPECTED_PERSISTENCE_ERROR';

interface DatabaseErrorLike {
  code?: string | null;
  message: string;
  details?: string | null;
}

interface HttpErrorResponse {
  statusCode: number;
  message: string;
  code: string;
  details?: Record<string, unknown>;
}

export interface OwnerContextInput {
  ownerKey: string;
  ownerLabel: string;
  actorAlias?: string | null;
  actorPhone?: string | null;
}

interface NormalizedOwnerContext {
  ownerKey: string;
  ownerLabel: string;
  actorAlias: string | null;
  actorPhone: string | null;
}

interface OwnerRow {
  id: string;
  owner_key: string;
  owner_label?: string;
  pagina: PaginaCode;
}

interface OwnerAliasPhoneRow {
  alias_phone: string | null;
  is_active: boolean;
  updated_at: string;
  last_seen_at: string;
}

interface ClientPhoneRow {
  id: string;
  pagina: PaginaCode;
  phone_e164: string;
}

interface OwnerClientLinkRow {
  id: string;
  owner_id: string;
  client_id: string;
  status: 'assigned' | 'pending';
}

interface OwnerClientIdentityRow {
  id: string;
  username: string;
  is_active: boolean;
}

export interface SyncCreatePlayerLinkInput {
  pagina: PaginaCode;
  jugadorUsername: string;
  telefono?: string;
  ownerContext: OwnerContextInput;
}

export interface IntakePendingInput {
  pagina: PaginaCode;
  telefono: string;
  ownerContext: OwnerContextInput;
  sourceContext?: MetaSourceContext | null;
}

export interface IntakePendingResult {
  cajeroId: string;
  jugadorId: string;
  linkId: string;
  estado: string;
  ownerId?: string;
  clientId?: string;
}

export interface AssignPhoneInput {
  pagina: PaginaCode;
  jugadorUsername: string;
  telefono: string;
  ownerContext: OwnerContextInput;
}

export interface UnassignPhoneInput {
  pagina: PaginaCode;
  telefono: string;
  ownerContext: OwnerContextInput;
}

export interface AssignUsernameByPhoneResult {
  previousUsername: string | null;
  currentUsername: string;
  overwritten: boolean;
  createdClient: boolean;
  createdLink: boolean;
  movedFromPhone: string | null;
  deletedOldPhone: boolean;
  ownerId?: string;
  clientId?: string;
}

export interface UnassignUsernameByPhoneResult {
  previousUsername: string | null;
  currentStatus: 'pending';
  unlinked: boolean;
}

export interface ResolvedOwnerContextByPhone {
  ownerKey: string;
  ownerLabel: string;
  actorAlias: string;
  actorPhone: string | null;
}

function getBuenosAiresMonthStartDate(input?: string | Date | null): string {
  const date =
    input instanceof Date
      ? input
      : typeof input === 'string' && input.trim().length > 0
        ? new Date(input)
        : new Date();

  const fallback = new Date();
  const resolved = Number.isNaN(date.getTime()) ? fallback : date;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(resolved);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;

  if (!year || !month) {
    return getBuenosAiresMonthStartDate(fallback);
  }

  return `${year}-${month}-01`;
}

export interface PlayerPhoneStore {
  intakePendingCliente(input: IntakePendingInput): Promise<IntakePendingResult>;
  resolveOwnerContextByPhone(input: { pagina: PaginaCode; telefono: string }): Promise<ResolvedOwnerContextByPhone | null>;
  syncCreatePlayerLink(input: SyncCreatePlayerLinkInput): Promise<void>;
  assignPendingUsername(input: AssignPhoneInput): Promise<void>;
  assignPhone(input: AssignPhoneInput): Promise<void>;
  assignUsernameByPhone(input: AssignPhoneInput): Promise<AssignUsernameByPhoneResult>;
  unassignUsernameByPhone(input: UnassignPhoneInput): Promise<UnassignUsernameByPhoneResult>;
}

interface PlayerPhoneStoreErrorOptions extends ErrorOptions {
  reason?: PlayerPhoneStoreErrorReason;
  details?: Record<string, unknown>;
}

export class PlayerPhoneStoreError extends Error {
  public readonly reason?: PlayerPhoneStoreErrorReason;
  public readonly details?: Record<string, unknown>;

  constructor(
    public readonly code: PlayerPhoneStoreErrorCode,
    message: string,
    options?: PlayerPhoneStoreErrorOptions
  ) {
    super(message, options);
    this.name = 'PlayerPhoneStoreError';
    this.reason = options?.reason;
    this.details = options?.details;
  }
}

function getDefaultReason(code: PlayerPhoneStoreErrorCode): PlayerPhoneStoreErrorReason {
  if (code === 'CONFIGURATION') {
    return 'CONFIGURATION_ERROR';
  }
  if (code === 'VALIDATION') {
    return 'INVALID_OWNER_CONTEXT';
  }
  if (code === 'NOT_FOUND') {
    return 'OWNER_CLIENT_LINK_NOT_FOUND';
  }
  if (code === 'CONFLICT') {
    return 'USERNAME_ALREADY_EXISTS_IN_PAGINA';
  }

  return 'UNEXPECTED_PERSISTENCE_ERROR';
}

export function normalizeUsername(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw new PlayerPhoneStoreError('VALIDATION', `${label} is required`, {
      reason: 'INVALID_OWNER_CONTEXT',
      details: { path: label }
    });
  }

  return normalized;
}

export function normalizePhone(value: string): string {
  const compact = value.replace(/[\s()-]/g, '');
  const withPlus = compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
  if (!/^\+[1-9]\d{7,14}$/.test(withPlus)) {
    throw new PlayerPhoneStoreError('VALIDATION', 'telefono must follow strict E.164 format', {
      reason: 'INVALID_PHONE_FORMAT',
      details: { field: 'telefono', value }
    });
  }

  return withPlus;
}

function compareIsoDatesDesc(left: string, right: string): number {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  const normalizedLeft = Number.isFinite(leftTime) ? leftTime : 0;
  const normalizedRight = Number.isFinite(rightTime) ? rightTime : 0;

  return normalizedRight - normalizedLeft;
}

function pickPreferredAliasPhone(rows: OwnerAliasPhoneRow[]): string | null {
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

function requireOwnerContext(ownerContext: OwnerContextInput | undefined): NormalizedOwnerContext {
  if (!ownerContext) {
    throw new PlayerPhoneStoreError('VALIDATION', 'ownerContext is required', {
      reason: 'OWNER_CONTEXT_REQUIRED',
      details: { path: 'ownerContext' }
    });
  }

  const ownerKey = normalizeUsername(ownerContext.ownerKey, 'ownerContext.ownerKey');
  const ownerLabel = ownerContext.ownerLabel.trim();
  if (!ownerLabel) {
    throw new PlayerPhoneStoreError('VALIDATION', 'ownerContext.ownerLabel is required', {
      reason: 'INVALID_OWNER_CONTEXT',
      details: { path: 'ownerContext.ownerLabel' }
    });
  }

  const actorAlias = ownerContext.actorAlias == null ? null : ownerContext.actorAlias.trim() || null;
  const actorPhone =
    ownerContext.actorPhone == null || ownerContext.actorPhone.trim() === '' ? null : normalizePhone(ownerContext.actorPhone);

  return {
    ownerKey,
    ownerLabel,
    actorAlias,
    actorPhone
  };
}

export function mapDatabaseError(error: DatabaseErrorLike, fallbackMessage: string): PlayerPhoneStoreError {
  const code = error.code ?? '';
  if (code === '23505' || code === '23503') {
    return new PlayerPhoneStoreError('CONFLICT', fallbackMessage, {
      reason: 'USERNAME_ALREADY_EXISTS_IN_PAGINA'
    });
  }

  if (code === '23514' || code === '22P02' || code === '22023') {
    return new PlayerPhoneStoreError('VALIDATION', fallbackMessage, {
      reason: fallbackMessage.toLowerCase().includes('telefono') ? 'INVALID_PHONE_FORMAT' : 'INVALID_OWNER_CONTEXT'
    });
  }

  const detail = code ? `${fallbackMessage} (${code}: ${error.message})` : `${fallbackMessage}: ${error.message}`;
  return new PlayerPhoneStoreError('INTERNAL', detail, {
    reason: 'UNEXPECTED_PERSISTENCE_ERROR',
    details: error.details ? { dbDetails: error.details } : undefined
  });
}

function mapPostgrestError(error: PostgrestError, fallbackMessage: string): PlayerPhoneStoreError {
  return mapDatabaseError(
    {
      code: error.code,
      message: error.message,
      details: error.details
    },
    fallbackMessage
  );
}

function mapIntakePendingRpcError(error: PostgrestError): PlayerPhoneStoreError {
  const code = error.code ?? '';
  const message = error.message || 'could not intake pending cliente';
  const normalizedMessage = message.toLowerCase();

  if (code === 'P0001' && normalizedMessage.includes('telefono already assigned')) {
    return new PlayerPhoneStoreError('CONFLICT', 'telefono already assigned for this owner', {
      reason: 'PHONE_ALREADY_ASSIGNED_FOR_OWNER'
    });
  }
  if (code === 'P0001' && normalizedMessage.includes('owner-client link not found')) {
    return new PlayerPhoneStoreError('NOT_FOUND', 'owner-client link does not exist', {
      reason: 'OWNER_CLIENT_LINK_NOT_FOUND'
    });
  }

  return mapPostgrestError(error, message);
}

function mapAssignPendingUsernameRpcError(error: PostgrestError): PlayerPhoneStoreError {
  const code = error.code ?? '';
  const message = error.message || 'could not assign pending username';
  const normalizedMessage = message.toLowerCase();

  if (code === 'P0001' && normalizedMessage.includes('link not found')) {
    return new PlayerPhoneStoreError('NOT_FOUND', 'pending owner-client link does not exist', {
      reason: 'OWNER_CLIENT_LINK_NOT_FOUND'
    });
  }
  if (code === 'P0001' && normalizedMessage.includes('immutable')) {
    return new PlayerPhoneStoreError('NOT_FOUND', 'pending owner-client link does not exist', {
      reason: 'OWNER_CLIENT_LINK_NOT_FOUND'
    });
  }
  if (code === 'P0001' && normalizedMessage.includes('username already exists')) {
    return new PlayerPhoneStoreError('CONFLICT', message, {
      reason: 'USERNAME_ALREADY_EXISTS_IN_PAGINA'
    });
  }
  if (code === 'P0001' && normalizedMessage.includes('telefono already assigned')) {
    return new PlayerPhoneStoreError('CONFLICT', message, {
      reason: 'PHONE_ALREADY_ASSIGNED_FOR_OWNER'
    });
  }

  return mapPostgrestError(error, message);
}

export function mapAssignUsernameByPhoneRpcError(error: PostgrestError): PlayerPhoneStoreError {
  const code = error.code ?? '';
  const message = error.message || 'could not assign username by phone';
  const normalizedMessage = message.toLowerCase();

  if (code === 'P0001' && normalizedMessage.includes('username assigned to other owner')) {
    return new PlayerPhoneStoreError('CONFLICT', 'El usuario ya esta asignado a otro cajero', {
      reason: 'USERNAME_ASSIGNED_TO_OTHER_OWNER'
    });
  }

  if (code === 'P0001' && normalizedMessage.includes('username already exists')) {
    return new PlayerPhoneStoreError('CONFLICT', 'username already exists in this pagina', {
      reason: 'USERNAME_ALREADY_EXISTS_IN_PAGINA'
    });
  }

  if (code === 'P0001' && normalizedMessage.includes('telefono already assigned')) {
    return new PlayerPhoneStoreError('CONFLICT', 'telefono already assigned for this owner', {
      reason: 'PHONE_ALREADY_ASSIGNED_FOR_OWNER'
    });
  }

  if (code === 'P0001' && normalizedMessage.includes('link not found')) {
    return new PlayerPhoneStoreError('NOT_FOUND', 'owner-client link does not exist', {
      reason: 'OWNER_CLIENT_LINK_NOT_FOUND'
    });
  }

  return mapPostgrestError(error, message);
}

function mapSyncCreatePlayerLinkRpcError(error: PostgrestError): PlayerPhoneStoreError {
  const code = error.code ?? '';
  const message = error.message || 'could not sync create-player link';
  const normalizedMessage = message.toLowerCase();

  if (code === 'P0001' && normalizedMessage.includes('username assigned to other owner')) {
    return new PlayerPhoneStoreError('CONFLICT', 'El usuario ya esta asignado a otro cajero', {
      reason: 'USERNAME_ASSIGNED_TO_OTHER_OWNER'
    });
  }

  if (code === 'P0001' && normalizedMessage.includes('username already exists')) {
    return new PlayerPhoneStoreError('CONFLICT', 'username already exists in this pagina', {
      reason: 'USERNAME_ALREADY_EXISTS_IN_PAGINA'
    });
  }

  if (code === 'P0001' && normalizedMessage.includes('telefono already assigned')) {
    return new PlayerPhoneStoreError('CONFLICT', 'telefono already assigned for this owner', {
      reason: 'PHONE_ALREADY_ASSIGNED_FOR_OWNER'
    });
  }

  return mapPostgrestError(error, message);
}

function asIntakePendingResult(data: unknown): IntakePendingResult {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object') {
    throw new PlayerPhoneStoreError('INTERNAL', 'intake_pending_cliente_v4 did not return row', {
      reason: 'UNEXPECTED_PERSISTENCE_ERROR'
    });
  }

  const payload = row as {
    cajero_id?: unknown;
    jugador_id?: unknown;
    link_id?: unknown;
    estado?: unknown;
    owner_id?: unknown;
    client_id?: unknown;
  };

  if (typeof payload.cajero_id !== 'string' || !payload.cajero_id) {
    throw new PlayerPhoneStoreError('INTERNAL', 'intake_pending_cliente_v4 returned invalid cajero_id', {
      reason: 'UNEXPECTED_PERSISTENCE_ERROR'
    });
  }
  if (typeof payload.jugador_id !== 'string' || !payload.jugador_id) {
    throw new PlayerPhoneStoreError('INTERNAL', 'intake_pending_cliente_v4 returned invalid jugador_id', {
      reason: 'UNEXPECTED_PERSISTENCE_ERROR'
    });
  }
  if (typeof payload.link_id !== 'string' || !payload.link_id) {
    throw new PlayerPhoneStoreError('INTERNAL', 'intake_pending_cliente_v4 returned invalid link_id', {
      reason: 'UNEXPECTED_PERSISTENCE_ERROR'
    });
  }
  if (typeof payload.estado !== 'string' || !payload.estado) {
    throw new PlayerPhoneStoreError('INTERNAL', 'intake_pending_cliente_v4 returned invalid estado', {
      reason: 'UNEXPECTED_PERSISTENCE_ERROR'
    });
  }
  if (payload.owner_id !== undefined && payload.owner_id !== null && typeof payload.owner_id !== 'string') {
    throw new PlayerPhoneStoreError('INTERNAL', 'intake_pending_cliente_v4 returned invalid owner_id', {
      reason: 'UNEXPECTED_PERSISTENCE_ERROR'
    });
  }
  if (payload.client_id !== undefined && payload.client_id !== null && typeof payload.client_id !== 'string') {
    throw new PlayerPhoneStoreError('INTERNAL', 'intake_pending_cliente_v4 returned invalid client_id', {
      reason: 'UNEXPECTED_PERSISTENCE_ERROR'
    });
  }

  return {
    cajeroId: payload.cajero_id,
    jugadorId: payload.jugador_id,
    linkId: payload.link_id,
    estado: payload.estado,
    ...(typeof payload.owner_id === 'string' && payload.owner_id ? { ownerId: payload.owner_id } : {}),
    ...(typeof payload.client_id === 'string' && payload.client_id ? { clientId: payload.client_id } : {})
  };
}

function asAssignUsernameByPhoneResult(data: unknown): AssignUsernameByPhoneResult {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object') {
    throw new PlayerPhoneStoreError('INTERNAL', 'assign_username_by_phone_v4 did not return row', {
      reason: 'UNEXPECTED_PERSISTENCE_ERROR'
    });
  }

  const payload = row as {
    previous_username?: unknown;
    current_username?: unknown;
    overwritten?: unknown;
    created_client?: unknown;
    created_link?: unknown;
    moved_from_phone?: unknown;
    deleted_old_phone?: unknown;
    owner_id?: unknown;
    client_id?: unknown;
  };

  if (typeof payload.current_username !== 'string' || !payload.current_username) {
    throw new PlayerPhoneStoreError('INTERNAL', 'assign_username_by_phone_v4 returned invalid current_username', {
      reason: 'UNEXPECTED_PERSISTENCE_ERROR'
    });
  }
  if (typeof payload.overwritten !== 'boolean') {
    throw new PlayerPhoneStoreError('INTERNAL', 'assign_username_by_phone_v4 returned invalid overwritten', {
      reason: 'UNEXPECTED_PERSISTENCE_ERROR'
    });
  }
  if (typeof payload.created_client !== 'boolean') {
    throw new PlayerPhoneStoreError('INTERNAL', 'assign_username_by_phone_v4 returned invalid created_client', {
      reason: 'UNEXPECTED_PERSISTENCE_ERROR'
    });
  }
  if (typeof payload.created_link !== 'boolean') {
    throw new PlayerPhoneStoreError('INTERNAL', 'assign_username_by_phone_v4 returned invalid created_link', {
      reason: 'UNEXPECTED_PERSISTENCE_ERROR'
    });
  }
  if (typeof payload.deleted_old_phone !== 'boolean') {
    throw new PlayerPhoneStoreError('INTERNAL', 'assign_username_by_phone_v4 returned invalid deleted_old_phone', {
      reason: 'UNEXPECTED_PERSISTENCE_ERROR'
    });
  }
  if (
    payload.previous_username !== null &&
    payload.previous_username !== undefined &&
    typeof payload.previous_username !== 'string'
  ) {
    throw new PlayerPhoneStoreError('INTERNAL', 'assign_username_by_phone_v4 returned invalid previous_username', {
      reason: 'UNEXPECTED_PERSISTENCE_ERROR'
    });
  }
  if (
    payload.moved_from_phone !== null &&
    payload.moved_from_phone !== undefined &&
    typeof payload.moved_from_phone !== 'string'
  ) {
    throw new PlayerPhoneStoreError('INTERNAL', 'assign_username_by_phone_v4 returned invalid moved_from_phone', {
      reason: 'UNEXPECTED_PERSISTENCE_ERROR'
    });
  }

  return {
    previousUsername: (payload.previous_username as string | null | undefined) ?? null,
    currentUsername: payload.current_username,
    overwritten: payload.overwritten,
    createdClient: payload.created_client,
    createdLink: payload.created_link,
    movedFromPhone: (payload.moved_from_phone as string | null | undefined) ?? null,
    deletedOldPhone: payload.deleted_old_phone,
    ...(typeof payload.owner_id === 'string' && payload.owner_id ? { ownerId: payload.owner_id } : {}),
    ...(typeof payload.client_id === 'string' && payload.client_id ? { clientId: payload.client_id } : {})
  };
}

class SupabasePlayerPhoneStore implements PlayerPhoneStore {
  constructor(private readonly client: SupabaseClient) {}

  private async refreshMonthlyFacts(ownerId: string, occurredAt?: string | null): Promise<void> {
    const { error } = await this.client.rpc('refresh_owner_client_monthly_facts_v1', {
      p_owner_id: ownerId,
      p_month_start: getBuenosAiresMonthStartDate(occurredAt)
    });

    if (error) {
      throw mapPostgrestError(error, 'Could not refresh owner monthly facts');
    }
  }

  async intakePendingCliente(input: IntakePendingInput): Promise<IntakePendingResult> {
    const pagina = input.pagina;
    const telefono = normalizePhone(input.telefono);
    const ownerContext = requireOwnerContext(input.ownerContext);
    const sourceContext = normalizeMetaSourceContext(input.sourceContext);

    const { data, error } = await this.client.rpc('intake_pending_cliente_v4', {
      p_owner_key: ownerContext.ownerKey,
      p_cliente_telefono: telefono,
      p_pagina: pagina,
      p_owner_label: ownerContext.ownerLabel,
      p_actor_alias: ownerContext.actorAlias,
      p_actor_phone: ownerContext.actorPhone,
      p_source_context: sourceContext
    });

    if (error) {
      throw mapIntakePendingRpcError(error);
    }

    const result = asIntakePendingResult(data);
    if (result.ownerId) {
      await this.refreshMonthlyFacts(result.ownerId, sourceContext?.receivedAt ?? null);
    }

    return result;
  }

  async resolveOwnerContextByPhone(input: {
    pagina: PaginaCode;
    telefono: string;
  }): Promise<ResolvedOwnerContextByPhone | null> {
    const telefono = normalizePhone(input.telefono);

    const { data: clientData, error: clientError } = await this.client
      .from('clients')
      .select('id, pagina, phone_e164')
      .eq('pagina', input.pagina)
      .eq('phone_e164', telefono)
      .maybeSingle();

    if (clientError) {
      throw mapPostgrestError(clientError, 'Could not resolve client phone');
    }

    const clientRow = clientData as ClientPhoneRow | null;
    if (!clientRow) {
      return null;
    }

    const { data: linkData, error: linkError } = await this.client
      .from('owner_client_links')
      .select('owner_id')
      .eq('client_id', clientRow.id)
      .order('last_seen_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (linkError) {
      throw mapPostgrestError(linkError, 'Could not resolve owner-client link');
    }

    const ownerId = typeof linkData?.owner_id === 'string' ? linkData.owner_id : null;
    if (!ownerId) {
      return null;
    }

    const { data: ownerData, error: ownerError } = await this.client
      .from('owners')
      .select('id, owner_key, owner_label, pagina')
      .eq('id', ownerId)
      .eq('pagina', input.pagina)
      .maybeSingle();

    if (ownerError) {
      throw mapPostgrestError(ownerError, 'Could not resolve owner');
    }

    const owner = ownerData as OwnerRow | null;
    if (!owner || !owner.owner_label) {
      return null;
    }

    const { data: aliasData, error: aliasError } = await this.client
      .from('owner_aliases')
      .select('alias_phone, is_active, updated_at, last_seen_at')
      .eq('owner_id', owner.id);

    if (aliasError) {
      throw mapPostgrestError(aliasError, 'Could not read owner alias phones');
    }

    const actorPhone = pickPreferredAliasPhone((aliasData as OwnerAliasPhoneRow[] | null) ?? []);

    return {
      ownerKey: owner.owner_key,
      ownerLabel: owner.owner_label,
      actorAlias: owner.owner_label,
      actorPhone
    };
  }

  async syncCreatePlayerLink(input: SyncCreatePlayerLinkInput): Promise<void> {
    if (typeof input.telefono !== 'string') {
      return;
    }

    await this.intakePendingCliente({
      pagina: input.pagina,
      telefono: input.telefono,
      ownerContext: input.ownerContext
    });

    await this.assignUsernameByPhone({
      pagina: input.pagina,
      jugadorUsername: input.jugadorUsername,
      telefono: input.telefono,
      ownerContext: input.ownerContext
    });
  }

  async assignPendingUsername(input: AssignPhoneInput): Promise<void> {
    await this.assignUsernameByPhone(input);
  }

  async assignPhone(input: AssignPhoneInput): Promise<void> {
    await this.assignUsernameByPhone(input);
  }

  async assignUsernameByPhone(input: AssignPhoneInput): Promise<AssignUsernameByPhoneResult> {
    const pagina = input.pagina;
    const telefono = normalizePhone(input.telefono);
    const jugadorUsername = normalizeUsername(input.jugadorUsername, 'usuario');
    const ownerContext = requireOwnerContext(input.ownerContext);

    const { data, error } = await this.client.rpc('assign_username_by_phone_v4', {
      p_owner_key: ownerContext.ownerKey,
      p_cliente_telefono: telefono,
      p_username: jugadorUsername,
      p_pagina: pagina,
      p_owner_label: ownerContext.ownerLabel,
      p_actor_alias: ownerContext.actorAlias,
      p_actor_phone: ownerContext.actorPhone
    });

    if (error) {
      throw mapAssignUsernameByPhoneRpcError(error);
    }

    const result = asAssignUsernameByPhoneResult(data);
    if (result.ownerId) {
      await this.refreshMonthlyFacts(result.ownerId);
    }

    return result;
  }

  async unassignUsernameByPhone(input: UnassignPhoneInput): Promise<UnassignUsernameByPhoneResult> {
    const pagina = input.pagina;
    const telefono = normalizePhone(input.telefono);
    const ownerContext = requireOwnerContext(input.ownerContext);

    const { data: ownerData, error: ownerError } = await this.client
      .from('owners')
      .select('id, owner_key, pagina')
      .eq('owner_key', ownerContext.ownerKey)
      .eq('pagina', pagina)
      .maybeSingle();

    if (ownerError) {
      throw mapPostgrestError(ownerError, 'Could not resolve owner');
    }

    const owner = ownerData as OwnerRow | null;
    if (!owner) {
      throw new PlayerPhoneStoreError('VALIDATION', 'ownerContext does not match an existing owner', {
        reason: 'INVALID_OWNER_CONTEXT'
      });
    }

    const { data: clientData, error: clientError } = await this.client
      .from('clients')
      .select('id, pagina, phone_e164')
      .eq('pagina', pagina)
      .eq('phone_e164', telefono)
      .maybeSingle();

    if (clientError) {
      throw mapPostgrestError(clientError, 'Could not resolve client phone');
    }

    const clientRow = clientData as ClientPhoneRow | null;
    if (!clientRow) {
      throw new PlayerPhoneStoreError('NOT_FOUND', 'owner-client link does not exist', {
        reason: 'OWNER_CLIENT_LINK_NOT_FOUND'
      });
    }

    const { data: linkData, error: linkError } = await this.client
      .from('owner_client_links')
      .select('id, owner_id, client_id, status')
      .eq('owner_id', owner.id)
      .eq('client_id', clientRow.id)
      .maybeSingle();

    if (linkError) {
      throw mapPostgrestError(linkError, 'Could not resolve owner-client link');
    }

    const link = linkData as OwnerClientLinkRow | null;
    if (!link) {
      throw new PlayerPhoneStoreError('NOT_FOUND', 'owner-client link does not exist', {
        reason: 'OWNER_CLIENT_LINK_NOT_FOUND'
      });
    }

    const { data: identityData, error: identityError } = await this.client
      .from('owner_client_identities')
      .select('id, username, is_active')
      .eq('owner_client_link_id', link.id)
      .eq('is_active', true)
      .maybeSingle();

    if (identityError) {
      throw mapPostgrestError(identityError, 'Could not resolve owner-client identity');
    }

    const activeIdentity = identityData as OwnerClientIdentityRow | null;
    const nowIso = new Date().toISOString();

    if (!activeIdentity) {
      const { error: refreshError } = await this.client.rpc('refresh_owner_client_link_status_v1', {
        p_link_id: link.id
      });

      if (refreshError) {
        throw mapPostgrestError(refreshError, 'Could not refresh owner-client link status');
      }

      return {
        previousUsername: null,
        currentStatus: 'pending',
        unlinked: false
      };
    }

    const { error: updateIdentityError } = await this.client
      .from('owner_client_identities')
      .update({
        is_active: false,
        valid_to: nowIso,
        updated_at: nowIso
      })
      .eq('id', activeIdentity.id);

    if (updateIdentityError) {
      throw mapPostgrestError(updateIdentityError, 'Could not deactivate owner-client identity');
    }

    const { error: refreshError } = await this.client.rpc('refresh_owner_client_link_status_v1', {
      p_link_id: link.id
    });

    if (refreshError) {
      throw mapPostgrestError(refreshError, 'Could not refresh owner-client link status');
    }

    const { error: eventError } = await this.client.rpc('append_owner_client_event_v4', {
      p_owner_id: owner.id,
      p_client_id: clientRow.id,
      p_alias_id: null,
      p_actor_alias: ownerContext.actorAlias,
      p_actor_phone: ownerContext.actorPhone,
      p_event_type: 'unassign_username',
      p_payload: {
        previous_username: activeIdentity.username,
        action: 'unlink_username'
      }
    });

    if (eventError) {
      throw mapPostgrestError(eventError, 'Could not append owner-client unlink event');
    }

    await this.refreshMonthlyFacts(owner.id);

    return {
      previousUsername: activeIdentity.username,
      currentStatus: 'pending',
      unlinked: true
    };
  }
}

export function toHttpError(error: unknown): HttpErrorResponse | null {
  if (!(error instanceof PlayerPhoneStoreError)) {
    return null;
  }

  const code = error.reason ?? getDefaultReason(error.code);

  if (error.code === 'VALIDATION') {
    return { statusCode: 400, message: error.message, code, ...(error.details ? { details: error.details } : {}) };
  }
  if (error.code === 'NOT_FOUND') {
    return { statusCode: 404, message: error.message, code, ...(error.details ? { details: error.details } : {}) };
  }
  if (error.code === 'CONFLICT') {
    return { statusCode: 409, message: error.message, code, ...(error.details ? { details: error.details } : {}) };
  }
  if (error.code === 'CONFIGURATION') {
    return { statusCode: 500, message: error.message, code, ...(error.details ? { details: error.details } : {}) };
  }

  return {
    statusCode: 500,
    message: error.message,
    code,
    ...(error.details ? { details: error.details } : {})
  };
}

export function createPlayerPhoneStoreFromEnv(env: NodeJS.ProcessEnv = process.env): PlayerPhoneStore {
  const url = env.SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url || !serviceRoleKey) {
    throw new PlayerPhoneStoreError(
      'CONFIGURATION',
      'Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY',
      { reason: 'CONFIGURATION_ERROR' }
    );
  }

  if (serviceRoleKey.startsWith('sb_publishable_')) {
    throw new PlayerPhoneStoreError(
      'CONFIGURATION',
      'SUPABASE_SERVICE_ROLE_KEY is invalid: got a publishable key. Use the service_role/secret key.',
      { reason: 'CONFIGURATION_ERROR' }
    );
  }

  const client = createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  return new SupabasePlayerPhoneStore(client);
}
