import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { LandingContactOutboxStore } from '../src/landing-contact-outbox-store';

function createStore(insert: ReturnType<typeof vi.fn>) {
  const client = {
    from: vi.fn((table: string) => {
      expect(table).toBe('landing_contact_outbox');
      return { insert };
    })
  };

  return new LandingContactOutboxStore(client as unknown as SupabaseClient);
}

const input = {
  landingSessionId: 'session_123',
  eventId: 'contact:test',
  eventTime: '2026-08-26T18:00:00.000Z',
  sourcePayload: { Fbp: 'fb.1.1710000000000.111' }
};

describe('LandingContactOutboxStore', () => {
  it('treats the unique event ID conflict as an idempotent enqueue', async () => {
    const insert = vi
      .fn()
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: { code: '23505', message: 'duplicate key value' } });
    const store = createStore(insert);

    await expect(store.enqueueLandingContact(input)).resolves.toBeUndefined();
    await expect(store.enqueueLandingContact(input)).resolves.toBeUndefined();

    expect(insert).toHaveBeenCalledTimes(2);
    expect(insert.mock.calls[0][0]).toMatchObject({
      landing_session_id: 'session_123',
      event_id: 'contact:test',
      event_time: '2026-08-26T18:00:00.000Z',
      source_payload: input.sourcePayload,
      status: 'pending'
    });
  });

  it('surfaces non-idempotent persistence failures', async () => {
    const insert = vi.fn().mockResolvedValue({ error: { code: 'PGRST500', message: 'database unavailable' } });
    const store = createStore(insert);

    await expect(store.enqueueLandingContact(input)).rejects.toThrow(
      'Could not enqueue landing Contact: database unavailable'
    );
  });
});
