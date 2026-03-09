import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';
import type { PaginaCode } from './types';

type PlayerPhoneStoreErrorCode = 'CONFIGURATION' | 'VALIDATION' | 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL';

interface DatabaseErrorLike {
  code?: string | null;
  message: string;
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
  cajeroUsername: string;
  jugadorUsername: string;
  telefono?: string;
  ownerContext?: OwnerContextInput;
}

export interface IntakePendingInput {
  pagina: PaginaCode;
  cajeroUsername: string;
  telefono: string;
  ownerContext?: OwnerContextInput;
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
  cajeroUsername: string;
  jugadorUsername: string;
  telefono: string;
  ownerContext?: OwnerContextInput;
}

export interface AssignUsernameByPhoneResult {
  previousUsername: string | null;
  currentUsername: string;
  overwritten: boolean;
}

export interface PlayerPhoneStore {
  intakePendingCliente(input: IntakePendingInput): Promise<IntakePendingResult>;
  syncCreatePlayerLink(input: SyncCreatePlayerLinkInput): Promise<void>;
  assignPendingUsername(input: AssignPhoneInput): Promise<void>;
  assignPhone(input: AssignPhoneInput): Promise<void>;
  assignUsernameByPhone(input: AssignPhoneInput): Promise<AssignUsernameByPhoneResult>;
}

export class PlayerPhoneStoreError extends Error {
  constructor(
    public readonly code: PlayerPhoneStoreErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'PlayerPhoneStoreError';
  }
}

export function normalizeUsername(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw new PlayerPhoneStoreError('VALIDATION', `${label} is required`);
  }

  return normalized;
}

export function normalizePhone(value: string): string {
  const compact = value.replace(/[\s()-]/g, '');
  const withPlus = compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
  if (!/^\+[1-9]\d{7,14}$/.test(withPlus)) {
    throw new PlayerPhoneStoreError('VALIDATION', 'telefono must follow strict E.164 format');
  }

  return withPlus;
}

function normalizeOwnerContext(value: OwnerContextInput): NormalizedOwnerContext {
  const ownerKey = normalizeUsername(value.ownerKey, 'ownerContext.ownerKey');
  const ownerLabel = value.ownerLabel.trim();
  if (!ownerLabel) {
    throw new PlayerPhoneStoreError('VALIDATION', 'ownerContext.ownerLabel is required');
  }

  const actorAlias = value.actorAlias == null ? null : value.actorAlias.trim() || null;
  const actorPhone =
    value.actorPhone == null || value.actorPhone.trim() === '' ? null : normalizePhone(value.actorPhone);

  return {
    ownerKey,
    ownerLabel,
    actorAlias,
    actorPhone
  };
}

function resolveOwnerContext(ownerContext: OwnerContextInput | undefined, cajeroUsername: string): NormalizedOwnerContext {
  if (ownerContext) {
    return normalizeOwnerContext(ownerContext);
  }

  const ownerKey = normalizeUsername(cajeroUsername, 'agente');
  return {
    ownerKey,
    ownerLabel: ownerKey,
    actorAlias: ownerKey,
    actorPhone: null
  };
}

export function mapDatabaseError(error: DatabaseErrorLike, fallbackMessage: string): PlayerPhoneStoreError {
  const code = error.code ?? '';
  if (code === '23505' || code === '23503') {
    return new PlayerPhoneStoreError('CONFLICT', fallbackMessage);
  }

  if (code === '23514' || code === '22P02' || code === '22023') {
    return new PlayerPhoneStoreError('VALIDATION', fallbackMessage);
  }

  const detail = code ? `${fallbackMessage} (${code}: ${error.message})` : `${fallbackMessage}: ${error.message}`;
  return new PlayerPhoneStoreError('INTERNAL', detail);
}

function mapPostgrestError(error: PostgrestError, fallbackMessage: string): PlayerPhoneStoreError {
  return mapDatabaseError(
    {
      code: error.code,
      message: error.message
    },
    fallbackMessage
  );
}

function mapIntakePendingRpcError(error: PostgrestError): PlayerPhoneStoreError {
  const code = error.code ?? '';
  const message = error.message || 'could not intake pending cliente';
  const normalizedMessage = message.toLowerCase();

  if (code === 'P0001' && normalizedMessage.includes('telefono already assigned')) {
    return new PlayerPhoneStoreError('CONFLICT', 'telefono already assigned for this owner');
  }
  if (code === 'P0001' && normalizedMessage.includes('owner-client link not found')) {
    return new PlayerPhoneStoreError('NOT_FOUND', 'owner-client link does not exist');
  }

  return mapPostgrestError(error, message);
}

function mapAssignPendingUsernameRpcError(error: PostgrestError): PlayerPhoneStoreError {
  const code = error.code ?? '';
  const message = error.message || 'could not assign pending username';
  const normalizedMessage = message.toLowerCase();

  if (code === 'P0001' && normalizedMessage.includes('link not found')) {
    return new PlayerPhoneStoreError('NOT_FOUND', 'pending owner-client link does not exist');
  }
  if (code === 'P0001' && normalizedMessage.includes('immutable')) {
    return new PlayerPhoneStoreError('NOT_FOUND', 'pending owner-client link does not exist');
  }
  if (
    code === 'P0001' &&
    (normalizedMessage.includes('username already exists') || normalizedMessage.includes('telefono already assigned'))
  ) {
    return new PlayerPhoneStoreError('CONFLICT', message);
  }

  return mapPostgrestError(error, message);
}

