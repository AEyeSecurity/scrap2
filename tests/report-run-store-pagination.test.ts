import { describe, expect, it } from 'vitest';
import { SupabaseReportRunStore } from '../src/report-run-store';

function reportItemRow(index: number) {
  const timestamp = '2026-08-08T18:00:00.000Z';
  return {
    id: `item-${index}`,
    run_id: 'run-1',
    owner_id: 'owner-1',
    identity_id: `identity-${index}`,
    client_id: `client-${index}`,
    link_id: `link-${index}`,
    username: `user-${index}`,
    owner_key: 'asnlucas10:lucas10',
    owner_label: 'Lucas10',
    status: 'done',
    attempts: 1,
    max_attempts: 3,
    lease_until: null,
    next_retry_at: null,
    started_at: timestamp,
    finished_at: timestamp,
    last_error: null,
    cargado_hoy: null,
    cargado_mes: '0.00',
    raw_result: {},
    created_at: timestamp,
    updated_at: timestamp
  };
}

describe('SupabaseReportRunStore item pagination', () => {
  it('joins database pages when a run contains more than the PostgREST row cap', async () => {
    const rows = Array.from({ length: 1413 }, (_, index) => reportItemRow(index));
    const ranges: Array<[number, number]> = [];
    const builder = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      range: async (from: number, to: number) => {
        ranges.push([from, to]);
        return { data: rows.slice(from, to + 1), error: null, count: rows.length };
      }
    };
    const client = { from: () => builder };
    const store = new SupabaseReportRunStore(client as never);

    const page = await store.listRunItems('run-1', 5000, 0);

    expect(page.total).toBe(1413);
    expect(page.items).toHaveLength(1413);
    expect(page.items.at(-1)?.username).toBe('user-1412');
    expect(ranges).toEqual([
      [0, 999],
      [1000, 1999]
    ]);
  });
});
