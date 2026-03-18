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
  private operation: 'select' | 'insert' | 'update' | 'upsert' = 'select';
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

  update(payload: unknown): FakeQueryBuilder {
    this.operation = 'update';
    this.client.calls.push({ table: this.table, operation: 'update', payload });
    return this;
  }

  upsert(payload: unknown, options?: Record<string, unknown>): FakeQueryBuilder {
    this.operation = 'upsert';
    this.client.calls.push({ table: this.table, operation: 'upsert', payload, options });
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

  gte(column: string, value: unknown): FakeQueryBuilder {
    this.filters.push({ column: `${column}>=`, value });
    this.client.calls.push({ table: this.table, operation: 'filter-gte', column, value });
    return this;
  }

  lt(column: string, value: unknown): FakeQueryBuilder {
    this.filters.push({ column: `${column}<`, value });
    this.client.calls.push({ table: this.table, operation: 'filter-lt', column, value });
    return this;
  }

  order(column: string, options?: Record<string, unknown>): FakeQueryBuilder {
    this.client.calls.push({ table: this.table, operation: 'order', column, options });
    return this;
  }

  limit(value: number): FakeQueryBuilder {
    this.client.calls.push({ table: this.table, operation: 'limit', value });
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

  queue(table: string, operation: 'select' | 'insert' | 'update' | 'upsert', result: QueryResult): void {
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
    operation: 'select' | 'insert' | 'update' | 'upsert',
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
        owner_key: 'owner_key_del_cajero',
        owner_label: 'Owner Label',
        pagina: 'ASN'
      },
      error: null
    });
    client.queue('mastercrm_user_owner_links', 'select', {
      data: null,
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
      ownerLabel: 'Owner Label',
      pagina: 'ASN',
      linked: true,
      replaced: false,
      previousOwnerKey: null
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

  it('replaces the previous owner when the user was already linked', async () => {
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
        owner_key: 'owner_1',
        owner_label: 'Owner 1',
        pagina: 'ASN'
      },
      error: null
    });
    client.queue('mastercrm_user_owner_links', 'select', {
      data: {
        id: 'link-1',
        owner_id: 'owner-old',
        owners: {
          id: 'owner-old',
          owner_key: 'owner_old',
          owner_label: 'Owner Old',
          pagina: 'ASN'
        }
      },
      error: null
    });
    client.queue('mastercrm_user_owner_links', 'update', {
      data: null,
      error: null
    });
    const store = createMastercrmUserStore(client as unknown as SupabaseClient);

    await expect(store.linkCashierToUser({ userId: 123, ownerKey: 'owner_1' })).resolves.toEqual({
      userId: 123,
      ownerKey: 'owner_1',
      ownerLabel: 'Owner 1',
      pagina: 'ASN',
      linked: true,
      replaced: true,
      previousOwnerKey: 'owner_old'
    });
    expect(client.calls).toContainEqual({
      table: 'mastercrm_user_owner_links',
      operation: 'update',
      payload: {
        owner_id: 'owner-1'
      }
    });
  });
});

