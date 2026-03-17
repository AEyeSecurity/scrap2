import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';
import type { MetaSourceContext, OwnerContext } from './types';
import { buildStoredMetaSourcePayload, normalizeMetaSourceContext } from './meta-source-context';

type MetaConversionsStoreErrorCode = 'CONFIGURATION' | 'VALIDATION' | 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL';

interface DatabaseErrorLike {
  code?: string | null;
  message: string;
}

export type MetaConversionStage = 'lead' | 'qualified_lead';
export type MetaConversionStatus = 'pending' | 'leased' | 'retry_wait' | 'sent' | 'failed';

export interface EnqueueMetaLeadInput {
  ownerId: string;
  clientId: string;
  phoneE164: string;
  ownerContext: Pick<OwnerContext, 'ownerKey' | 'ownerLabel'>;
  sourceContext: MetaSourceContext;
  eventTime?: string;
}

export interface MetaConversionLease {
  id: string;
  ownerId: string;
  clientId: string;
  eventStage: MetaConversionStage;
  metaEventName: 'Lead' | 'CompleteRegistration';
  eventId: string;
  eventTime: string;
  phoneE164: string | null;
  username: string | null;
  sourcePayload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

export interface MetaConversionsStore {
  enqueueLead(input: EnqueueMetaLeadInput): Promise<void>;
  scanForQualifiedLeads(limit: number): Promise<number>;
  leaseNextEvent(leaseSeconds: number, maxAttempts: number): Promise<MetaConversionLease | null>;
  markSent(id: string): Promise<void>;
  markRetry(id: string, error: string, retryAfterSeconds: number): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
}

export class MetaConversionsStoreError extends Error {
  constructor(
    public readonly code: MetaConversionsStoreErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'MetaConversionsStoreError';
  }
}

type MetaOutboxLeaseRow = {
  id: string;
  owner_id: string;
  client_id: string;
  event_stage: MetaConversionStage;
  meta_event_name: 'Lead' | 'CompleteRegistration';
  event_id: string;
  event_time: string;
  phone_e164: string | null;
  username: string | null;
  source_payload: Record<string, unknown> | null;
  attempts: number;
  max_attempts: number;
};

function normalizeUuid(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new MetaConversionsStoreError('VALIDATION', `${label} is required`);
  }

  return normalized;
}

function normalizeEventTime(value: string | undefined): string {
  if (!value) {
    return new Date().toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new MetaConversionsStoreError('VALIDATION', 'eventTime must be a valid ISO timestamp');
  }

  return parsed.toISOString();
}

function buildStableEventId(stage: MetaConversionStage, ownerId: string, clientId: string): string {
  const seed = `${stage}:${ownerId}:${clientId}`.toLowerCase();
  return `${stage}:${Buffer.from(seed).toString('base64url')}`;
}

function mapDatabaseError(error: DatabaseErrorLike, fallbackMessage: string): MetaConversionsStoreError {
  const code = error.code ?? '';
  if (code === '23505') {
    return new MetaConversionsStoreError('CONFLICT', fallbackMessage);
  }
  if (code === '23503' || code === 'PGRST116') {
    return new MetaConversionsStoreError('NOT_FOUND', fallbackMessage);
  }
  if (code === '23514' || code === '22023' || code === '22P02') {
    return new MetaConversionsStoreError('VALIDATION', fallbackMessage);
  }

  const detail = code ? `${fallbackMessage} (${code}: ${error.message})` : `${fallbackMessage}: ${error.message}`;
  return new MetaConversionsStoreError('INTERNAL', detail);
}

function mapPostgrestError(error: PostgrestError, fallbackMessage: string): MetaConversionsStoreError {
  return mapDatabaseError({ code: error.code, message: error.message }, fallbackMessage);
}

function asLease(row: MetaOutboxLeaseRow): MetaConversionLease {
  return {
    id: row.id,
    ownerId: row.owner_id,
    clientId: row.client_id,
    eventStage: row.event_stage,
    metaEventName: row.meta_event_name,
    eventId: row.event_id,
    eventTime: row.event_time,
    phoneE164: row.phone_e164,
    username: row.username,
    sourcePayload: row.source_payload ?? {},
    attempts: row.attempts,
    maxAttempts: row.max_attempts
  };
}

export class SupabaseMetaConversionsStore implements MetaConversionsStore {
  constructor(private readonly client: SupabaseClient) {}

