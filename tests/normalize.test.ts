import { describe, expect, it } from 'vitest';
import { normalizeApiResults } from '../src/normalize';

describe('normalizeApiResults', () => {
  it('expands array body into multiple records', () => {
    const records = normalizeApiResults([
      {
        endpoint: '/api/agent_admin/users',
        status: 200,
        ok: true,
        fetchedAt: '2026-02-20T00:00:00.000Z',
        body: [{ id: 1 }, { id: 2 }]
      }
    ]);

    expect(records).toHaveLength(2);
    expect(records[0]?.endpoint).toBe('/api/agent_admin/users');
  });

  it('handles object payloads with items key', () => {
    const records = normalizeApiResults([
      {
        endpoint: '/api/agent_admin/report',
        status: 200,
        ok: true,
        fetchedAt: '2026-02-20T00:00:00.000Z',
        body: { items: [{ id: 'a' }] }
      }
    ]);

    expect(records).toHaveLength(1);
    expect(records[0]?.payloadJson).toContain('"id":"a"');
  });
});
