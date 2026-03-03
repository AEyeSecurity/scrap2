import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';
import type { PaginaCode } from './types';

type PlayerPhoneStoreErrorCode = 'CONFIGURATION' | 'VALIDATION' | 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL';
type LinkSource = 'create-player' | 'manual-assign';
type EntityTable = 'cajeros' | 'jugadores';

interface EntityIdRow {
  id: string;
}

interface LinkRow {
  id: string;
  cajero_id: string;
  jugador_id: string;
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

export interface PlayerPhoneStore {
  syncCreatePlayerLink(input: SyncCreatePlayerLinkInput): Promise<void>;
  assignPhone(input: AssignPhoneInput): Promise<void>;
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

  if (code === '23514' || code === '22P02') {
    return new PlayerPhoneStoreError('VALIDATION', fallbackMessage);
  }

  return new PlayerPhoneStoreError('INTERNAL', fallbackMessage);
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

function mapPostgrestError(error: PostgrestError, fallbackMessage: string): PlayerPhoneStoreError {
  return mapDatabaseError(
    {
      code: error.code,
      message: error.message
    },
    fallbackMessage
  );
}

class SupabasePlayerPhoneStore implements PlayerPhoneStore {
  constructor(private readonly client: SupabaseClient) {}

  async syncCreatePlayerLink(input: SyncCreatePlayerLinkInput): Promise<void> {
    const pagina = input.pagina;
    const cajeroUsername = normalizeUsername(input.cajeroUsername, 'agente');
    const jugadorUsername = normalizeUsername(input.jugadorUsername, 'usuario');
    const telefono = input.telefono === undefined ? null : normalizePhone(input.telefono);

    const cajeroId = await this.upsertEntity('cajeros', pagina, cajeroUsername);
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
      pagina,
      cajero_id: cajeroId,
      jugador_id: jugadorId,
      telefono,
      source: 'create-player' as LinkSource
    });

    if (error) {
      throw mapPostgrestError(error, 'could not create cajeros_jugadores link');
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

  const client = createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  return new SupabasePlayerPhoneStore(client);
}
