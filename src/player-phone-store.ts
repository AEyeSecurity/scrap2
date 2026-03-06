import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';
import type { PaginaCode } from './types';

type PlayerPhoneStoreErrorCode = 'CONFIGURATION' | 'VALIDATION' | 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL';
type LinkSource = 'create-player' | 'manual-assign';
type EntityTable = 'cajeros' | 'jugadores';

interface EntityIdRow {
  id: string;
}

interface CajeroIdentityRow {
  id: string;
  pagina: PaginaCode;
}

interface LinkRow {
  id: string;
  cajero_id: string;
  jugador_id: string;
}

interface JugadorIdentityRow {
  id: string;
  username: string | null;
}

interface DatabaseErrorLike {
  code?: string | null;
  message: string;
}

export interface SyncCreatePlayerLinkInput {
  pagina: PaginaCode;
  cajeroUsername: string;
  jugadorUsername: string;
  telefono?: string;
}

export interface AssignPhoneInput {
  pagina: PaginaCode;
  cajeroUsername: string;
  jugadorUsername: string;
  telefono: string;
}

export interface AssignUsernameByPhoneResult {
  previousUsername: string | null;
  currentUsername: string;
  overwritten: boolean;
}

export interface PlayerPhoneStore {
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

function asEntityIdRow(data: unknown, table: EntityTable): EntityIdRow {
  if (!data || typeof data !== 'object') {
    throw new PlayerPhoneStoreError('INTERNAL', `${table} upsert did not return row`);
  }

  const row = data as { id?: unknown };
  if (typeof row.id !== 'string' || !row.id) {
    throw new PlayerPhoneStoreError('INTERNAL', `${table} upsert did not return id`);
  }

  return { id: row.id };
}

function asLinkRow(data: unknown): LinkRow {
  if (!data || typeof data !== 'object') {
    throw new PlayerPhoneStoreError('INTERNAL', 'cajeros_jugadores query did not return row');
  }

  const row = data as { id?: unknown; cajero_id?: unknown; jugador_id?: unknown };
  if (typeof row.id !== 'string' || typeof row.cajero_id !== 'string' || typeof row.jugador_id !== 'string') {
    throw new PlayerPhoneStoreError('INTERNAL', 'cajeros_jugadores query returned invalid row');
  }

  return {
    id: row.id,
    cajero_id: row.cajero_id,
    jugador_id: row.jugador_id
  };
}

function asCajeroIdentityRow(data: unknown): CajeroIdentityRow {
  if (!data || typeof data !== 'object') {
    throw new PlayerPhoneStoreError('INTERNAL', 'cajeros query did not return row');
  }

  const row = data as { id?: unknown; pagina?: unknown };
  if (typeof row.id !== 'string' || !row.id) {
    throw new PlayerPhoneStoreError('INTERNAL', 'cajeros query did not return id');
  }
  if (row.pagina !== 'RdA' && row.pagina !== 'ASN') {
    throw new PlayerPhoneStoreError('INTERNAL', 'cajeros query returned invalid pagina');
  }

  return {
    id: row.id,
    pagina: row.pagina
  };
}

function asJugadorIdentityRow(data: unknown): JugadorIdentityRow {
  if (!data || typeof data !== 'object') {
    throw new PlayerPhoneStoreError('INTERNAL', 'jugadores query did not return row');
  }

  const row = data as { id?: unknown; username?: unknown };
  if (typeof row.id !== 'string' || !row.id) {
    throw new PlayerPhoneStoreError('INTERNAL', 'jugadores query did not return id');
  }
  if (row.username !== null && row.username !== undefined && typeof row.username !== 'string') {
    throw new PlayerPhoneStoreError('INTERNAL', 'jugadores query returned invalid username');
  }

  return {
    id: row.id,
    username: (row.username as string | null | undefined) ?? null
  };
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

function mapAssignPendingUsernameRpcError(error: PostgrestError): PlayerPhoneStoreError {
  const code = error.code ?? '';
  const message = error.message || 'could not assign pending username';
  const normalizedMessage = message.toLowerCase();

  if (
    code === 'P0001' &&
    (normalizedMessage.includes('pending link not found') || normalizedMessage.includes('agente not found'))
  ) {
    return new PlayerPhoneStoreError('NOT_FOUND', 'pending jugador link does not exist');
  }

  if (
    code === 'P0001' &&
    (normalizedMessage.includes('username already exists') || normalizedMessage.includes('telefono already assigned'))
  ) {
    return new PlayerPhoneStoreError('CONFLICT', message);
  }

  if (code === 'P0001' && normalizedMessage.includes('immutable')) {
    return new PlayerPhoneStoreError('NOT_FOUND', 'pending jugador link does not exist');
  }

  return mapPostgrestError(error, message);
}

export function mapAssignUsernameByPhoneRpcError(error: PostgrestError): PlayerPhoneStoreError {
  const code = error.code ?? '';
  const message = error.message || 'could not assign username by phone';
  const normalizedMessage = message.toLowerCase();

  if (code === 'P0001' && normalizedMessage.includes('link not found')) {
    return new PlayerPhoneStoreError('NOT_FOUND', 'No existe vínculo para agente+telefono');
  }

  if (code === 'P0001' && normalizedMessage.includes('username already exists')) {
    return new PlayerPhoneStoreError('CONFLICT', 'username already exists in this pagina');
  }

  if (code === 'P0001' && normalizedMessage.includes('telefono already assigned')) {
    return new PlayerPhoneStoreError('CONFLICT', 'telefono already assigned for this cajero');
  }

  return mapPostgrestError(error, message);
}

function asAssignUsernameByPhoneResult(data: unknown): AssignUsernameByPhoneResult {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object') {
    throw new PlayerPhoneStoreError('INTERNAL', 'assign_username_by_phone did not return row');
  }

  const payload = row as {
    previous_username?: unknown;
    current_username?: unknown;
    overwritten?: unknown;
  };

  if (typeof payload.current_username !== 'string' || !payload.current_username) {
    throw new PlayerPhoneStoreError('INTERNAL', 'assign_username_by_phone returned invalid current_username');
  }
  if (typeof payload.overwritten !== 'boolean') {
    throw new PlayerPhoneStoreError('INTERNAL', 'assign_username_by_phone returned invalid overwritten');
  }
  if (payload.previous_username !== null && payload.previous_username !== undefined && typeof payload.previous_username !== 'string') {
    throw new PlayerPhoneStoreError('INTERNAL', 'assign_username_by_phone returned invalid previous_username');
  }

  return {
    previousUsername: (payload.previous_username as string | null | undefined) ?? null,
    currentUsername: payload.current_username,
    overwritten: payload.overwritten
  };
}

class SupabasePlayerPhoneStore implements PlayerPhoneStore {
  constructor(private readonly client: SupabaseClient) {}

