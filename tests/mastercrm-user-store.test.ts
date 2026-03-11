import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import {
  createMastercrmUserStore,
  hashMastercrmPassword,
  normalizeMastercrmNombre,
  normalizeMastercrmOwnerKey,
  normalizeMastercrmTelefono,
  normalizeMastercrmUsername,
  toMastercrmUserRecord,
  verifyMastercrmPassword
} from '../src/mastercrm-user-store';

type QueryResult = {
  data: unknown;
  error: PostgrestError | null;
};

class FakeQueryBuilder implements PromiseLike<QueryResult> {
  private operation: 'select' | 'insert' = 'select';
  private readonly filters: Array<{ column: string; value: unknown }> = [];

  constructor(
    private readonly client: FakeSupabaseClient,
    private readonly table: string
  ) {}

  insert(payload: unknown): FakeQueryBuilder {
    this.operation = 'insert';
    this.client.calls.push({ table: this.table, operation: 'insert', payload });
    return this;
  }

  select(columns: string): FakeQueryBuilder {
    this.client.calls.push({ table: this.table, operation: 'select-columns', columns });
    return this;
  }

  eq(column: string, value: unknown): FakeQueryBuilder {
    this.filters.push({ column, value });
    this.client.calls.push({ table: this.table, operation: 'filter', column, value });
    return this;
  }

  async maybeSingle(): Promise<QueryResult> {
    return this.client.dequeue(this.table, this.operation, this.filters);
  }

  async single(): Promise<QueryResult> {
    return this.client.dequeue(this.table, this.operation, this.filters);
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.client.dequeue(this.table, this.operation, this.filters).then(onfulfilled, onrejected);
  }
}

class FakeSupabaseClient {
  public readonly calls: Array<Record<string, unknown>> = [];
  private readonly results = new Map<string, QueryResult[]>();

  queue(table: string, operation: 'select' | 'insert', result: QueryResult): void {
    const key = `${table}:${operation}`;
    const pending = this.results.get(key) ?? [];
    pending.push(result);
    this.results.set(key, pending);
  }

  from(table: string): FakeQueryBuilder {
    this.calls.push({ table, operation: 'from' });
    return new FakeQueryBuilder(this, table);
  }

  async dequeue(
    table: string,
    operation: 'select' | 'insert',
    filters: Array<{ column: string; value: unknown }>
  ): Promise<QueryResult> {
    this.calls.push({ table, operation: `resolve-${operation}`, filters });
    const key = `${table}:${operation}`;
    const pending = this.results.get(key) ?? [];
    const result = pending.shift();
    this.results.set(key, pending);
    if (!result) {
      throw new Error(`No queued result for ${key}`);
    }

    return result;
  }
}

function createPostgrestError(code: string, message: string): PostgrestError {
  return {
    code,
    details: '',
    hint: '',
    message
  };
}

describe('mastercrm user store helpers', () => {
  it('normalizes username to lowercase trimmed value', () => {
    expect(normalizeMastercrmUsername('  JuAn  ')).toBe('juan');
  });

  it('normalizes nombre, owner_key and telefono for storage', () => {
    expect(normalizeMastercrmNombre('  Juan Perez  ')).toBe('Juan Perez');
    expect(normalizeMastercrmOwnerKey('  OWNER_1  ')).toBe('owner_1');
    expect(normalizeMastercrmTelefono('  54911  ')).toBe('54911');
    expect(normalizeMastercrmTelefono('   ')).toBeNull();
  });

  it('hashes and verifies passwords', async () => {
    const hash = await hashMastercrmPassword('secret123');

    await expect(verifyMastercrmPassword('secret123', hash)).resolves.toBe(true);
    await expect(verifyMastercrmPassword('wrong', hash)).resolves.toBe(false);
  });

  it('serializes supabase rows to frontend-safe records', () => {
    const user = toMastercrmUserRecord({
      id: '101',
      username: 'juan',
      nombre: 'Juan Perez',
      telefono: '54911',
      inversion: '150000',
      is_active: true,
      created_at: '2026-03-10T12:00:00.000Z'
    });

    expect(user).toEqual({
      id: 101,
      username: 'juan',
      nombre: 'Juan Perez',
      telefono: '54911',
      inversion: 150000,
      isActive: true,
      createdAt: '2026-03-10T12:00:00.000Z'
    });
  });
});

