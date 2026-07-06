import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import {
  SUPABASE_SELECT_PAGE_SIZE,
  attributionFromSourceContext,
  createMastercrmUserStore,
  hashMastercrmPassword,
  normalizeMastercrmNombre,
  normalizeMastercrmOwnerKey,
  normalizeMastercrmTelefono,
  normalizeMastercrmUsername,
  selectAllSupabasePages,
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

  in(column: string, value: unknown[]): FakeQueryBuilder {
    this.filters.push({ column: `${column} in`, value });
    this.client.calls.push({ table: this.table, operation: 'filter-in', column, value });
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

  range(from: number, to: number): FakeQueryBuilder {
    this.client.calls.push({ table: this.table, operation: 'range', from, to });
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

  queue(table: string, operation: 'select' | 'insert' | 'update' | 'upsert' | 'rpc', result: QueryResult): void {
    const key = `${table}:${operation}`;
    const pending = this.results.get(key) ?? [];
    pending.push(result);
    this.results.set(key, pending);
  }

  from(table: string): FakeQueryBuilder {
    this.calls.push({ table, operation: 'from' });
    return new FakeQueryBuilder(this, table);
  }

  async rpc(name: string, payload: unknown): Promise<QueryResult> {
    this.calls.push({ operation: 'rpc', name, payload });
    return this.dequeue(name, 'rpc', []);
  }

  async dequeue(
    table: string,
    operation: 'select' | 'insert' | 'update' | 'upsert' | 'rpc',
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

function expectedEmptyAttribution() {
  return {
    kind: 'unknown',
    label: 'Sin dato',
    campaign: null,
    meta: {
      referralSourceId: null,
      referralSourceUrl: null,
      referralHeadline: null,
      referralBody: null,
      referralSourceType: null,
      ctwaClid: null
    },
    landing: {
      landingSessionId: null,
      platform: null,
      placement: null,
      utmSource: null,
      utmMedium: null,
      utmId: null,
      utmCampaign: null,
      utmContent: null,
      utmTerm: null,
      campaignName: null,
      campaignId: null,
      adsetName: null,
      adsetId: null,
      adName: null,
      adId: null,
      legacyIdsOnly: false,
      fbclid: null,
      eventSourceUrl: null,
      whatsappUrl: null
    }
  };
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
  function buildPagedRows(count: number): Array<{ id: number }> {
    return Array.from({ length: count }, (_, index) => ({ id: index + 1 }));
  }

  function buildPagedQuery(client: FakeSupabaseClient): ReturnType<FakeSupabaseClient['from']> {
    return client.from('paged_rows').select('id').order('id', { ascending: true });
  }

  it('reads zero rows with the paginated Supabase helper', async () => {
    const client = new FakeSupabaseClient();
    client.queue('paged_rows', 'select', { data: [], error: null });

    await expect(selectAllSupabasePages(() => buildPagedQuery(client), 'Could not read paged rows')).resolves.toEqual([]);
    expect(client.calls.filter((call) => call.operation === 'range')).toEqual([
      { table: 'paged_rows', operation: 'range', from: 0, to: SUPABASE_SELECT_PAGE_SIZE - 1 }
    ]);
  });

  it('reads one partial page with the paginated Supabase helper', async () => {
    const client = new FakeSupabaseClient();
    const rows = buildPagedRows(SUPABASE_SELECT_PAGE_SIZE - 1);
    client.queue('paged_rows', 'select', { data: rows, error: null });

    await expect(selectAllSupabasePages(() => buildPagedQuery(client), 'Could not read paged rows')).resolves.toHaveLength(
      SUPABASE_SELECT_PAGE_SIZE - 1
    );
    expect(client.calls.filter((call) => call.operation === 'range')).toHaveLength(1);
  });

  it('reads an exact full page and confirms the next page is empty', async () => {
    const client = new FakeSupabaseClient();
    client.queue('paged_rows', 'select', { data: buildPagedRows(SUPABASE_SELECT_PAGE_SIZE), error: null });
    client.queue('paged_rows', 'select', { data: [], error: null });

    await expect(selectAllSupabasePages(() => buildPagedQuery(client), 'Could not read paged rows')).resolves.toHaveLength(
      SUPABASE_SELECT_PAGE_SIZE
    );
    expect(client.calls.filter((call) => call.operation === 'range')).toEqual([
      { table: 'paged_rows', operation: 'range', from: 0, to: SUPABASE_SELECT_PAGE_SIZE - 1 },
      {
        table: 'paged_rows',
        operation: 'range',
        from: SUPABASE_SELECT_PAGE_SIZE,
        to: SUPABASE_SELECT_PAGE_SIZE * 2 - 1
      }
    ]);
  });

  it('reads multiple pages with the paginated Supabase helper', async () => {
    const client = new FakeSupabaseClient();
    client.queue('paged_rows', 'select', { data: buildPagedRows(SUPABASE_SELECT_PAGE_SIZE), error: null });
    client.queue('paged_rows', 'select', { data: [{ id: SUPABASE_SELECT_PAGE_SIZE + 1 }], error: null });

    const rows = await selectAllSupabasePages(() => buildPagedQuery(client), 'Could not read paged rows');

    expect(rows).toHaveLength(SUPABASE_SELECT_PAGE_SIZE + 1);
    expect(rows.at(-1)).toEqual({ id: SUPABASE_SELECT_PAGE_SIZE + 1 });
  });

  it('surfaces paginated Supabase helper errors from later pages', async () => {
    const client = new FakeSupabaseClient();
    client.queue('paged_rows', 'select', { data: buildPagedRows(SUPABASE_SELECT_PAGE_SIZE), error: null });
    client.queue('paged_rows', 'select', {
      data: null,
      error: createPostgrestError('XX000', 'second page failed')
    });

    await expect(selectAllSupabasePages(() => buildPagedQuery(client), 'Could not read paged rows')).rejects.toMatchObject({
      code: 'INTERNAL',
      message: 'Could not read paged rows (XX000: second page failed)'
    });
  });

  it('maps historical numeric UTM values to IDs without inventing names', () => {
    expect(
      attributionFromSourceContext({
        landingSessionId: 'session-historical',
        utmSource: 'fb',
        utmCampaign: '6991129588056',
        utmTerm: '69911377388568',
        utmContent: '699113773885680'
      })
    ).toMatchObject({
      kind: 'landing',
      campaign: '6991129588056',
      landing: {
        platform: 'fb',
        campaignName: null,
        campaignId: '6991129588056',
        adsetName: null,
        adsetId: '69911377388568',
        adName: null,
        adId: '699113773885680',
        legacyIdsOnly: true
      }
    });
  });

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

describe('mastercrm marketing budgets', () => {
  function queueActiveUserAndOwner(client: FakeSupabaseClient): void {
    client.queue('mastercrm_users', 'select', {
      data: {
        id: 999,
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
          owner_key: 'luqui10:luqui10',
          owner_label: 'Lucas10',
          pagina: 'RdA'
        }
      },
      error: null
    });
  }

  it('distributes ad budgets through the atomic Supabase RPC', async () => {
    const client = new FakeSupabaseClient();
    queueActiveUserAndOwner(client);
    client.queue('distribute_owner_marketing_ad_budgets_v1', 'rpc', {
      data: [
        {
          id: 'budget-1',
          channel: 'meta_ctwa',
          level: 'ad',
          campaign_key: 'Reino Dorado',
          campaign_name: 'Reino Dorado',
          ad_key: 'ad-1',
          ad_name: 'Anuncio 1',
          link_url: null,
          daily_budget_ars: '333.34',
          active_from: '2026-06-01',
          active_to: '2026-06-19',
          updated_at: '2026-06-19T12:00:00.000Z'
        },
        {
          id: 'budget-2',
          channel: 'meta_ctwa',
          level: 'ad',
          campaign_key: 'Reino Dorado',
          campaign_name: 'Reino Dorado',
          ad_key: 'ad-2',
          ad_name: 'Anuncio 2',
          link_url: null,
          daily_budget_ars: '333.33',
          active_from: '2026-06-01',
          active_to: '2026-06-19',
          updated_at: '2026-06-19T12:00:00.000Z'
        },
        {
          id: 'budget-3',
          channel: 'meta_ctwa',
          level: 'ad',
          campaign_key: 'Reino Dorado',
          campaign_name: 'Reino Dorado',
          ad_key: 'ad-3',
          ad_name: 'Anuncio 3',
          link_url: null,
          daily_budget_ars: '333.33',
          active_from: '2026-06-01',
          active_to: '2026-06-19',
          updated_at: '2026-06-19T12:00:00.000Z'
        }
      ],
      error: null
    });

    const store = createMastercrmUserStore(client as unknown as SupabaseClient);
    const budgets = await store.distributeMarketingBudgets({
      userId: 999,
      totalDailyBudgetArs: 1000,
      activeFrom: '2026-06-01',
      activeTo: '2026-06-19',
      ads: [
        {
          channel: 'meta_ctwa',
          campaignKey: 'Reino Dorado',
          campaignName: 'Reino Dorado',
          adKey: 'ad-1',
          adName: 'Anuncio 1'
        },
        {
          channel: 'meta_ctwa',
          campaignKey: 'Reino Dorado',
          campaignName: 'Reino Dorado',
          adKey: 'ad-2',
          adName: 'Anuncio 2'
        },
        {
          channel: 'meta_ctwa',
          campaignKey: 'Reino Dorado',
          campaignName: 'Reino Dorado',
          adKey: 'ad-3',
          adName: 'Anuncio 3'
        }
      ]
    });

    expect(budgets.map((budget) => budget.dailyBudgetArs)).toEqual([333.34, 333.33, 333.33]);
    expect(client.calls.find((call) => call.operation === 'rpc')).toMatchObject({
      name: 'distribute_owner_marketing_ad_budgets_v1',
      payload: {
        p_owner_id: 'owner-lucas',
        p_mastercrm_user_id: 999,
        p_total_daily_budget_ars: 1000,
        p_active_from: '2026-06-01',
        p_active_to: '2026-06-19'
      }
    });
  });

  it('rejects distributed budgets with mixed channels before calling Supabase', async () => {
    const client = new FakeSupabaseClient();
    const store = createMastercrmUserStore(client as unknown as SupabaseClient);

    await expect(
      store.distributeMarketingBudgets({
        userId: 999,
        totalDailyBudgetArs: 1000,
        activeFrom: '2026-06-01',
        ads: [
          {
            channel: 'meta_ctwa',
            campaignKey: 'Reino Dorado',
            campaignName: 'Reino Dorado',
            adKey: 'ad-1'
          },
          {
            channel: 'landing',
            campaignKey: 'Landing Test',
            campaignName: 'Landing Test',
            adKey: 'landing-ad-1'
          }
        ]
      })
    ).rejects.toMatchObject({
      code: 'VALIDATION',
      message: 'all ads must use the same channel'
    });
    expect(client.calls).toEqual([]);
  });

  it('surfaces distributed budget overlap conflicts with affected ads', async () => {
    const client = new FakeSupabaseClient();
    queueActiveUserAndOwner(client);
    client.queue('distribute_owner_marketing_ad_budgets_v1', 'rpc', {
      data: null,
      error: createPostgrestError('23505', 'Budget overlaps existing ads: meta_ctwa / Reino Dorado / Anuncio 1')
    });

    const store = createMastercrmUserStore(client as unknown as SupabaseClient);

    await expect(
      store.distributeMarketingBudgets({
        userId: 999,
        totalDailyBudgetArs: 1000,
        activeFrom: '2026-06-01',
        ads: [
          {
            channel: 'meta_ctwa',
            campaignKey: 'Reino Dorado',
            campaignName: 'Reino Dorado',
            adKey: 'ad-1',
            adName: 'Anuncio 1'
          },
          {
            channel: 'meta_ctwa',
            campaignKey: 'Reino Dorado',
            campaignName: 'Reino Dorado',
            adKey: 'ad-2',
            adName: 'Anuncio 2'
          }
        ]
      })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Budget overlaps existing ads: meta_ctwa / Reino Dorado / Anuncio 1'
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
    client.queue('owner_client_monthly_facts', 'select', {
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
    client.queue('report_daily_snapshots', 'select', {
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
        reingresosMes: 0,
        asignacionesMes: 0,
        asignacionesBacklogMes: 0,
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
    client.queue('owner_client_monthly_facts', 'select', {
      data: [
        {
          owner_id: 'owner-vicky',
          client_id: 'client-old',
          link_id: 'link-old-pending',
          month_start: '2026-03-01',
          status_at_month_end: 'pending',
          identity_id_at_month_end: null,
          username_at_month_end: null,
          had_intake_in_month: false,
          is_new_intake_in_month: false,
          is_reentry_in_month: false,
          had_assignment_in_month: false,
          assigned_from_backlog_in_month: false,
          clients: {
            id: 'client-old',
            phone_e164: '+5493735506281',
            pagina: 'ASN',
            created_at: '2026-02-13T09:30:00.000Z'
          }
        },
        {
          owner_id: 'owner-vicky',
          client_id: 'client-1',
          link_id: 'link-pending',
          month_start: '2026-03-01',
          status_at_month_end: 'pending',
          identity_id_at_month_end: null,
          username_at_month_end: null,
          had_intake_in_month: true,
          is_new_intake_in_month: true,
          is_reentry_in_month: false,
          had_assignment_in_month: false,
          assigned_from_backlog_in_month: false,
          clients: {
            id: 'client-1',
            phone_e164: '+5493735506280',
            pagina: 'ASN',
            created_at: '2026-02-14T09:30:00.000Z'
          }
        }
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
    client.queue('report_daily_snapshots', 'select', {
      data: [],
      error: null
    });
    client.queue('owner_client_links', 'select', {
      data: [],
      error: null
    });
    client.queue('owner_client_events', 'select', {
      data: [],
      error: null
    });

    const store = createMastercrmUserStore(client as unknown as SupabaseClient);
    const dashboard = await store.getClientsDashboard({ userId: 321, month: '2026-03' });

    expect(dashboard.statsKpis.clientesTotales).toBe(2);
    expect(dashboard.clientes).toEqual([
      {
        id: 'link-pending',
        username: null,
        telefono: '+5493735506280',
        pagina: 'ASN',
        estado: 'pending',
        source: null,
        origen: null,
        Campana: null,
        lastCampaign: null,
        attribution: expectedEmptyAttribution(),
        ownerKey: 'asnlucas10:vicky',
        ownerLabel: 'Vicky',
        firstSeenAt: '2026-02-14T09:30:00.000Z',
        cargadoHoy: null,
        cargadoMes: null,
        reportDate: null,
        isNewIntakeMes: true,
        isReingresoMes: false,
        assignedEnMes: false,
        assignedDesdeBacklogMes: false
      },
      {
        id: 'link-old-pending',
        username: null,
        telefono: '+5493735506281',
        pagina: 'ASN',
        estado: 'pending',
        source: null,
        origen: null,
        Campana: null,
        lastCampaign: null,
        attribution: expectedEmptyAttribution(),
        ownerKey: 'asnlucas10:vicky',
        ownerLabel: 'Vicky',
        firstSeenAt: '2026-02-13T09:30:00.000Z',
        cargadoHoy: null,
        cargadoMes: null,
        reportDate: null,
        isNewIntakeMes: false,
        isReingresoMes: false,
        assignedEnMes: false,
        assignedDesdeBacklogMes: false
      }
    ]);
  });

  it('adds exact landing and Meta attribution from intake events to dashboard clients', async () => {
    const client = new FakeSupabaseClient();
    client.queue('mastercrm_users', 'select', {
      data: {
        id: 654,
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
          owner_key: 'luqui10:luqui10',
          owner_label: 'Lucas10',
          pagina: 'RdA'
        }
      },
      error: null
    });
    client.queue('owner_aliases', 'select', {
      data: [],
      error: null
    });
    client.queue('owner_client_monthly_facts', 'select', {
      data: [
        {
          owner_id: 'owner-lucas',
          client_id: 'client-landing',
          link_id: 'link-landing',
          month_start: '2026-03-01',
          status_at_month_end: 'assigned',
          identity_id_at_month_end: 'identity-landing',
          username_at_month_end: 'landinguser',
          had_intake_in_month: true,
          is_new_intake_in_month: true,
          is_reentry_in_month: false,
          had_assignment_in_month: true,
          assigned_from_backlog_in_month: false,
          clients: { id: 'client-landing', phone_e164: '+5493511112222', pagina: 'RdA' }
        },
        {
          owner_id: 'owner-lucas',
          client_id: 'client-meta',
          link_id: 'link-meta',
          month_start: '2026-03-01',
          status_at_month_end: 'assigned',
          identity_id_at_month_end: 'identity-meta',
          username_at_month_end: 'metauser',
          had_intake_in_month: true,
          is_new_intake_in_month: true,
          is_reentry_in_month: false,
          had_assignment_in_month: true,
          assigned_from_backlog_in_month: false,
          clients: { id: 'client-meta', phone_e164: '+5493513334444', pagina: 'RdA' }
        }
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
    client.queue('report_daily_snapshots', 'select', {
      data: [],
      error: null
    });
    client.queue('owner_client_links', 'select', {
      data: [
        { id: 'link-landing', first_seen_at: '2026-03-01T10:00:00.000Z' },
        { id: 'link-meta', first_seen_at: '2026-03-02T10:00:00.000Z' }
      ],
      error: null
    });
    client.queue('owner_client_events', 'select', {
      data: [
        {
          client_id: 'client-landing',
          event_type: 'intake',
          occurred_at: '2026-03-01T10:01:00.000Z',
          payload: {
            LandingSessionId: 'session-landing',
            UtmSource: 'fb',
            UtmId: '6991129588056',
            UtmCampaign: 'RDA Landing',
            UtmTerm: 'Prospeccion',
            UtmContent: 'Video 1',
            AdsetId: '69911377388568',
            AdId: '699113773885680',
            Placement: 'facebook_feed',
            Fbclid: 'fbclid-landing',
            EventSourceUrl: 'https://reydeases.imperial-support.com/landing?utm_campaign=RDA%20Landing',
            WhatsappUrl: 'https://wa.me/5493515747477'
          }
        },
        {
          client_id: 'client-meta',
          event_type: 'intake',
          occurred_at: '2026-03-02T10:01:00.000Z',
          payload: {
            ReferralCtwaClid: 'ctwa-123',
            ReferralSourceId: '6967964924256',
            ReferralSourceUrl: 'https://fb.me/4zpjtyI5v',
            ReferralHeadline: 'ROYAL LUCK',
            ReferralBody: 'Texto real del anuncio',
            ReferralSourceType: 'ad'
          }
        }
      ],
      error: null
    });

    const store = createMastercrmUserStore(client as unknown as SupabaseClient);
    const dashboard = await store.getClientsDashboard({ userId: 654, month: '2026-03' });

    expect(dashboard.clientes).toHaveLength(2);
    expect(dashboard.clientes.find((item) => item.id === 'link-landing')).toMatchObject({
      source: 'Landing',
      origen: 'Landing',
      Campana: 'RDA Landing',
      lastCampaign: 'RDA Landing',
      attribution: {
        kind: 'landing',
        label: 'Landing',
        campaign: 'RDA Landing',
        landing: {
          landingSessionId: 'session-landing',
          platform: 'fb',
          placement: 'facebook_feed',
          utmSource: 'fb',
          utmId: '6991129588056',
          utmCampaign: 'RDA Landing',
          campaignName: 'RDA Landing',
          campaignId: '6991129588056',
          adsetName: 'Prospeccion',
          adsetId: '69911377388568',
          adName: 'Video 1',
          adId: '699113773885680',
          legacyIdsOnly: false,
          fbclid: 'fbclid-landing'
        }
      }
    });
    expect(dashboard.clientes.find((item) => item.id === 'link-meta')).toMatchObject({
      source: 'Meta WhatsApp',
      origen: 'Meta WhatsApp',
      Campana: 'ROYAL LUCK',
      lastCampaign: 'ROYAL LUCK',
      attribution: {
        kind: 'meta_ctwa',
        label: 'Meta WhatsApp',
        campaign: 'ROYAL LUCK',
        meta: {
          referralSourceId: '6967964924256',
          referralSourceUrl: 'https://fb.me/4zpjtyI5v',
          referralHeadline: 'ROYAL LUCK',
          referralBody: 'Texto real del anuncio',
          referralSourceType: 'ad',
          ctwaClid: 'ctwa-123'
        }
      }
    });
  });

  it('builds marketing analytics from first acquisition, monthly snapshot deltas and daily budgets', async () => {
    const client = new FakeSupabaseClient();
    client.queue('mastercrm_users', 'select', {
      data: {
        id: 999,
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
          owner_key: 'luqui10:luqui10',
          owner_label: 'Lucas10',
          pagina: 'RdA'
        }
      },
      error: null
    });
    client.queue('owner_aliases', 'select', { data: [], error: null });
    client.queue('owner_client_events', 'select', {
      data: [
        {
          client_id: 'client-landing',
          event_type: 'intake',
          occurred_at: '2026-06-10T13:00:00.000Z',
          payload: {
            LandingSessionId: 'landing-session-1',
            UtmCampaign: 'TESTEO V2',
            UtmContent: 'Anuncio A',
            UtmId: 'campaign-1',
            AdId: 'ad-1',
            EventSourceUrl: 'https://example.test/landing'
          }
        },
        {
          client_id: 'client-negative',
          event_type: 'intake',
          occurred_at: '2026-06-11T13:00:00.000Z',
          payload: {
            LandingSessionId: 'landing-session-2',
            UtmCampaign: 'TESTEO V2',
            UtmContent: 'Anuncio B',
            UtmId: 'campaign-1',
            AdId: 'ad-2'
          }
        },
        {
          client_id: 'client-unknown',
          event_type: 'intake',
          occurred_at: '2026-06-12T13:00:00.000Z',
          payload: {}
        },
        {
          client_id: 'client-unmatched',
          event_type: 'intake',
          occurred_at: '2026-06-13T13:00:00.000Z',
          payload: {
            UtmCampaign: 'Landing sin sesion',
            UtmContent: 'Anuncio C'
          }
        },
        {
          client_id: 'client-reentry',
          event_type: 'intake',
          occurred_at: '2026-05-20T13:00:00.000Z',
          payload: {
            LandingSessionId: 'landing-session-old',
            UtmCampaign: 'Mayo',
            UtmContent: 'Anuncio viejo'
          }
        },
        {
          client_id: 'client-reentry',
          event_type: 'intake',
          occurred_at: '2026-06-14T13:00:00.000Z',
          payload: {
            LandingSessionId: 'landing-session-new',
            UtmCampaign: 'Junio',
            UtmContent: 'Anuncio nuevo'
          }
        }
      ],
      error: null
    });
    client.queue('owner_client_monthly_facts', 'select', {
      data: [
        {
          owner_id: 'owner-lucas',
          client_id: 'client-landing',
          link_id: 'link-landing',
          month_start: '2026-06-01',
          status_at_month_end: 'assigned',
          identity_id_at_month_end: 'identity-landing',
          username_at_month_end: 'landinguser',
          had_intake_in_month: true,
          is_new_intake_in_month: true,
          is_reentry_in_month: false,
          had_assignment_in_month: true,
          assigned_from_backlog_in_month: false,
          clients: { id: 'client-landing', phone_e164: '+5493511112222', pagina: 'RdA' }
        },
        {
          owner_id: 'owner-lucas',
          client_id: 'client-negative',
          link_id: 'link-negative',
          month_start: '2026-06-01',
          status_at_month_end: 'assigned',
          identity_id_at_month_end: 'identity-negative',
          username_at_month_end: 'negativeuser',
          had_intake_in_month: true,
          is_new_intake_in_month: true,
          is_reentry_in_month: false,
          had_assignment_in_month: true,
          assigned_from_backlog_in_month: false,
          clients: { id: 'client-negative', phone_e164: '+5493513334444', pagina: 'RdA' }
        }
      ],
      error: null
    });
    client.queue('report_daily_snapshots', 'select', {
      data: [
        {
          client_id: 'client-landing',
          identity_id: 'identity-landing',
          report_date: '2026-06-09',
          username: 'landinguser',
          cargado_hoy: 0,
          cargado_mes: 500
        },
        {
          client_id: 'client-landing',
          identity_id: 'identity-landing',
          report_date: '2026-06-18',
          username: 'landinguser',
          cargado_hoy: 0,
          cargado_mes: 1500
        },
        {
          client_id: 'client-negative',
          identity_id: 'identity-negative',
          report_date: '2026-06-09',
          username: 'negativeuser',
          cargado_hoy: 0,
          cargado_mes: 1000
        },
        {
          client_id: 'client-negative',
          identity_id: 'identity-negative',
          report_date: '2026-06-18',
          username: 'negativeuser',
          cargado_hoy: 0,
          cargado_mes: 800
        }
      ],
      error: null
    });
    client.queue('owner_financial_settings', 'select', {
      data: { commission_pct: 50 },
      error: null
    });
    client.queue('owner_marketing_daily_budgets', 'select', {
      data: [
        {
          id: 'budget-campaign',
          channel: 'landing',
          level: 'campaign',
          campaign_key: 'campaign-1',
          campaign_name: 'TESTEO V2',
          ad_key: '',
          ad_name: null,
          link_url: null,
          daily_budget_ars: 100,
          active_from: '2026-06-10',
          active_to: '2026-06-18',
          updated_at: '2026-06-18T12:00:00.000Z'
        },
        {
          id: 'budget-ad',
          channel: 'landing',
          level: 'ad',
          campaign_key: 'campaign-1',
          campaign_name: 'TESTEO V2',
          ad_key: 'ad-1',
          ad_name: 'Anuncio A',
          link_url: 'https://example.test/landing',
          daily_budget_ars: 10,
          active_from: '2026-06-10',
          active_to: '2026-06-18',
          updated_at: '2026-06-18T12:00:00.000Z'
        }
      ],
      error: null
    });

    const store = createMastercrmUserStore(client as unknown as SupabaseClient);
    const analytics = await store.getMarketingAnalytics({
      userId: 999,
      dateFrom: '2026-06-10',
      dateTo: '2026-06-18'
    });

    expect(analytics.summary).toMatchObject({
      investmentArs: 90,
      revenueArs: 1000,
      estimatedProfitArs: 500,
      roiPct: 455.56,
      roas: 11.11,
      leads: 2,
      depositors: 1
    });
    expect(analytics.campaigns[0]).toMatchObject({
      campaignKey: 'campaign-1',
      campaignName: 'TESTEO V2',
      investmentArs: 90,
      campaignBudgetArs: 0,
      adBudgetArs: 90,
      undistributedBudgetArs: 0
    });
    expect(analytics.ads.find((ad) => ad.adKey === 'ad-1')).toMatchObject({
      investmentArs: 90,
      revenueArs: 1000,
      hasOwnBudget: true
    });
    expect(analytics.audit).toMatchObject({
      unknownLeads: 1,
      landingUnmatchedLeads: 1,
      excludedLeads: 2,
      reentryLeads: 1,
      missingBudgetCampaigns: 0
    });
    expect(analytics.audit.negativeAdjustments).toEqual([
      {
        clientId: 'client-negative',
        username: 'negativeuser',
        amountArs: -200,
        fromDate: '2026-06-10',
        toDate: '2026-06-18'
      }
    ]);
  });

  it('paginates marketing acquisition events and snapshots beyond Supabase default limits', async () => {
    const client = new FakeSupabaseClient();
    client.queue('mastercrm_users', 'select', {
      data: {
        id: 999,
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
          owner_key: 'luqui10:luqui10',
          owner_label: 'Lucas10',
          pagina: 'RdA'
        }
      },
      error: null
    });
    client.queue('owner_aliases', 'select', { data: [], error: null });
    client.queue('owner_client_events', 'select', {
      data: Array.from({ length: SUPABASE_SELECT_PAGE_SIZE }, (_, index) => ({
        client_id: `old-client-${index}`,
        event_type: 'intake',
        occurred_at: '2026-05-15T13:00:00.000Z',
        payload: {}
      })),
      error: null
    });
    client.queue('owner_client_events', 'select', {
      data: [
        {
          client_id: 'client-miriam',
          event_type: 'intake',
          occurred_at: '2026-06-18T16:36:19.121Z',
          payload: {
            ReferralSourceType: 'ad',
            ReferralSourceId: '120250708847350471',
            ReferralSourceUrl: 'https://www.instagram.com/p/DZsKPCVANd0/',
            ReferralHeadline: 'Reino Dorado',
            CtwaClid: 'ctwa-miriam'
          }
        }
      ],
      error: null
    });
    client.queue('owner_client_monthly_facts', 'select', {
      data: [
        {
          owner_id: 'owner-lucas',
          client_id: 'client-miriam',
          link_id: 'link-miriam',
          month_start: '2026-06-01',
          status_at_month_end: 'assigned',
          identity_id_at_month_end: 'identity-miriam',
          username_at_month_end: '3miriam776',
          had_intake_in_month: true,
          is_new_intake_in_month: true,
          is_reentry_in_month: false,
          had_assignment_in_month: true,
          assigned_from_backlog_in_month: false,
          clients: { id: 'client-miriam', phone_e164: '+5493510000776', pagina: 'RdA' }
        }
      ],
      error: null
    });
    client.queue('report_daily_snapshots', 'select', {
      data: Array.from({ length: SUPABASE_SELECT_PAGE_SIZE }, (_, index) => ({
        client_id: `snapshot-client-${index}`,
        identity_id: `snapshot-identity-${index}`,
        report_date: '2026-06-19',
        username: `snapshot${index}`,
        cargado_hoy: 0,
        cargado_mes: 10
      })),
      error: null
    });
    client.queue('report_daily_snapshots', 'select', {
      data: [
        {
          client_id: 'client-miriam',
          identity_id: 'identity-miriam',
          report_date: '2026-06-19',
          username: '3miriam776',
          cargado_hoy: 0,
          cargado_mes: 820000
        }
      ],
      error: null
    });
    client.queue('owner_financial_settings', 'select', {
      data: { commission_pct: 50 },
      error: null
    });
    client.queue('owner_marketing_daily_budgets', 'select', { data: [], error: null });

    const store = createMastercrmUserStore(client as unknown as SupabaseClient);
    const analytics = await store.getMarketingAnalytics({
      userId: 999,
      dateFrom: '2026-06-01',
      dateTo: '2026-06-19'
    });

    expect(analytics.clients).toContainEqual(
      expect.objectContaining({
        username: '3miriam776',
        channel: 'meta_ctwa',
        campaignKey: 'Reino Dorado',
        adKey: '120250708847350471',
        revenueArs: 820000
      })
    );
    expect(analytics.campaigns.find((campaign) => campaign.campaignName === 'Reino Dorado')).toMatchObject({
      leads: 1,
      assigned: 1,
      depositors: 1,
      revenueArs: 820000
    });
    expect(analytics.ads.find((ad) => ad.adKey === '120250708847350471')).toMatchObject({
      leads: 1,
      assigned: 1,
      depositors: 1,
      revenueArs: 820000
    });
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
    client.queue('owner_client_monthly_facts', 'select', {
      data: [
        {
          owner_id: 'owner-lucas',
          client_id: 'client-1',
          link_id: 'link-1',
          month_start: '2026-03-01',
          status_at_month_end: 'assigned',
          identity_id_at_month_end: 'identity-1',
          username_at_month_end: 'uno',
          had_intake_in_month: true,
          is_new_intake_in_month: true,
          is_reentry_in_month: false,
          had_assignment_in_month: true,
          assigned_from_backlog_in_month: false,
          clients: { id: 'client-1', phone_e164: '+5491111111111', pagina: 'ASN' }
        },
        {
          owner_id: 'owner-lucas',
          client_id: 'client-2',
          link_id: 'link-2',
          month_start: '2026-03-01',
          status_at_month_end: 'assigned',
          identity_id_at_month_end: 'identity-2',
          username_at_month_end: 'dos',
          had_intake_in_month: true,
          is_new_intake_in_month: false,
          is_reentry_in_month: true,
          had_assignment_in_month: false,
          assigned_from_backlog_in_month: false,
          clients: { id: 'client-2', phone_e164: '+5492222222222', pagina: 'ASN' }
        },
        {
          owner_id: 'owner-lucas',
          client_id: 'client-3',
          link_id: 'link-3',
          month_start: '2026-03-01',
          status_at_month_end: 'assigned',
          identity_id_at_month_end: 'identity-3',
          username_at_month_end: 'tres',
          had_intake_in_month: false,
          is_new_intake_in_month: false,
          is_reentry_in_month: false,
          had_assignment_in_month: true,
          assigned_from_backlog_in_month: true,
          clients: { id: 'client-3', phone_e164: '+5493333333333', pagina: 'ASN' }
        }
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
    client.queue('report_daily_snapshots', 'select', {
      data: [],
      error: null
    });
    client.queue('owner_client_links', 'select', {
      data: [
        { id: 'link-1', first_seen_at: '2026-03-01T10:00:00.000Z' },
        { id: 'link-2', first_seen_at: '2026-03-02T10:00:00.000Z' },
        { id: 'link-3', first_seen_at: '2026-03-03T10:00:00.000Z' }
      ],
      error: null
    });
    client.queue('owner_client_events', 'select', {
      data: [],
      error: null
    });

    const store = createMastercrmUserStore(client as unknown as SupabaseClient);
    const dashboard = await store.getClientsDashboard({ userId: 777, month: '2026-03' });

    expect(dashboard.statsKpis.intakesMes).toBe(1);
    expect(dashboard.statsKpis.reingresosMes).toBe(1);
    expect(dashboard.statsKpis.asignacionesMes).toBe(1);
    expect(dashboard.statsKpis.asignacionesBacklogMes).toBe(1);
    expect(dashboard.statsKpis.tasaIntakeAsignacionPct).toBe(100);
    expect(dashboard.statsKpis.clientesTotales).toBe(3);
    expect(dashboard.clientes.map((cliente) => cliente.id)).toEqual(['link-2', 'link-3', 'link-1']);
  });

  it('paginates dashboard report snapshots beyond Supabase default limits', async () => {
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
          owner_key: 'luqui10:luqui10',
          owner_label: 'Lucas10',
          pagina: 'RdA'
        }
      },
      error: null
    });
    client.queue('owner_aliases', 'select', { data: [], error: null });
    client.queue('owner_client_monthly_facts', 'select', {
      data: [
        {
          owner_id: 'owner-lucas',
          client_id: 'client-miriam',
          link_id: 'link-miriam',
          month_start: '2026-06-01',
          status_at_month_end: 'assigned',
          identity_id_at_month_end: 'identity-miriam',
          username_at_month_end: '3miriam776',
          had_intake_in_month: true,
          is_new_intake_in_month: true,
          is_reentry_in_month: false,
          had_assignment_in_month: true,
          assigned_from_backlog_in_month: false,
          clients: { id: 'client-miriam', phone_e164: '+5493510000776', pagina: 'RdA' }
        }
      ],
      error: null
    });
    client.queue('report_daily_snapshots', 'select', {
      data: [{ report_date: '2026-06-19' }],
      error: null
    });
    client.queue('owner_financial_settings', 'select', {
      data: { commission_pct: 50 },
      error: null
    });
    client.queue('owner_monthly_ad_spend', 'select', {
      data: null,
      error: null
    });
    client.queue('report_daily_snapshots', 'select', {
      data: Array.from({ length: SUPABASE_SELECT_PAGE_SIZE }, (_, index) => ({
        client_id: `other-client-${index}`
      })),
      error: null
    });
    client.queue('report_daily_snapshots', 'select', {
      data: [{ client_id: 'client-miriam' }],
      error: null
    });
    client.queue('report_daily_snapshots', 'select', {
      data: [],
      error: null
    });
    client.queue('owner_client_links', 'select', {
      data: [{ id: 'link-miriam', first_seen_at: '2026-06-18T16:36:21.000Z' }],
      error: null
    });
    client.queue('owner_client_events', 'select', {
      data: [],
      error: null
    });
    client.queue('report_daily_snapshots', 'select', {
      data: Array.from({ length: SUPABASE_SELECT_PAGE_SIZE }, (_, index) => ({
        client_id: `other-client-${index}`,
        identity_id: `other-identity-${index}`,
        report_date: '2026-06-19',
        username: `other${index}`,
        cargado_hoy: 0,
        cargado_mes: 10
      })),
      error: null
    });
    client.queue('report_daily_snapshots', 'select', {
      data: [
        {
          client_id: 'client-miriam',
          identity_id: 'identity-miriam',
          report_date: '2026-06-19',
          username: '3miriam776',
          cargado_hoy: 0,
          cargado_mes: 820000
        }
      ],
      error: null
    });
    client.queue('report_runs', 'select', {
      data: { finished_at: '2026-06-19T12:00:00.000Z' },
      error: null
    });

    const store = createMastercrmUserStore(client as unknown as SupabaseClient);
    const dashboard = await store.getClientsDashboard({ userId: 777, month: '2026-06' });

    expect(dashboard.statsKpis.clientesConReporte).toBe(1);
    expect(dashboard.statsKpis.cargadoMesArs).toBe(820000);
    expect(dashboard.clientes).toContainEqual(
      expect.objectContaining({
        id: 'link-miriam',
        username: '3miriam776',
        cargadoMes: 820000,
        reportDate: '2026-06-19'
      })
    );
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
    client.queue('owner_client_monthly_facts', 'select', {
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
    client.queue('report_daily_snapshots', 'select', {
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