  async syncCreatePlayerLink(input: SyncCreatePlayerLinkInput): Promise<void> {
    const pagina = input.pagina;
    const cajeroUsername = normalizeUsername(input.cajeroUsername, 'agente');
    const jugadorUsername = normalizeUsername(input.jugadorUsername, 'usuario');
    const telefono = input.telefono === undefined ? null : normalizePhone(input.telefono);

    if (telefono) {
      try {
        await this.assignPendingUsername({
          pagina,
          cajeroUsername,
          jugadorUsername,
          telefono
        });
        return;
      } catch (error) {
        if (!(error instanceof PlayerPhoneStoreError) || error.code !== 'NOT_FOUND') {
          throw error;
        }
      }
    }

    const cajero = await this.getOrCreateCajeroByUsername(pagina, cajeroUsername);
    const cajeroId = cajero.id;
    if (telefono) {
      const relationByPhone = await this.findRelationByCajeroIdAndPhone(cajeroId, telefono);
      if (relationByPhone) {
        const linkedJugador = await this.findJugadorById(relationByPhone.jugador_id);
        if (linkedJugador?.username === jugadorUsername) {
          const { error } = await this.client
            .from('cajeros_jugadores')
            .update({ source: 'create-player' as LinkSource })
            .eq('id', relationByPhone.id);

          if (error) {
            throw mapPostgrestError(error, 'could not update cajeros_jugadores link');
          }

          return;
        }

        throw new PlayerPhoneStoreError('CONFLICT', 'telefono already assigned for this cajero');
      }
    }

    const jugadorId = await this.upsertEntity('jugadores', pagina, jugadorUsername);
    const existingRelation = await this.findRelationByJugadorId(jugadorId);

    if (existingRelation && existingRelation.cajero_id !== cajeroId) {
      throw new PlayerPhoneStoreError('CONFLICT', 'jugador belongs to another cajero');
    }

    if (existingRelation) {
      const { error } = await this.client
        .from('cajeros_jugadores')
        .update({ telefono, source: 'create-player' as LinkSource })
        .eq('id', existingRelation.id);

      if (error) {
        throw mapPostgrestError(error, 'could not update cajeros_jugadores link');
      }
      return;
    }

    const { error } = await this.client.from('cajeros_jugadores').insert({
      pagina: cajero.pagina,
      cajero_id: cajeroId,
      jugador_id: jugadorId,
      telefono,
      source: 'create-player' as LinkSource
    });

    if (error) {
      throw mapPostgrestError(error, 'could not create cajeros_jugadores link');
    }
  }