describe('mastercrm user cashier links', () => {
  it('links an active user to an existing ASN owner', async () => {
    const client = new FakeSupabaseClient();
    client.queue('mastercrm_users', 'select', {
      data: {
        id: 123,
        username: 'juan',
        nombre: 'Juan Perez',
        telefono: null,
        inversion: 0,
        is_active: true,
        created_at: '2026-03-10T12:00:00.000Z'
      },
      error: null
    });
    client.queue('owners', 'select', {
      data: {
        id: 'owner-1',
        owner_key: 'owner_key_del_cajero'
      },
      error: null
    });
    client.queue('mastercrm_user_owner_links', 'insert', {
      data: null,
      error: null
    });

    const store = createMastercrmUserStore(client as unknown as SupabaseClient);
    const result = await store.linkCashierToUser({
      userId: 123,
      ownerKey: '  OWNER_KEY_DEL_CAJERO  '
    });

    expect(result).toEqual({
      userId: 123,
      ownerKey: 'owner_key_del_cajero',
      linked: true
    });
    expect(client.calls).toContainEqual({ table: 'owners', operation: 'filter', column: 'pagina', value: 'ASN' });
    expect(client.calls).toContainEqual({
      table: 'mastercrm_user_owner_links',
      operation: 'insert',
      payload: {
        mastercrm_user_id: 123,
        owner_id: 'owner-1'
      }
    });
  });

  it('fails with validation for invalid user_id', async () => {
    const store = createMastercrmUserStore(new FakeSupabaseClient() as unknown as SupabaseClient);

    await expect(store.linkCashierToUser({ userId: 0, ownerKey: 'owner_1' })).rejects.toMatchObject({
      code: 'VALIDATION',
      message: 'user_id must be a positive integer'
    });
  });

  it('fails with validation for empty owner_key', async () => {
    const store = createMastercrmUserStore(new FakeSupabaseClient() as unknown as SupabaseClient);

    await expect(store.linkCashierToUser({ userId: 123, ownerKey: '   ' })).rejects.toMatchObject({
      code: 'VALIDATION',
      message: 'owner_key is required'
    });
  });

  it('fails with not found when the user does not exist', async () => {
    const client = new FakeSupabaseClient();
    client.queue('mastercrm_users', 'select', { data: null, error: null });
    const store = createMastercrmUserStore(client as unknown as SupabaseClient);

    await expect(store.linkCashierToUser({ userId: 999, ownerKey: 'owner_1' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'MasterCRM user not found'
    });
  });

  it('fails with not found when the owner_key does not exist in ASN', async () => {
    const client = new FakeSupabaseClient();
    client.queue('mastercrm_users', 'select', {
      data: {
        id: 123,
        username: 'juan',
        nombre: 'Juan Perez',
        telefono: null,
        inversion: 0,
        is_active: true,
        created_at: '2026-03-10T12:00:00.000Z'
      },
      error: null
    });
    client.queue('owners', 'select', { data: null, error: null });
    const store = createMastercrmUserStore(client as unknown as SupabaseClient);

    await expect(store.linkCashierToUser({ userId: 123, ownerKey: 'owner_missing' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Cashier owner_key not found'
    });
  });

  it('fails with conflict when the link already exists', async () => {
    const client = new FakeSupabaseClient();
    client.queue('mastercrm_users', 'select', {
      data: {
        id: 123,
        username: 'juan',
        nombre: 'Juan Perez',
        telefono: null,
        inversion: 0,
        is_active: true,
        created_at: '2026-03-10T12:00:00.000Z'
      },
      error: null
    });
    client.queue('owners', 'select', {
      data: {
        id: 'owner-1',
        owner_key: 'owner_1'
      },
      error: null
    });
    client.queue('mastercrm_user_owner_links', 'insert', {
      data: null,
      error: createPostgrestError('23505', 'duplicate key value violates unique constraint')
    });
    const store = createMastercrmUserStore(client as unknown as SupabaseClient);

    await expect(store.linkCashierToUser({ userId: 123, ownerKey: 'owner_1' })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'MasterCRM user is already linked to this cashier'
    });
  });
});
