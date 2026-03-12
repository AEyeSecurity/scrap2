import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';
import type { PaginaCode } from './types';

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

export interface AssignUsernameByPhoneResult {
  previousUsername: string | null;
  currentUsername: string;
  overwritten: boolean;
  createdClient: boolean;
  createdLink: boolean;
  movedFromPhone: string | null;
  deletedOldPhone: boolean;
}

export interface PlayerPhoneStore {
  intakePendingCliente(input: IntakePendingInput): Promise<IntakePendingResult>;
  syncCreatePlayerLink(input: SyncCreatePlayerLinkInput): Promise<void>;
  assignPendingUsername(input: AssignPhoneInput): Promise<void>;
  assignPhone(input: AssignPhoneInput): Promise<void>;
  assignUsernameByPhone(input: AssignPhoneInput): Promise<AssignUsernameByPhoneResult>;
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
    throw new PlayerPhoneStoreError('INTERNAL', 'intake_pending_cliente_v3 did not return row', {
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
    throw new PlayerPhoneStoreError('INTERNAL', 'intake_pending_cliente_v3 returned invalid cajero_id', {
      reason: 'UNEXPECTED_PERSISTENCE_ERROR'
    });
  }
  if (typeof payload.jugador_id !== 'string' || !payload.jugador_id) {
    throw new PlayerPhoneStoreError('INTERNAL', 'intake_pending_cliente_v3 returned invalid jugador_id', {
      reason: 'UNEXPECTED_PERSISTENCE_ERROR'
    });
  }
  if (typeof payload.link_id !== 'string' || !payload.link_id) {
    throw new PlayerPhoneStoreError('INTERNAL', 'intake_pending_cliente_v3 returned invalid link_id', {
      reason: 'UNEXPECTED_PERSISTENCE_ERROR'
    });
  }
  if (typeof payload.estado !== 'string' || !payload.estado) {
    throw new PlayerPhoneStoreError('INTERNAL', 'intake_pending_cliente_v3 returned invalid estado', {
      reason: 'UNEXPECTED_PERSISTENCE_ERROR'
    });
  }
  if (payload.owner_id !== undefined && payload.owner_id !== null && typeof payload.owner_id !== 'string') {
    throw new PlayerPhoneStoreError('INTERNAL', 'intake_pending_cliente_v3 returned invalid owner_id', {
      reason: 'UNEXPECTED_PERSISTENCE_ERROR'
    });
  }
  if (payload.client_id !== undefined && payload.client_id !== null && typeof payload.client_id !== 'string') {
    throw new PlayerPhoneStoreError('INTERNAL', 'intake_pending_cliente_v3 returned invalid client_id', {
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
    deletedOldPhone: payload.deleted_old_phone
  };
}

class SupabasePlayerPhoneStore implements PlayerPhoneStore {
  constructor(private readonly client: SupabaseClient) {}

  async intakePendingCliente(input: IntakePendingInput): Promise<IntakePendingResult> {
    const pagina = input.pagina;
    const telefono = normalizePhone(input.telefono);
    const ownerContext = requireOwnerContext(input.ownerContext);

    const { data, error } = await this.client.rpc('intake_pending_cliente_v3', {
      p_owner_key: ownerContext.ownerKey,
      p_cliente_telefono: telefono,
      p_pagina: pagina,
      p_owner_label: ownerContext.ownerLabel,
      p_actor_alias: ownerContext.actorAlias,
      p_actor_phone: ownerContext.actorPhone
    });

    if (error) {
      throw mapIntakePendingRpcError(error);
    }

    return asIntakePendingResult(data);
  }

  async syncCreatePlayerLink(input: SyncCreatePlayerLinkInput): Promise<void> {
    if (typeof input.telefono !== 'string') {
      return;
    }

    const pagina = input.pagina;
    const telefono = normalizePhone(input.telefono);
    const jugadorUsername = normalizeUsername(input.jugadorUsername, 'usuario');
    const ownerContext = requireOwnerContext(input.ownerContext);

    const { error } = await this.client.rpc('sync_create_player_link_v3', {
      p_owner_key: ownerContext.ownerKey,
      p_username: jugadorUsername,
      p_cliente_telefono: telefono,
      p_pagina: pagina,
      p_owner_label: ownerContext.ownerLabel,
      p_actor_alias: ownerContext.actorAlias,
      p_actor_phone: ownerContext.actorPhone
    });

    if (error) {
      throw mapSyncCreatePlayerLinkRpcError(error);
    }
  }

  async assignPendingUsername(input: AssignPhoneInput): Promise<void> {
    const pagina = input.pagina;
    const telefono = normalizePhone(input.telefono);
    const jugadorUsername = normalizeUsername(input.jugadorUsername, 'usuario');
    const ownerContext = requireOwnerContext(input.ownerContext);

    const { error } = await this.client.rpc('assign_pending_username_v3', {
      p_owner_key: ownerContext.ownerKey,
      p_cliente_telefono: telefono,
      p_username: jugadorUsername,
      p_pagina: pagina,
      p_owner_label: ownerContext.ownerLabel,
      p_actor_alias: ownerContext.actorAlias,
      p_actor_phone: ownerContext.actorPhone
    });

    if (error) {
      throw mapAssignPendingUsernameRpcError(error);
    }
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

    return asAssignUsernameByPhoneResult(data);
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