  async assignPendingUsername(input: AssignPhoneInput): Promise<void> {
    const pagina = input.pagina;
    const cajeroUsername = normalizeUsername(input.cajeroUsername, 'agente');
    const jugadorUsername = normalizeUsername(input.jugadorUsername, 'usuario');
    const telefono = normalizePhone(input.telefono);

    const { error } = await this.client.rpc('assign_pending_username', {
      p_pagina: pagina,
      p_agente: cajeroUsername,
      p_telefono: telefono,
      p_username: jugadorUsername
    });

    if (error) {
      throw mapAssignPendingUsernameRpcError(error);
    }
  }

  async assignPhone(input: AssignPhoneInput): Promise<void> {
    const pagina = input.pagina;
    const cajeroUsername = normalizeUsername(input.cajeroUsername, 'agente');
    const jugadorUsername = normalizeUsername(input.jugadorUsername, 'usuario');
    const telefono = normalizePhone(input.telefono);

    const jugador = await this.findEntityByPaginaAndUsername('jugadores', pagina, jugadorUsername);
    if (!jugador) {
      throw new PlayerPhoneStoreError('NOT_FOUND', 'jugador does not exist');
    }

    const cajero = await this.findEntityByPaginaAndUsername('cajeros', pagina, cajeroUsername);
    if (!cajero) {
      throw new PlayerPhoneStoreError('CONFLICT', 'jugador belongs to another cajero');
    }

    const relation = await this.findRelationByJugadorId(jugador.id);
    if (!relation) {
      throw new PlayerPhoneStoreError('CONFLICT', 'jugador link does not exist');
    }
    if (relation.cajero_id !== cajero.id) {
      throw new PlayerPhoneStoreError('CONFLICT', 'jugador belongs to another cajero');
    }

    const { error } = await this.client
      .from('cajeros_jugadores')
      .update({ telefono, source: 'manual-assign' as LinkSource })
      .eq('id', relation.id);

    if (error) {
      throw mapPostgrestError(error, 'could not assign phone to jugador');
    }
  }

  async assignUsernameByPhone(input: AssignPhoneInput): Promise<AssignUsernameByPhoneResult> {
    const pagina = input.pagina;
    const cajeroUsername = normalizeUsername(input.cajeroUsername, 'agente');
    const jugadorUsername = normalizeUsername(input.jugadorUsername, 'usuario');
    const telefono = normalizePhone(input.telefono);

    const { data, error } = await this.client.rpc('assign_username_by_phone', {
      p_pagina: pagina,
      p_agente: cajeroUsername,
      p_telefono: telefono,
      p_username: jugadorUsername
    });

    if (error) {
      throw mapAssignUsernameByPhoneRpcError(error);
    }

    return asAssignUsernameByPhoneResult(data);
  }

