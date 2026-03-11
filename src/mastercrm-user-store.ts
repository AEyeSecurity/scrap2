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

export interface MastercrmUserStore {
  createUser(input: CreateMastercrmUserInput): Promise<MastercrmUserRecord>;
  authenticate(input: AuthenticateMastercrmUserInput): Promise<MastercrmUserRecord>;
  getActiveUserById(id: number): Promise<MastercrmUserRecord>;
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

  return new SupabaseMastercrmUserStore(client);
}
