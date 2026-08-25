import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  EnqueueMetaLeadInput,
  MetaConversionLease,
  MetaConversionsStore,
  MetaDispatchPersistenceInput,
  MetaFailurePersistenceInput,
  MetaRetryPersistenceInput,
  MetaValueSignalScanOptions
} from './meta-conversions-store';

export interface EnqueueLandingContactInput {
  landingSessionId: string;
  eventId: string;
  eventTime: string;
  sourcePayload: Record<string, unknown>;
}

type Row = {
  id: string; landing_session_id: string; event_id: string; event_time: string;
  source_payload: Record<string, unknown>; attempts: number; max_attempts: number;
};

function lease(row: Row): MetaConversionLease {
  return {
    id: row.id, ownerId: 'central:rls', clientId: row.landing_session_id,
    eventStage: 'landing_contact', metaEventName: 'Contact', eventId: row.event_id,
    eventTime: row.event_time, phoneE164: null, username: null,
    sourcePayload: row.source_payload ?? {}, attempts: row.attempts, maxAttempts: row.max_attempts
  };
}

export class LandingContactOutboxStore implements MetaConversionsStore {
  constructor(private readonly client: SupabaseClient) {}

  async enqueueLandingContact(input: EnqueueLandingContactInput): Promise<void> {
    const { error } = await this.client.from('landing_contact_outbox').insert({
      id: randomUUID(), landing_session_id: input.landingSessionId, event_id: input.eventId,
      event_time: input.eventTime, source_payload: input.sourcePayload, status: 'pending'
    });
    if (error && error.code !== '23505') { throw new Error(`Could not enqueue landing Contact: ${error.message}`); }
  }

  async enqueueLead(_input: EnqueueMetaLeadInput): Promise<void> { throw new Error('Landing Contact outbox only'); }
  async enqueueLandingLead(_input: EnqueueMetaLeadInput): Promise<void> { throw new Error('Landing Contact outbox only'); }
  async scanForValueSignals(_limit: number, _options?: MetaValueSignalScanOptions): Promise<number> { return 0; }

  async leaseNextEvent(leaseSeconds: number, maxAttempts: number): Promise<MetaConversionLease | null> {
    const { data, error } = await this.client.rpc('claim_next_landing_contact_outbox', {
      p_lease_seconds: leaseSeconds, p_max_attempts: maxAttempts
    });
    if (error) { throw new Error(`Could not lease landing Contact: ${error.message}`); }
    const row = Array.isArray(data) ? data[0] : null;
    return row ? lease(row as Row) : null;
  }

  async markSent(input: MetaDispatchPersistenceInput): Promise<void> {
    const { error } = await this.client.from('landing_contact_outbox').update({
      status: 'sent', sent_at: new Date().toISOString(), lease_until: null,
      request_payload: input.requestPayload ?? null, response_status: input.responseStatus ?? null,
      response_body: input.responseBody ?? null, fbtrace_id: input.fbtraceId ?? null, last_error: null
    }).eq('id', input.id);
    if (error) { throw new Error(`Could not mark landing Contact sent: ${error.message}`); }
  }

  async markRetry(input: MetaRetryPersistenceInput): Promise<void> {
    const { error } = await this.client.from('landing_contact_outbox').update({
      status: 'retry_wait', lease_until: null, next_retry_at: new Date(Date.now() + input.retryAfterSeconds * 1000).toISOString(),
      last_error: input.error, request_payload: input.requestPayload ?? null, response_status: input.responseStatus ?? null,
      response_body: input.responseBody ?? null, fbtrace_id: input.fbtraceId ?? null
    }).eq('id', input.id);
    if (error) { throw new Error(`Could not retry landing Contact: ${error.message}`); }
  }

  async markFailed(input: MetaFailurePersistenceInput): Promise<void> {
    const { error } = await this.client.from('landing_contact_outbox').update({
      status: 'failed', lease_until: null, failed_at: new Date().toISOString(), last_error: input.error,
      request_payload: input.requestPayload ?? null, response_status: input.responseStatus ?? null,
      response_body: input.responseBody ?? null, fbtrace_id: input.fbtraceId ?? null
    }).eq('id', input.id);
    if (error) { throw new Error(`Could not fail landing Contact: ${error.message}`); }
  }
}

export function createLandingContactOutboxStoreFromEnv(env: NodeJS.ProcessEnv = process.env): LandingContactOutboxStore {
  const url = env.SUPABASE_URL?.trim(); const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key || key.startsWith('sb_publishable_')) { throw new Error('Supabase service role is required for landing Contact outbox'); }
  return new LandingContactOutboxStore(createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }));
}