export function mapAssignUsernameByPhoneRpcError(error: PostgrestError): PlayerPhoneStoreError {
  const code = error.code ?? '';
  const message = error.message || 'could not assign username by phone';
  const normalizedMessage = message.toLowerCase();

  if (code === 'P0001' && normalizedMessage.includes('link not found')) {
    return new PlayerPhoneStoreError('NOT_FOUND', 'No existe vinculo para agente+telefono');
  }

  if (code === 'P0001' && normalizedMessage.includes('username already exists')) {
    return new PlayerPhoneStoreError('CONFLICT', 'username already exists in this pagina');
  }

  if (code === 'P0001' && normalizedMessage.includes('telefono already assigned')) {
    return new PlayerPhoneStoreError('CONFLICT', 'telefono already assigned for this owner');
  }

  return mapPostgrestError(error, message);
}

function mapSyncCreatePlayerLinkRpcError(error: PostgrestError): PlayerPhoneStoreError {
  const code = error.code ?? '';
  const message = error.message || 'could not sync create-player link';
  const normalizedMessage = message.toLowerCase();

  if (code === 'P0001' && normalizedMessage.includes('username already exists')) {
    return new PlayerPhoneStoreError('CONFLICT', 'username already exists in this pagina');
  }

  if (code === 'P0001' && normalizedMessage.includes('telefono already assigned')) {
    return new PlayerPhoneStoreError('CONFLICT', 'telefono already assigned for this owner');
  }

  return mapPostgrestError(error, message);
}

function asIntakePendingResult(data: unknown): IntakePendingResult {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object') {
    throw new PlayerPhoneStoreError('INTERNAL', 'intake_pending_cliente_v3 did not return row');
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
    throw new PlayerPhoneStoreError('INTERNAL', 'intake_pending_cliente_v3 returned invalid cajero_id');
  }
  if (typeof payload.jugador_id !== 'string' || !payload.jugador_id) {
    throw new PlayerPhoneStoreError('INTERNAL', 'intake_pending_cliente_v3 returned invalid jugador_id');
  }
  if (typeof payload.link_id !== 'string' || !payload.link_id) {
    throw new PlayerPhoneStoreError('INTERNAL', 'intake_pending_cliente_v3 returned invalid link_id');
  }
  if (typeof payload.estado !== 'string' || !payload.estado) {
    throw new PlayerPhoneStoreError('INTERNAL', 'intake_pending_cliente_v3 returned invalid estado');
  }
  if (payload.owner_id !== undefined && payload.owner_id !== null && typeof payload.owner_id !== 'string') {
    throw new PlayerPhoneStoreError('INTERNAL', 'intake_pending_cliente_v3 returned invalid owner_id');
  }
  if (payload.client_id !== undefined && payload.client_id !== null && typeof payload.client_id !== 'string') {
    throw new PlayerPhoneStoreError('INTERNAL', 'intake_pending_cliente_v3 returned invalid client_id');
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
    throw new PlayerPhoneStoreError('INTERNAL', 'assign_username_by_phone_v3 did not return row');
  }

  const payload = row as {
    previous_username?: unknown;
    current_username?: unknown;
    overwritten?: unknown;
  };

  if (typeof payload.current_username !== 'string' || !payload.current_username) {
    throw new PlayerPhoneStoreError('INTERNAL', 'assign_username_by_phone_v3 returned invalid current_username');
  }
  if (typeof payload.overwritten !== 'boolean') {
    throw new PlayerPhoneStoreError('INTERNAL', 'assign_username_by_phone_v3 returned invalid overwritten');
  }
  if (
    payload.previous_username !== null &&
    payload.previous_username !== undefined &&
    typeof payload.previous_username !== 'string'
  ) {
    throw new PlayerPhoneStoreError('INTERNAL', 'assign_username_by_phone_v3 returned invalid previous_username');
  }

  return {
    previousUsername: (payload.previous_username as string | null | undefined) ?? null,
    currentUsername: payload.current_username,
    overwritten: payload.overwritten
  };
}

class SupabasePlayerPhoneStore implements PlayerPhoneStore {
  constructor(private readonly client: SupabaseClient) {}

  async intakePendingCliente(input: IntakePendingInput): Promise<IntakePendingResult> {
    const pagina = input.pagina;
    const telefono = normalizePhone(input.telefono);
    const ownerContext = resolveOwnerContext(input.ownerContext, input.cajeroUsername);

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
    const ownerContext = resolveOwnerContext(input.ownerContext, input.cajeroUsername);

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
    const ownerContext = resolveOwnerContext(input.ownerContext, input.cajeroUsername);

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
    const ownerContext = resolveOwnerContext(input.ownerContext, input.cajeroUsername);

    const { data, error } = await this.client.rpc('assign_username_by_phone_v3', {
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

export function toHttpError(error: unknown): { statusCode: number; message: string } | null {
  if (!(error instanceof PlayerPhoneStoreError)) {
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
  if (error.code === 'CONFIGURATION') {
    return { statusCode: 500, message: error.message };
  }

  return { statusCode: 500, message: 'Unexpected persistence error' };
}

export function createPlayerPhoneStoreFromEnv(env: NodeJS.ProcessEnv = process.env): PlayerPhoneStore {
  const url = env.SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url || !serviceRoleKey) {
    throw new PlayerPhoneStoreError(
      'CONFIGURATION',
      'Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'
    );
  }

  if (serviceRoleKey.startsWith('sb_publishable_')) {
    throw new PlayerPhoneStoreError(
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

  return new SupabasePlayerPhoneStore(client);
}