  private async upsertEntity(table: EntityTable, pagina: PaginaCode, username: string): Promise<string> {
    const { data, error } = await this.client
      .from(table)
      .upsert({ pagina, username }, { onConflict: 'pagina,username' })
      .select('id')
      .single();

    if (error) {
      throw mapPostgrestError(error, `could not upsert ${table}`);
    }

    return asEntityIdRow(data, table).id;
  }

  private async getOrCreateCajeroByUsername(pagina: PaginaCode, username: string): Promise<CajeroIdentityRow> {
    const existing = await this.findCajeroByUsername(username);
    if (existing) {
      if (existing.pagina !== pagina) {
        throw new PlayerPhoneStoreError('CONFLICT', 'cajero already exists in another pagina');
      }
      return existing;
    }

    const { data, error } = await this.client.from('cajeros').insert({ pagina, username }).select('id,pagina').single();

    if (!error) {
      return asCajeroIdentityRow(data);
    }

    // Handle race conditions when another request inserts the same username concurrently.
    if (error.code === '23505') {
      const concurrent = await this.findCajeroByUsername(username);
      if (concurrent) {
        if (concurrent.pagina !== pagina) {
          throw new PlayerPhoneStoreError('CONFLICT', 'cajero already exists in another pagina');
        }
        return concurrent;
      }
    }

    throw mapPostgrestError(error, 'could not upsert cajeros');
  }

  private async findEntityByPaginaAndUsername(
    table: EntityTable,
    pagina: PaginaCode,
    username: string
  ): Promise<EntityIdRow | null> {
    const { data, error } = await this.client
      .from(table)
      .select('id')
      .eq('pagina', pagina)
      .eq('username', username)
      .maybeSingle();

    if (error) {
      throw mapPostgrestError(error, `could not fetch ${table}`);
    }

    if (!data) {
      return null;
    }

    return asEntityIdRow(data, table);
  }

  private async findCajeroByUsername(username: string): Promise<CajeroIdentityRow | null> {
    const { data, error } = await this.client.from('cajeros').select('id,pagina').eq('username', username).maybeSingle();

    if (error) {
      throw mapPostgrestError(error, 'could not fetch cajeros');
    }

    if (!data) {
      return null;
    }

    return asCajeroIdentityRow(data);
  }

  private async findRelationByJugadorId(jugadorId: string): Promise<LinkRow | null> {
    const { data, error } = await this.client
      .from('cajeros_jugadores')
      .select('id,cajero_id,jugador_id')
      .eq('jugador_id', jugadorId)
      .maybeSingle();

    if (error) {
      throw mapPostgrestError(error, 'could not fetch cajeros_jugadores link');
    }

    if (!data) {
      return null;
    }

    return asLinkRow(data);
  }

  private async findRelationByCajeroIdAndPhone(cajeroId: string, telefono: string): Promise<LinkRow | null> {
    const { data, error } = await this.client
      .from('cajeros_jugadores')
      .select('id,cajero_id,jugador_id')
      .eq('cajero_id', cajeroId)
      .eq('telefono', telefono)
      .maybeSingle();

    if (error) {
      throw mapPostgrestError(error, 'could not fetch cajeros_jugadores link by phone');
    }

    if (!data) {
      return null;
    }

    return asLinkRow(data);
  }

  private async findJugadorById(id: string): Promise<JugadorIdentityRow | null> {
    const { data, error } = await this.client.from('jugadores').select('id,username').eq('id', id).maybeSingle();

    if (error) {
      throw mapPostgrestError(error, 'could not fetch jugadores');
    }

    if (!data) {
      return null;
    }

    return asJugadorIdentityRow(data);
  }
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