  async enqueueLead(input: EnqueueMetaLeadInput): Promise<void> {
    const ownerId = normalizeUuid(input.ownerId, 'ownerId');
    const clientId = normalizeUuid(input.clientId, 'clientId');
    const phoneE164 = input.phoneE164.trim();
    if (!phoneE164) {
      throw new MetaConversionsStoreError('VALIDATION', 'phoneE164 is required');
    }

    const normalizedSource = normalizeMetaSourceContext(input.sourceContext);
    if (!normalizedSource) {
      throw new MetaConversionsStoreError('VALIDATION', 'sourceContext is required');
    }

    const { error } = await this.client.from('meta_conversion_outbox').upsert(
      {
        owner_id: ownerId,
        client_id: clientId,
        event_stage: 'lead',
        meta_event_name: 'Lead',
        event_id: buildStableEventId('lead', ownerId, clientId),
        status: 'pending',
        event_time: normalizeEventTime(input.eventTime),
        phone_e164: phoneE164,
        username: null,
        source_payload: buildStoredMetaSourcePayload({
          ownerContext: input.ownerContext,
          sourceContext: normalizedSource
        })
      },
      {
        onConflict: 'owner_id,client_id,event_stage',
        ignoreDuplicates: true
      }
    );

    if (error) {
      throw mapPostgrestError(error, 'Could not enqueue Meta lead conversion');
    }
  }

  async scanForQualifiedLeads(limit: number): Promise<number> {
    const { data, error } = await this.client.rpc('enqueue_meta_qualified_leads', {
      p_limit: Math.max(1, Math.trunc(limit))
    });

    if (error) {
      throw mapPostgrestError(error, 'Could not enqueue qualified Meta leads');
    }

    return Number(data ?? 0);
  }

  async leaseNextEvent(leaseSeconds: number, maxAttempts: number): Promise<MetaConversionLease | null> {
    const { data, error } = await this.client.rpc('claim_next_meta_conversion_outbox', {
      p_lease_seconds: Math.max(1, Math.trunc(leaseSeconds)),
      p_max_attempts: Math.max(1, Math.trunc(maxAttempts))
    });

    if (error) {
      throw mapPostgrestError(error, 'Could not claim Meta conversion outbox item');
    }

    const rows = Array.isArray(data) ? data : data ? [data] : [];
    if (rows.length === 0) {
      return null;
    }

    return asLease(rows[0] as MetaOutboxLeaseRow);
  }

  async markSent(id: string): Promise<void> {
    const { error } = await this.client
      .from('meta_conversion_outbox')
      .update({
        status: 'sent',
        sent_at: new Date().toISOString(),
        lease_until: null,
        next_retry_at: null,
        last_error: null
      })
      .eq('id', normalizeUuid(id, 'id'));

    if (error) {
      throw mapPostgrestError(error, 'Could not mark Meta conversion as sent');
    }
  }

  async markRetry(id: string, errorMessage: string, retryAfterSeconds: number): Promise<void> {
    const nextRetryAt = new Date(Date.now() + Math.max(1, retryAfterSeconds) * 1000).toISOString();
    const { error } = await this.client
      .from('meta_conversion_outbox')
      .update({
        status: 'retry_wait',
        lease_until: null,
        next_retry_at: nextRetryAt,
        last_error: errorMessage
      })
      .eq('id', normalizeUuid(id, 'id'));

    if (error) {
      throw mapPostgrestError(error, 'Could not mark Meta conversion for retry');
    }
  }

  async markFailed(id: string, errorMessage: string): Promise<void> {
    const { error } = await this.client
      .from('meta_conversion_outbox')
      .update({
        status: 'failed',
        lease_until: null,
        next_retry_at: null,
        last_error: errorMessage
      })
      .eq('id', normalizeUuid(id, 'id'));

    if (error) {
      throw mapPostgrestError(error, 'Could not mark Meta conversion as failed');
    }
  }
}

export function createMetaConversionsStoreFromEnv(env: NodeJS.ProcessEnv = process.env): MetaConversionsStore {
  const url = env.SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url || !serviceRoleKey) {
    throw new MetaConversionsStoreError(
      'CONFIGURATION',
      'Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'
    );
  }

  if (serviceRoleKey.startsWith('sb_publishable_')) {
    throw new MetaConversionsStoreError(
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

  return new SupabaseMetaConversionsStore(client);
}