describe('mastercrm clients dashboard', () => {
  it('uses the preferred owner alias phone in the linked owner payload', async () => {
    const client = new FakeSupabaseClient();
    client.queue('mastercrm_users', 'select', {
      data: {
        id: 123,
        username: 'juan',
        nombre: 'Juan Perez',
        telefono: '54911',
        inversion: 0,
        is_active: true,
        created_at: '2026-03-10T12:00:00.000Z'
      },
      error: null
    });
    client.queue('mastercrm_user_owner_links', 'select', {
      data: {
        id: 'link-1',
        owner_id: 'owner-1',
        owners: {
          id: 'owner-1',
          owner_key: 'owner_1',
          owner_label: 'Owner 1',
          pagina: 'ASN'
        }
      },
      error: null
    });
    client.queue('owner_aliases', 'select', {
      data: [
        {
          alias_phone: '+5491111111111',
          is_active: false,
          updated_at: '2026-03-11T10:00:00.000Z',
          last_seen_at: '2026-03-11T10:00:00.000Z'
        },
        {
          alias_phone: '+5492222222222',
          is_active: true,
          updated_at: '2026-03-12T11:00:00.000Z',
          last_seen_at: '2026-03-12T11:00:00.000Z'
        }
      ],
      error: null
    });
    client.queue('owner_client_links', 'select', {
      data: [],
      error: null
    });
    client.queue('owner_client_identities', 'select', {
      data: [],
      error: null
    });
    client.queue('report_daily_snapshots', 'select', {
      data: [],
      error: null
    });
    client.queue('report_daily_snapshots', 'select', {
      data: [],
      error: null
    });
    client.queue('owner_financial_settings', 'select', {
      data: null,
      error: null
    });
    client.queue('owner_monthly_ad_spend', 'select', {
      data: null,
      error: null
    });
    client.queue('owner_client_events', 'select', {
      data: [],
      error: null
    });

    const store = createMastercrmUserStore(client as unknown as SupabaseClient);
    const dashboard = await store.getClientsDashboard({ userId: 123, month: '2026-03' });

    expect(dashboard).toEqual({
      linkedOwner: {
        ownerId: 'owner-1',
        ownerKey: 'owner_1',
        ownerLabel: 'Owner 1',
        pagina: 'ASN',
        telefono: '+5492222222222'
      },
      summary: {
        totalClients: 0,
        assignedClients: 0,
        pendingClients: 0,
        reportDate: null,
        reportUpdatedAt: null,
        cargadoHoyTotal: null,
        cargadoMesTotal: null,
        hasReport: false
      },
      financialInputs: {
        month: '2026-03',
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
      charts: {
        monthlyTrend: [
          { month: '2025-10', reportDate: null, cargadoMesArs: null },
          { month: '2025-11', reportDate: null, cargadoMesArs: null },
          { month: '2025-12', reportDate: null, cargadoMesArs: null },
          { month: '2026-01', reportDate: null, cargadoMesArs: null },
          { month: '2026-02', reportDate: null, cargadoMesArs: null },
          { month: '2026-03', reportDate: null, cargadoMesArs: null }
        ]
      },
      clientes: []
    });
  });

  it('hides shared usernames for pending links in the dashboard payload', async () => {
    const client = new FakeSupabaseClient();
    client.queue('mastercrm_users', 'select', {
      data: {
        id: 321,
        username: 'vicky',
        nombre: 'Vicky',
        telefono: '54911',
        inversion: 0,
        is_active: true,
        created_at: '2026-03-10T12:00:00.000Z'
      },
      error: null
    });
    client.queue('mastercrm_user_owner_links', 'select', {
      data: {
        id: 'link-1',
        owner_id: 'owner-vicky',
        owners: {
          id: 'owner-vicky',
          owner_key: 'asnlucas10:vicky',
          owner_label: 'Vicky',
          pagina: 'ASN'
        }
      },
      error: null
    });
    client.queue('owner_aliases', 'select', {
      data: [],
      error: null
    });
    client.queue('owner_client_links', 'select', {
      data: [
        {
          id: 'link-pending',
          status: 'pending',
          client_id: 'client-1',
          clients: {
            id: 'client-1',
            phone_e164: '+5493735506280',
            pagina: 'ASN'
          }
        }
      ],
      error: null
    });
    client.queue('owner_client_identities', 'select', {
      data: [],
      error: null
    });
    client.queue('report_daily_snapshots', 'select', {
      data: [],
      error: null
    });
    client.queue('report_daily_snapshots', 'select', {
      data: [],
      error: null
    });
    client.queue('owner_financial_settings', 'select', {
      data: null,
      error: null
    });
    client.queue('owner_monthly_ad_spend', 'select', {
      data: null,
      error: null
    });
    client.queue('owner_client_events', 'select', {
      data: [],
      error: null
    });

    const store = createMastercrmUserStore(client as unknown as SupabaseClient);
    const dashboard = await store.getClientsDashboard({ userId: 321, month: '2026-03' });

    expect(dashboard.clientes).toEqual([
      {
        id: 'link-pending',
        username: null,
        telefono: '+5493735506280',
        pagina: 'ASN',
        estado: 'pending',
        ownerKey: 'asnlucas10:vicky',
        ownerLabel: 'Vicky',
        cargadoHoy: null,
        cargadoMes: null,
        reportDate: null
      }
    ]);
  });

  it('calculates intake to assignment rate from unique monthly leads that ended assigned', async () => {
    const client = new FakeSupabaseClient();
    client.queue('mastercrm_users', 'select', {
      data: {
        id: 777,
        username: 'lucas',
        nombre: 'Lucas',
        telefono: '54911',
        inversion: 0,
        is_active: true,
        created_at: '2026-03-10T12:00:00.000Z'
      },
      error: null
    });
    client.queue('mastercrm_user_owner_links', 'select', {
      data: {
        id: 'crm-link-1',
        owner_id: 'owner-lucas',
        owners: {
          id: 'owner-lucas',
          owner_key: 'asnlucas10:lucas10',
          owner_label: 'Lucas10',
          pagina: 'ASN'
        }
      },
      error: null
    });
    client.queue('owner_aliases', 'select', {
      data: [],
      error: null
    });
    client.queue('owner_client_links', 'select', {
      data: [
        {
          id: 'link-1',
          status: 'assigned',
          client_id: 'client-1',
          clients: { id: 'client-1', phone_e164: '+5491111111111', pagina: 'ASN' }
        },
        {
          id: 'link-2',
          status: 'assigned',
          client_id: 'client-2',
          clients: { id: 'client-2', phone_e164: '+5492222222222', pagina: 'ASN' }
        },
        {
          id: 'link-3',
          status: 'assigned',
          client_id: 'client-3',
          clients: { id: 'client-3', phone_e164: '+5493333333333', pagina: 'ASN' }
        }
      ],
      error: null
    });
    client.queue('owner_client_identities', 'select', {
      data: [
        { id: 'identity-1', owner_client_link_id: 'link-1', username: 'uno', is_active: true },
        { id: 'identity-2', owner_client_link_id: 'link-2', username: 'dos', is_active: true },
        { id: 'identity-3', owner_client_link_id: 'link-3', username: 'tres', is_active: true }
      ],
      error: null
    });
    client.queue('report_daily_snapshots', 'select', {
      data: [],
      error: null
    });
    client.queue('report_daily_snapshots', 'select', {
      data: [],
      error: null
    });
    client.queue('owner_financial_settings', 'select', {
      data: null,
      error: null
    });
    client.queue('owner_monthly_ad_spend', 'select', {
      data: null,
      error: null
    });
    client.queue('owner_client_events', 'select', {
      data: [
        { client_id: 'client-1', event_type: 'intake' },
        { client_id: 'client-1', event_type: 'intake' },
        { client_id: 'client-2', event_type: 'intake' },
        { client_id: 'client-1', event_type: 'assign_username' },
        { client_id: 'client-2', event_type: 'assign_username' },
        { client_id: 'client-3', event_type: 'assign_username' }
      ],
      error: null
    });

    const store = createMastercrmUserStore(client as unknown as SupabaseClient);
    const dashboard = await store.getClientsDashboard({ userId: 777, month: '2026-03' });

    expect(dashboard.statsKpis.intakesMes).toBe(2);
    expect(dashboard.statsKpis.asignacionesMes).toBe(3);
    expect(dashboard.statsKpis.tasaIntakeAsignacionPct).toBe(100);
  });

  it('builds monthly trend from the latest snapshot date of each month', async () => {
    const client = new FakeSupabaseClient();
    client.queue('mastercrm_users', 'select', {
      data: {
        id: 777,
        username: 'lucas',
        nombre: 'Lucas',
        telefono: '54911',
        inversion: 0,
        is_active: true,
        created_at: '2026-03-10T12:00:00.000Z'
      },
      error: null
    });
    client.queue('mastercrm_user_owner_links', 'select', {
      data: {
        id: 'crm-link-1',
        owner_id: 'owner-lucas',
        owners: {
          id: 'owner-lucas',
          owner_key: 'asnlucas10:lucas10',
          owner_label: 'Lucas10',
          pagina: 'ASN'
        }
      },
      error: null
    });
    client.queue('owner_aliases', 'select', {
      data: [],
      error: null
    });
    client.queue('owner_client_links', 'select', {
      data: [],
      error: null
    });
    client.queue('owner_client_identities', 'select', {
      data: [],
      error: null
    });
    client.queue('report_daily_snapshots', 'select', {
      data: [],
      error: null
    });
    client.queue('owner_financial_settings', 'select', {
      data: null,
      error: null
    });
    client.queue('owner_monthly_ad_spend', 'select', {
      data: null,
      error: null
    });
    client.queue('owner_client_events', 'select', {
      data: [],
      error: null
    });
    client.queue('report_daily_snapshots', 'select', {
      data: [
        { report_date: '2025-11-29', cargado_mes: 10000 },
        { report_date: '2025-11-29', cargado_mes: 5000 },
        { report_date: '2025-12-31', cargado_mes: 14000 },
        { report_date: '2026-01-30', cargado_mes: 20000 },
        { report_date: '2026-01-31', cargado_mes: 30000 },
        { report_date: '2026-02-15', cargado_mes: 22000 },
        { report_date: '2026-03-12', cargado_mes: 25000 },
        { report_date: '2026-03-16', cargado_mes: 41000 },
        { report_date: '2026-03-16', cargado_mes: 9000 }
      ],
      error: null
    });

    const store = createMastercrmUserStore(client as unknown as SupabaseClient);
    const dashboard = await store.getClientsDashboard({ userId: 777, month: '2026-03' });

    expect(dashboard.charts.monthlyTrend).toEqual([
      { month: '2025-10', reportDate: null, cargadoMesArs: null },
      { month: '2025-11', reportDate: '2025-11-29', cargadoMesArs: 15000 },
      { month: '2025-12', reportDate: '2025-12-31', cargadoMesArs: 14000 },
      { month: '2026-01', reportDate: '2026-01-31', cargadoMesArs: 30000 },
      { month: '2026-02', reportDate: '2026-02-15', cargadoMesArs: 22000 },
      { month: '2026-03', reportDate: '2026-03-16', cargadoMesArs: 50000 }
    ]);
  });
});
