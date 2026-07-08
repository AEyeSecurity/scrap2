import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';
import { normalizeMastercrmOwnerKey } from './mastercrm-user-store';
import { normalizePhone } from './player-phone-store';
import type { OwnerContext, PaginaCode } from './types';

export type WhatsappQrStatus = 'idle' | 'waiting_qr' | 'connected' | 'disconnected' | 'error';
export type WhatsappQrDirection = 'inbound' | 'outbound' | 'contact_sync';
export type WhatsappQrMatchSource = 'contact_name' | 'outbound_message';
export type WhatsappQrMatchStatus = 'candidate' | 'validated' | 'assigned' | 'not_found' | 'conflict' | 'error';
export type WhatsappQrRecheckReason =
  | 'outbound_candidate'
  | 'contact_seen'
  | 'technical_error'
  | 'first_load'
  | 'manual'
  | 'backfill_no_signal';
export type WhatsappQrRecheckStatus = 'pending' | 'done' | 'expired';
export type WhatsappQrBackfillRunStatus = 'running' | 'completed' | 'failed';

export interface WhatsappQrOwner {
  ownerId: string;
  ownerKey: string;
  ownerLabel: string;
  pagina: PaginaCode;
  telefono?: string | null;
}

export interface WhatsappQrSessionRecord {
  id: string;
  ownerId: string;
  ownerKey: string;
  ownerLabel: string;
  pagina: PaginaCode;
  status: WhatsappQrStatus;
  runtimeSessionId: string;
  phoneE164: string | null;
  qrPayload: string | null;
  qrDataUrl: string | null;
  qrExpiresAt: string | null;
  lastHeartbeatAt: string | null;
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
  lastError: string | null;
  botGroupKey: string | null;
  createdAt: string;
  updatedAt: string;
  hasRdaCredentials?: boolean;
}

export interface WhatsappQrMessageRecord {
  id: string;
  sessionId: string;
  ownerId: string;
  direction: WhatsappQrDirection;
  clientPhoneE164: string;
  contactName: string | null;
  pushName: string | null;
  textExcerpt: string | null;
  candidateUsername: string | null;
  matchSource: WhatsappQrMatchSource | null;
  messageTimestamp: string | null;
  createdAt: string;
}

export interface WhatsappQrMatchRecord {
  id: string;
  sessionId: string;
  ownerId: string;
  messageId: string | null;
  pagina: 'RdA';
  clientPhoneE164: string;
  username: string;
  source: WhatsappQrMatchSource;
  status: WhatsappQrMatchStatus;
  rdaValidatedAt: string | null;
  assignedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WhatsappQrMonthClientRecord {
  clientId: string;
  linkId: string | null;
  phoneE164: string;
  assignedUsername: string | null;
}

export interface WhatsappQrRdaCredential {
  ownerId: string;
  ownerKey: string;
  pagina: 'RdA';
  loginUsername: string;
  loginPassword: string;
  source: string;
  sourceRef: string | null;
  syncedAt: string;
}

export interface WhatsappQrContactRecord {
  id: string;
  ownerId: string;
  sessionId: string | null;
  phoneE164: string;
  contactName: string | null;
  notify: string | null;
  username: string | null;
  verifiedName: string | null;
  firstMessageAt: string | null;
  firstMessageDirection: 'inbound' | 'outbound' | null;
  intakeRecordedAt: string | null;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface WhatsappQrChatState {
  firstMessageAt: string;
  firstMessageDirection: 'inbound' | 'outbound';
  intakeRecordedAt: string | null;
}

export interface WhatsappQrRecheckQueueRecord {
  id: string;
  ownerId: string;
  sessionId: string | null;
  monthStart: string;
  phoneE164: string;
  reason: WhatsappQrRecheckReason;
  status: WhatsappQrRecheckStatus;
  attempts: number;
  nextRunAt: string;
  expiresAt: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WhatsappQrBackfillRunRecord {
  id: string;
  ownerId: string;
  sessionId: string | null;
  monthStart: string;
  triggerSource: string;
  status: WhatsappQrBackfillRunStatus;
  startedAt: string;
  finishedAt: string | null;
  lastCompletedAt: string | null;
  lastError: string | null;
  summaryJson: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertWhatsappQrSessionPatch {
  status?: WhatsappQrStatus;
  phoneE164?: string | null;
  qrPayload?: string | null;
  qrDataUrl?: string | null;
  qrExpiresAt?: string | null;
  lastHeartbeatAt?: string | null;
  lastConnectedAt?: string | null;
  lastDisconnectedAt?: string | null;
  lastError?: string | null;
  botGroupKey?: string | null;
  disconnectedAlertedAt?: string | null;
  qrAlertedAt?: string | null;
  heartbeatAlertedAt?: string | null;
}

export interface RecordWhatsappQrMessageInput {
  sessionId: string;
  ownerId: string;
  direction: WhatsappQrDirection;
  remoteJid?: string | null;
  messageId?: string | null;
  clientPhoneE164: string;
  contactName?: string | null;
  pushName?: string | null;
  textExcerpt?: string | null;
  candidateUsername?: string | null;
  matchSource?: WhatsappQrMatchSource | null;
  messageTimestamp?: string | null;
}

export interface CreateWhatsappQrMatchInput {
  sessionId: string;
  ownerId: string;
  messageId?: string | null;
  clientPhoneE164: string;
  username: string;
  source: WhatsappQrMatchSource;
  status?: WhatsappQrMatchStatus;
  errorMessage?: string | null;
}

export interface WhatsappQrStore {
  resolveOwnerByKey(pagina: PaginaCode, ownerKey: string): Promise<WhatsappQrOwner | null>;
  listOwnerClientPhonesForMonth(input: { ownerId: string; monthStart: string; limit?: number }): Promise<Set<string>>;
  listMonthClients(input: { ownerId: string; monthStart: string; limit?: number }): Promise<WhatsappQrMonthClientRecord[]>;
  listIgnoredPhonesForMonth(input: { ownerId: string; monthStart: string }): Promise<Set<string>>;
  getSessionByOwner(ownerId: string): Promise<WhatsappQrSessionRecord | null>;
  listReconnectableSessions(): Promise<WhatsappQrSessionRecord[]>;
  listSessions(ownerIds?: string[] | null): Promise<WhatsappQrSessionRecord[]>;
  upsertSession(owner: WhatsappQrOwner, patch?: UpsertWhatsappQrSessionPatch): Promise<WhatsappQrSessionRecord>;
  updateSession(id: string, patch: UpsertWhatsappQrSessionPatch): Promise<WhatsappQrSessionRecord>;
  listStaleSessions(input: { heartbeatBefore: string; qrExpiredBefore: string }): Promise<WhatsappQrSessionRecord[]>;
  markAlerted(sessionId: string, kind: 'disconnected' | 'qr' | 'heartbeat', alertedAt: string): Promise<void>;
  recordMessage(input: RecordWhatsappQrMessageInput): Promise<WhatsappQrMessageRecord>;
  upsertContact(input: {
    sessionId?: string | null;
    ownerId: string;
    phoneE164: string;
    contactName?: string | null;
    notify?: string | null;
    username?: string | null;
    verifiedName?: string | null;
    seenAt?: string;
  }): Promise<WhatsappQrContactRecord>;
  recordChatMessage(input: {
    ownerId: string;
    phoneE164: string;
    messageAt: string;
    direction: 'inbound' | 'outbound';
  }): Promise<WhatsappQrChatState>;
  markIntakeRecorded(input: { ownerId: string; phoneE164: string }): Promise<string | null>;
  createMatch(input: CreateWhatsappQrMatchInput): Promise<WhatsappQrMatchRecord>;
  updateMatch(
    id: string,
    patch: {
      status: WhatsappQrMatchStatus;
      rdaValidatedAt?: string | null;
      assignedAt?: string | null;
      errorMessage?: string | null;
    }
  ): Promise<WhatsappQrMatchRecord>;
  listMatches(ownerIds?: string[] | null, limit?: number): Promise<WhatsappQrMatchRecord[]>;
  listMessagesForMonth(input: { ownerId: string; createdFrom: string; createdTo: string; limit?: number }): Promise<WhatsappQrMessageRecord[]>;
  listMatchesForMonth(input: { ownerId: string; createdFrom: string; createdTo: string; limit?: number }): Promise<WhatsappQrMatchRecord[]>;
  listContactsByPhones(input: { ownerId: string; phoneE164s: string[] }): Promise<WhatsappQrContactRecord[]>;
  getLatestBackfillRun(input: { ownerId: string; monthStart: string }): Promise<WhatsappQrBackfillRunRecord | null>;
  createBackfillRun(input: {
    ownerId: string;
    sessionId?: string | null;
    monthStart: string;
    triggerSource: string;
    startedAt?: string;
  }): Promise<WhatsappQrBackfillRunRecord>;
  updateBackfillRun(
    id: string,
    patch: {
      status?: WhatsappQrBackfillRunStatus;
      finishedAt?: string | null;
      lastCompletedAt?: string | null;
      lastError?: string | null;
      summaryJson?: Record<string, unknown> | null;
    }
  ): Promise<WhatsappQrBackfillRunRecord>;
  enqueueRecheck(input: {
    ownerId: string;
    sessionId?: string | null;
    monthStart: string;
    phoneE164: string;
    reason: WhatsappQrRecheckReason;
    nextRunAt?: string;
    expiresAt?: string;
  }): Promise<WhatsappQrRecheckQueueRecord>;
  listDueRechecks(input: { nowIso: string; limit: number }): Promise<WhatsappQrRecheckQueueRecord[]>;
  updateRecheck(
    id: string,
    patch: {
      status?: WhatsappQrRecheckStatus;
      attempts?: number;
      nextRunAt?: string;
      expiresAt?: string;
      lastError?: string | null;
    }
  ): Promise<WhatsappQrRecheckQueueRecord>;
  ignorePhoneForMonth(input: {
    ownerId: string;
    monthStart: string;
    phoneE164: string;
    ignoredByUserId?: number | null;
  }): Promise<void>;
  getRdaCredential(ownerId: string): Promise<WhatsappQrRdaCredential | null>;
  upsertRdaCredential(input: {
    ownerId: string;
    ownerKey: string;
    loginUsername: string;
    loginPassword: string;
    source?: string;
    sourceRef?: string | null;
    syncedAt?: string;
  }): Promise<WhatsappQrRdaCredential>;
  listCredentialOwnerIds(ownerIds?: string[] | null): Promise<Set<string>>;
}

type WhatsappQrStoreErrorCode = 'CONFIGURATION' | 'VALIDATION' | 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL';

export class WhatsappQrStoreError extends Error {
  constructor(
    public readonly code: WhatsappQrStoreErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'WhatsappQrStoreError';
  }
}

function mapPostgrestError(error: PostgrestError, fallbackMessage: string): WhatsappQrStoreError {
  if (error.code === '23505') {
    return new WhatsappQrStoreError('CONFLICT', fallbackMessage, { cause: error });
  }
  if (error.code === '23503' || error.code === '23514' || error.code === '22P02') {
    return new WhatsappQrStoreError('VALIDATION', fallbackMessage, { cause: error });
  }
  if (error.code === 'PGRST116') {
    return new WhatsappQrStoreError('NOT_FOUND', fallbackMessage, { cause: error });
  }

  return new WhatsappQrStoreError('INTERNAL', fallbackMessage, { cause: error });
}

function runtimeSessionId(owner: WhatsappQrOwner): string {
  return `${owner.pagina}-${owner.ownerKey}`.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asPagina(value: unknown): PaginaCode {
  return value === 'ASN' ? 'ASN' : 'RdA';
}

function asSession(row: any): WhatsappQrSessionRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    ownerKey: row.owner_key,
    ownerLabel: row.owner_label,
    pagina: asPagina(row.pagina),
    status: row.status,
    runtimeSessionId: row.runtime_session_id,
    phoneE164: row.phone_e164 ?? null,
    qrPayload: row.qr_payload ?? null,
    qrDataUrl: row.qr_data_url ?? null,
    qrExpiresAt: row.qr_expires_at ?? null,
    lastHeartbeatAt: row.last_heartbeat_at ?? null,
    lastConnectedAt: row.last_connected_at ?? null,
    lastDisconnectedAt: row.last_disconnected_at ?? null,
    lastError: row.last_error ?? null,
    botGroupKey: row.bot_group_key ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function asMessage(row: any): WhatsappQrMessageRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    ownerId: row.owner_id,
    direction: row.direction,
    clientPhoneE164: row.client_phone_e164,
    contactName: row.contact_name ?? null,
    pushName: row.push_name ?? null,
    textExcerpt: row.text_excerpt ?? null,
    candidateUsername: row.candidate_username ?? null,
    matchSource: row.match_source ?? null,
    messageTimestamp: row.message_timestamp ?? null,
    createdAt: row.created_at
  };
}

function asMatch(row: any): WhatsappQrMatchRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    ownerId: row.owner_id,
    messageId: row.message_id ?? null,
    pagina: 'RdA',
    clientPhoneE164: row.client_phone_e164,
    username: row.username,
    source: row.source,
    status: row.status,
    rdaValidatedAt: row.rda_validated_at ?? null,
    assignedAt: row.assigned_at ?? null,
    errorMessage: row.error_message ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function asContact(row: any): WhatsappQrContactRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    sessionId: row.session_id ?? null,
    phoneE164: row.phone_e164,
    contactName: row.contact_name ?? null,
    notify: row.notify ?? null,
    username: row.username ?? null,
    verifiedName: row.verified_name ?? null,
    firstMessageAt: row.first_message_at ?? null,
    firstMessageDirection: row.first_message_direction ?? null,
    intakeRecordedAt: row.intake_recorded_at ?? null,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function asRecheck(row: any): WhatsappQrRecheckQueueRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    sessionId: row.session_id ?? null,
    monthStart: row.month_start,
    phoneE164: row.phone_e164,
    reason: row.reason,
    status: row.status,
    attempts: Number(row.attempts ?? 0),
    nextRunAt: row.next_run_at,
    expiresAt: row.expires_at,
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function asBackfillRun(row: any): WhatsappQrBackfillRunRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    sessionId: row.session_id ?? null,
    monthStart: row.month_start,
    triggerSource: row.trigger_source,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? null,
    lastCompletedAt: row.last_completed_at ?? null,
    lastError: row.last_error ?? null,
    summaryJson:
      row.summary_json && typeof row.summary_json === 'object' && !Array.isArray(row.summary_json) ? row.summary_json : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function asCredential(row: any): WhatsappQrRdaCredential {
  return {
    ownerId: row.owner_id,
    ownerKey: row.owner_key,
    pagina: 'RdA',
    loginUsername: row.login_username,
    loginPassword: row.login_password,
    source: row.source,
    sourceRef: row.source_ref ?? null,
    syncedAt: row.synced_at
  };
}

function asOwner(row: any): WhatsappQrOwner {
  return {
    ownerId: row.id,
    ownerKey: row.owner_key,
    ownerLabel: row.owner_label,
    pagina: asPagina(row.pagina)
  };
}

function sessionPatchToRow(patch: UpsertWhatsappQrSessionPatch): Record<string, unknown> {
  return {
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.phoneE164 !== undefined ? { phone_e164: patch.phoneE164 ? normalizePhone(patch.phoneE164) : null } : {}),
    ...(patch.qrPayload !== undefined ? { qr_payload: nullableText(patch.qrPayload) } : {}),
    ...(patch.qrDataUrl !== undefined ? { qr_data_url: nullableText(patch.qrDataUrl) } : {}),
    ...(patch.qrExpiresAt !== undefined ? { qr_expires_at: patch.qrExpiresAt } : {}),
    ...(patch.lastHeartbeatAt !== undefined ? { last_heartbeat_at: patch.lastHeartbeatAt } : {}),
    ...(patch.lastConnectedAt !== undefined ? { last_connected_at: patch.lastConnectedAt } : {}),
    ...(patch.lastDisconnectedAt !== undefined ? { last_disconnected_at: patch.lastDisconnectedAt } : {}),
    ...(patch.lastError !== undefined ? { last_error: nullableText(patch.lastError) } : {}),
    ...(patch.botGroupKey !== undefined ? { bot_group_key: nullableText(patch.botGroupKey) } : {}),
    ...(patch.disconnectedAlertedAt !== undefined ? { disconnected_alerted_at: patch.disconnectedAlertedAt } : {}),
    ...(patch.qrAlertedAt !== undefined ? { qr_alerted_at: patch.qrAlertedAt } : {}),
    ...(patch.heartbeatAlertedAt !== undefined ? { heartbeat_alerted_at: patch.heartbeatAlertedAt } : {}),
    updated_at: new Date().toISOString()
  };
}

function chunkValues<T>(values: T[], size = 500): T[][] {
  if (values.length === 0) {
    return [];
  }

  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

const SUPABASE_QR_PAGE_SIZE = 1000;

async function selectAllSupabasePages<Row>(
  buildQuery: () => { range(from: number, to: number): PromiseLike<{ data: Row[] | null; error: PostgrestError | null }> },
  fallbackMessage: string
): Promise<Row[]> {
  const rows: Row[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await buildQuery().range(offset, offset + SUPABASE_QR_PAGE_SIZE - 1);
    if (error) {
      throw mapPostgrestError(error, fallbackMessage);
    }

    const page = data ?? [];
    rows.push(...page);
    if (page.length < SUPABASE_QR_PAGE_SIZE) {
      return rows;
    }

    offset += SUPABASE_QR_PAGE_SIZE;
  }
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function sanitizeWhatsappQrSessionForHttp(session: WhatsappQrSessionRecord): Omit<WhatsappQrSessionRecord, 'qrPayload'> {
  const { qrPayload: _qrPayload, ...safeSession } = session;
  return safeSession;
}

export function ownerContextFromWhatsappQrOwner(owner: WhatsappQrOwner, actorPhone?: string | null): OwnerContext {
  return {
    ownerKey: owner.ownerKey,
    ownerLabel: owner.ownerLabel,
    actorAlias: owner.ownerLabel,
    actorPhone: actorPhone ?? owner.telefono ?? null
  };
}

class SupabaseWhatsappQrStore implements WhatsappQrStore {
  constructor(private readonly client: SupabaseClient) {}

  async resolveOwnerByKey(pagina: PaginaCode, ownerKey: string): Promise<WhatsappQrOwner | null> {
    const { data, error } = await this.client
      .from('owners')
      .select('id, owner_key, owner_label, pagina')
      .eq('pagina', pagina)
      .eq('owner_key', normalizeMastercrmOwnerKey(ownerKey))
      .maybeSingle();

    if (error) {
      throw mapPostgrestError(error, 'Could not resolve cashier owner');
    }

    return data ? asOwner(data) : null;
  }

  async listOwnerClientPhonesForMonth(input: { ownerId: string; monthStart: string; limit?: number }): Promise<Set<string>> {
    const data = await selectAllSupabasePages<Array<{ clients?: { phone_e164?: string | null } | { phone_e164?: string | null }[] }>[number]>(
      () => {
        let query = this.client
          .from('owner_client_monthly_facts')
          .select('client_id, clients!inner(phone_e164)')
          .eq('owner_id', input.ownerId)
          .eq('month_start', input.monthStart)
          .eq('is_new_intake_in_month', true)
          .order('client_id', { ascending: true });
        if (input.limit) {
          query = query.limit(input.limit);
        }
        return query;
      },
      'Could not read owner monthly client phones'
    );

    const phones = new Set<string>();
    for (const row of data) {
      const client = Array.isArray(row.clients) ? row.clients[0] : row.clients;
      if (client?.phone_e164) {
        phones.add(normalizePhone(client.phone_e164));
      }
    }

    return phones;
  }

  async listMonthClients(input: { ownerId: string; monthStart: string; limit?: number }): Promise<WhatsappQrMonthClientRecord[]> {
    const data = await selectAllSupabasePages<{
      client_id?: string | null;
      link_id?: string | null;
      clients?: { phone_e164?: string | null } | { phone_e164?: string | null }[];
    }>(
      () => {
        let query = this.client
          .from('owner_client_monthly_facts')
          .select('client_id, link_id, clients!inner(phone_e164)')
          .eq('owner_id', input.ownerId)
          .eq('month_start', input.monthStart)
          .eq('is_new_intake_in_month', true)
          .order('client_id', { ascending: true });
        if (input.limit) {
          query = query.limit(input.limit);
        }
        return query;
      },
      'Could not read owner monthly client queue'
    );

    const monthClients: WhatsappQrMonthClientRecord[] = [];
    for (const row of data) {
      const client = Array.isArray(row.clients) ? row.clients[0] : row.clients;
      const phone = client?.phone_e164 ? normalizePhone(client.phone_e164) : null;
      if (!row.client_id || !phone) {
        continue;
      }

      monthClients.push({
        clientId: row.client_id,
        linkId: typeof row.link_id === 'string' && row.link_id.length > 0 ? row.link_id : null,
        phoneE164: phone,
        assignedUsername: null
      });
    }

    const linkIds = [...new Set(monthClients.map((row) => row.linkId).filter((linkId): linkId is string => Boolean(linkId)))];
    if (linkIds.length === 0) {
      return monthClients;
    }

    const activeIdentityByLinkId = new Map<string, string>();
    // Supabase serializes `.in(...)` filters into the request URL; large UUID batches can overflow header limits.
    for (const chunk of chunkValues(linkIds, 100)) {
      const { data: identityData, error: identityError } = await this.client
        .from('owner_client_identities')
        .select('owner_client_link_id, username')
        .eq('is_active', true)
        .in('owner_client_link_id', chunk);

      if (identityError) {
        throw mapPostgrestError(identityError, 'Could not read owner monthly client identities');
      }

      for (const row of (identityData as Array<{ owner_client_link_id?: string | null; username?: string | null }> | null) ?? []) {
        if (row.owner_client_link_id && row.username) {
          activeIdentityByLinkId.set(row.owner_client_link_id, row.username);
        }
      }
    }

    return monthClients.map((row) => ({
      clientId: row.clientId,
      linkId: row.linkId,
      phoneE164: row.phoneE164,
      assignedUsername: row.linkId ? activeIdentityByLinkId.get(row.linkId) ?? null : null
    }));
  }

  async listIgnoredPhonesForMonth(input: { ownerId: string; monthStart: string }): Promise<Set<string>> {
    const data = await selectAllSupabasePages<{ client_phone_e164?: string | null }>(
      () =>
        this.client
          .from('mastercrm_whatsapp_qr_ignored_phones')
          .select('client_phone_e164')
          .eq('owner_id', input.ownerId)
          .eq('month_start', input.monthStart)
          .order('created_at', { ascending: true }),
      'Could not list ignored WhatsApp QR phones for month'
    );

    return new Set(
      (data
        .map((row) => row.client_phone_e164)
        .filter(Boolean) as string[]).map((phone) => normalizePhone(phone))
    );
  }

  async getSessionByOwner(ownerId: string): Promise<WhatsappQrSessionRecord | null> {
    const { data, error } = await this.client
      .from('mastercrm_whatsapp_qr_sessions')
      .select('*')
      .eq('owner_id', ownerId)
      .maybeSingle();

    if (error) {
      throw mapPostgrestError(error, 'Could not read WhatsApp QR session');
    }

    return data ? asSession(data) : null;
  }

  async listReconnectableSessions(): Promise<WhatsappQrSessionRecord[]> {
    const { data, error } = await this.client
      .from('mastercrm_whatsapp_qr_sessions')
      .select('*')
      .eq('status', 'connected')
      .order('updated_at', { ascending: false });

    if (error) {
      throw mapPostgrestError(error, 'Could not list reconnectable WhatsApp QR sessions');
    }

    return ((data as any[] | null) ?? []).map(asSession);
  }

  async listSessions(ownerIds?: string[] | null): Promise<WhatsappQrSessionRecord[]> {
    let query = this.client
      .from('mastercrm_whatsapp_qr_sessions')
      .select('*')
      .order('updated_at', { ascending: false });

    if (ownerIds && ownerIds.length > 0) {
      query = query.in('owner_id', ownerIds);
    }

    const { data, error } = await query;
    if (error) {
      throw mapPostgrestError(error, 'Could not list WhatsApp QR sessions');
    }

    return ((data as any[] | null) ?? []).map(asSession);
  }

  async upsertSession(owner: WhatsappQrOwner, patch: UpsertWhatsappQrSessionPatch = {}): Promise<WhatsappQrSessionRecord> {
    const ownerKey = normalizeMastercrmOwnerKey(owner.ownerKey);
    const row = {
      owner_id: owner.ownerId,
      pagina: owner.pagina,
      owner_key: ownerKey,
      owner_label: owner.ownerLabel.trim(),
      runtime_session_id: runtimeSessionId({ ...owner, ownerKey }),
      ...sessionPatchToRow(patch)
    };

    const { data, error } = await this.client
      .from('mastercrm_whatsapp_qr_sessions')
      .upsert(row, { onConflict: 'owner_id' })
      .select('*')
      .single();

    if (error) {
      throw mapPostgrestError(error, 'Could not upsert WhatsApp QR session');
    }

    return asSession(data);
  }

  async updateSession(id: string, patch: UpsertWhatsappQrSessionPatch): Promise<WhatsappQrSessionRecord> {
    const { data, error } = await this.client
      .from('mastercrm_whatsapp_qr_sessions')
      .update(sessionPatchToRow(patch))
      .eq('id', id)
      .select('*')
      .single();

    if (error) {
      throw mapPostgrestError(error, 'Could not update WhatsApp QR session');
    }

    return asSession(data);
  }

  async listStaleSessions(input: { heartbeatBefore: string; qrExpiredBefore: string }): Promise<WhatsappQrSessionRecord[]> {
    const [heartbeat, qr, disconnected] = await Promise.all([
      this.client
        .from('mastercrm_whatsapp_qr_sessions')
        .select('*')
        .eq('status', 'connected')
        .lt('last_heartbeat_at', input.heartbeatBefore)
        .is('heartbeat_alerted_at', null),
      this.client
        .from('mastercrm_whatsapp_qr_sessions')
        .select('*')
        .eq('status', 'waiting_qr')
        .lt('qr_expires_at', input.qrExpiredBefore)
        .is('qr_alerted_at', null),
      this.client
        .from('mastercrm_whatsapp_qr_sessions')
        .select('*')
        .eq('status', 'disconnected')
        .is('disconnected_alerted_at', null)
    ]);

    const error = heartbeat.error ?? qr.error ?? disconnected.error;
    if (error) {
      throw mapPostgrestError(error, 'Could not list stale WhatsApp QR sessions');
    }

    return [heartbeat.data, qr.data, disconnected.data]
      .flatMap((rows) => ((rows as any[] | null) ?? []).map(asSession))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }

  async markAlerted(sessionId: string, kind: 'disconnected' | 'qr' | 'heartbeat', alertedAt: string): Promise<void> {
    const column =
      kind === 'disconnected' ? 'disconnected_alerted_at' : kind === 'qr' ? 'qr_alerted_at' : 'heartbeat_alerted_at';
    const { error } = await this.client
      .from('mastercrm_whatsapp_qr_sessions')
      .update({ [column]: alertedAt, updated_at: alertedAt })
      .eq('id', sessionId);

    if (error) {
      throw mapPostgrestError(error, 'Could not mark WhatsApp QR alert');
    }
  }

  async recordMessage(input: RecordWhatsappQrMessageInput): Promise<WhatsappQrMessageRecord> {
    const { data, error } = await this.client
      .from('mastercrm_whatsapp_qr_messages')
      .insert({
        session_id: input.sessionId,
        owner_id: input.ownerId,
        direction: input.direction,
        remote_jid: nullableText(input.remoteJid),
        message_id: nullableText(input.messageId),
        client_phone_e164: normalizePhone(input.clientPhoneE164),
        contact_name: nullableText(input.contactName),
        push_name: nullableText(input.pushName),
        text_excerpt: nullableText(input.textExcerpt),
        candidate_username: nullableText(input.candidateUsername),
        match_source: input.matchSource ?? null,
        message_timestamp: input.messageTimestamp ?? null
      })
      .select('*')
      .single();

    if (error) {
      throw mapPostgrestError(error, 'Could not record WhatsApp QR message');
    }

    return asMessage(data);
  }

  async upsertContact(input: {
    sessionId?: string | null;
    ownerId: string;
    phoneE164: string;
    contactName?: string | null;
    notify?: string | null;
    username?: string | null;
    verifiedName?: string | null;
    seenAt?: string;
  }): Promise<WhatsappQrContactRecord> {
    const seenAt = input.seenAt ?? new Date().toISOString();
    const { data, error } = await this.client
      .from('mastercrm_whatsapp_qr_contacts')
      .upsert(
        {
          owner_id: input.ownerId,
          session_id: input.sessionId ?? null,
          phone_e164: normalizePhone(input.phoneE164),
          contact_name: nullableText(input.contactName),
          notify: nullableText(input.notify),
          username: nullableText(input.username),
          verified_name: nullableText(input.verifiedName),
          last_seen_at: seenAt,
          updated_at: seenAt
        },
        { onConflict: 'owner_id,phone_e164' }
      )
      .select('*')
      .single();

    if (error) {
      throw mapPostgrestError(error, 'Could not upsert WhatsApp QR contact');
    }

    return asContact(data);
  }

  async recordChatMessage(input: {
    ownerId: string;
    phoneE164: string;
    messageAt: string;
    direction: 'inbound' | 'outbound';
  }): Promise<WhatsappQrChatState> {
    const { data, error } = await this.client.rpc('record_whatsapp_qr_chat_message_v1', {
      p_owner_id: input.ownerId,
      p_phone_e164: normalizePhone(input.phoneE164),
      p_message_at: input.messageAt,
      p_direction: input.direction
    });

    if (error) {
      throw mapPostgrestError(error, 'Could not record WhatsApp QR chat message');
    }

    const row = Array.isArray(data) ? data[0] : data;
    return {
      firstMessageAt: row.first_message_at,
      firstMessageDirection: row.first_message_direction,
      intakeRecordedAt: row.intake_recorded_at ?? null
    };
  }

  async markIntakeRecorded(input: { ownerId: string; phoneE164: string }): Promise<string | null> {
    const { data, error } = await this.client.rpc('mark_whatsapp_qr_intake_recorded_v1', {
      p_owner_id: input.ownerId,
      p_phone_e164: normalizePhone(input.phoneE164)
    });

    if (error) {
      throw mapPostgrestError(error, 'Could not mark WhatsApp QR intake');
    }

    return (data as string | null) ?? null;
  }

  async createMatch(input: CreateWhatsappQrMatchInput): Promise<WhatsappQrMatchRecord> {
    const { data, error } = await this.client
      .from('mastercrm_whatsapp_qr_matches')
      .insert({
        session_id: input.sessionId,
        owner_id: input.ownerId,
        message_id: input.messageId ?? null,
        client_phone_e164: normalizePhone(input.clientPhoneE164),
        username: input.username,
        source: input.source,
        status: input.status ?? 'candidate',
        error_message: nullableText(input.errorMessage)
      })
      .select('*')
      .single();

    if (error) {
      throw mapPostgrestError(error, 'Could not create WhatsApp QR match');
    }

    return asMatch(data);
  }

  async updateMatch(
    id: string,
    patch: {
      status: WhatsappQrMatchStatus;
      rdaValidatedAt?: string | null;
      assignedAt?: string | null;
      errorMessage?: string | null;
    }
  ): Promise<WhatsappQrMatchRecord> {
    const updatedAt = new Date().toISOString();
    const { data, error } = await this.client
      .from('mastercrm_whatsapp_qr_matches')
      .update({
        status: patch.status,
        ...(patch.rdaValidatedAt !== undefined ? { rda_validated_at: patch.rdaValidatedAt } : {}),
        ...(patch.assignedAt !== undefined ? { assigned_at: patch.assignedAt } : {}),
        ...(patch.errorMessage !== undefined ? { error_message: nullableText(patch.errorMessage) } : {}),
        updated_at: updatedAt
      })
      .eq('id', id)
      .select('*')
      .single();

    if (error) {
      throw mapPostgrestError(error, 'Could not update WhatsApp QR match');
    }

    return asMatch(data);
  }

  async listMessagesForMonth(input: { ownerId: string; createdFrom: string; createdTo: string; limit?: number }): Promise<WhatsappQrMessageRecord[]> {
    const data = await selectAllSupabasePages<any>(
      () => {
        let query = this.client
          .from('mastercrm_whatsapp_qr_messages')
          .select('*')
          .eq('owner_id', input.ownerId)
          .gte('created_at', input.createdFrom)
          .lt('created_at', input.createdTo)
          .order('created_at', { ascending: false });
        if (input.limit) {
          query = query.limit(input.limit);
        }
        return query;
      },
      'Could not list WhatsApp QR messages for month'
    );

    return data.map(asMessage);
  }

  async listMatches(ownerIds?: string[] | null, limit = 50): Promise<WhatsappQrMatchRecord[]> {
    let query = this.client
      .from('mastercrm_whatsapp_qr_matches')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (ownerIds && ownerIds.length > 0) {
      query = query.in('owner_id', ownerIds);
    }

    const { data, error } = await query;
    if (error) {
      throw mapPostgrestError(error, 'Could not list WhatsApp QR matches');
    }

    return ((data as any[] | null) ?? []).map(asMatch);
  }

  async listMatchesForMonth(input: { ownerId: string; createdFrom: string; createdTo: string; limit?: number }): Promise<WhatsappQrMatchRecord[]> {
    const data = await selectAllSupabasePages<any>(
      () => {
        let query = this.client
          .from('mastercrm_whatsapp_qr_matches')
          .select('*')
          .eq('owner_id', input.ownerId)
          .gte('created_at', input.createdFrom)
          .lt('created_at', input.createdTo)
          .order('created_at', { ascending: false });
        if (input.limit) {
          query = query.limit(input.limit);
        }
        return query;
      },
      'Could not list WhatsApp QR matches for month'
    );

    return data.map(asMatch);
  }

  async listContactsByPhones(input: { ownerId: string; phoneE164s: string[] }): Promise<WhatsappQrContactRecord[]> {
    const phones = [...new Set(input.phoneE164s.map((phone) => normalizePhone(phone)))];
    if (phones.length === 0) {
      return [];
    }

    const contacts: WhatsappQrContactRecord[] = [];
    for (const chunk of chunkValues(phones, 100)) {
      const { data, error } = await this.client
        .from('mastercrm_whatsapp_qr_contacts')
        .select('*')
        .eq('owner_id', input.ownerId)
        .in('phone_e164', chunk);

      if (error) {
        throw mapPostgrestError(error, 'Could not list WhatsApp QR contacts');
      }

      contacts.push(...(((data as any[] | null) ?? []).map(asContact)));
    }

    return contacts;
  }

  async getLatestBackfillRun(input: { ownerId: string; monthStart: string }): Promise<WhatsappQrBackfillRunRecord | null> {
    const { data, error } = await this.client
      .from('mastercrm_whatsapp_qr_backfill_runs')
      .select('*')
      .eq('owner_id', input.ownerId)
      .eq('month_start', input.monthStart)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw mapPostgrestError(error, 'Could not read latest WhatsApp QR backfill run');
    }

    return data ? asBackfillRun(data) : null;
  }

  async createBackfillRun(input: {
    ownerId: string;
    sessionId?: string | null;
    monthStart: string;
    triggerSource: string;
    startedAt?: string;
  }): Promise<WhatsappQrBackfillRunRecord> {
    const startedAt = input.startedAt ?? new Date().toISOString();
    const { data, error } = await this.client
      .from('mastercrm_whatsapp_qr_backfill_runs')
      .insert({
        owner_id: input.ownerId,
        session_id: input.sessionId ?? null,
        month_start: input.monthStart,
        trigger_source: nullableText(input.triggerSource) ?? 'auto',
        status: 'running',
        started_at: startedAt,
        updated_at: startedAt
      })
      .select('*')
      .single();

    if (error) {
      throw mapPostgrestError(error, 'Could not create WhatsApp QR backfill run');
    }

    return asBackfillRun(data);
  }

  async updateBackfillRun(
    id: string,
    patch: {
      status?: WhatsappQrBackfillRunStatus;
      finishedAt?: string | null;
      lastCompletedAt?: string | null;
      lastError?: string | null;
      summaryJson?: Record<string, unknown> | null;
    }
  ): Promise<WhatsappQrBackfillRunRecord> {
    const { data, error } = await this.client
      .from('mastercrm_whatsapp_qr_backfill_runs')
      .update({
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.finishedAt !== undefined ? { finished_at: patch.finishedAt } : {}),
        ...(patch.lastCompletedAt !== undefined ? { last_completed_at: patch.lastCompletedAt } : {}),
        ...(patch.lastError !== undefined ? { last_error: nullableText(patch.lastError) } : {}),
        ...(patch.summaryJson !== undefined ? { summary_json: patch.summaryJson } : {}),
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select('*')
      .single();

    if (error) {
      throw mapPostgrestError(error, 'Could not update WhatsApp QR backfill run');
    }

    return asBackfillRun(data);
  }

  async enqueueRecheck(input: {
    ownerId: string;
    sessionId?: string | null;
    monthStart: string;
    phoneE164: string;
    reason: WhatsappQrRecheckReason;
    nextRunAt?: string;
    expiresAt?: string;
  }): Promise<WhatsappQrRecheckQueueRecord> {
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = input.expiresAt ?? addDays(now, 7).toISOString();
    const { data, error } = await this.client
      .from('mastercrm_whatsapp_qr_recheck_queue')
      .upsert(
        {
          owner_id: input.ownerId,
          session_id: input.sessionId ?? null,
          month_start: input.monthStart,
          phone_e164: normalizePhone(input.phoneE164),
          reason: input.reason,
          status: 'pending',
          next_run_at: input.nextRunAt ?? nowIso,
          expires_at: expiresAt,
          last_error: null,
          updated_at: nowIso
        },
        { onConflict: 'owner_id,month_start,phone_e164' }
      )
      .select('*')
      .single();

    if (error) {
      throw mapPostgrestError(error, 'Could not enqueue WhatsApp QR recheck');
    }

    return asRecheck(data);
  }

  async listDueRechecks(input: { nowIso: string; limit: number }): Promise<WhatsappQrRecheckQueueRecord[]> {
    const { data, error } = await this.client
      .from('mastercrm_whatsapp_qr_recheck_queue')
      .select('*')
      .eq('status', 'pending')
      .lte('next_run_at', input.nowIso)
      .order('next_run_at', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(Math.max(1, Math.min(500, Math.trunc(input.limit))));

    if (error) {
      throw mapPostgrestError(error, 'Could not list due WhatsApp QR rechecks');
    }

    return ((data as any[] | null) ?? []).map(asRecheck);
  }

  async updateRecheck(
    id: string,
    patch: {
      status?: WhatsappQrRecheckStatus;
      attempts?: number;
      nextRunAt?: string;
      expiresAt?: string;
      lastError?: string | null;
    }
  ): Promise<WhatsappQrRecheckQueueRecord> {
    const { data, error } = await this.client
      .from('mastercrm_whatsapp_qr_recheck_queue')
      .update({
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.attempts !== undefined ? { attempts: patch.attempts } : {}),
        ...(patch.nextRunAt !== undefined ? { next_run_at: patch.nextRunAt } : {}),
        ...(patch.expiresAt !== undefined ? { expires_at: patch.expiresAt } : {}),
        ...(patch.lastError !== undefined ? { last_error: nullableText(patch.lastError) } : {}),
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select('*')
      .single();

    if (error) {
      throw mapPostgrestError(error, 'Could not update WhatsApp QR recheck');
    }

    return asRecheck(data);
  }

  async ignorePhoneForMonth(input: {
    ownerId: string;
    monthStart: string;
    phoneE164: string;
    ignoredByUserId?: number | null;
  }): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await this.client.from('mastercrm_whatsapp_qr_ignored_phones').upsert(
      {
        owner_id: input.ownerId,
        month_start: input.monthStart,
        client_phone_e164: normalizePhone(input.phoneE164),
        ignored_by_user_id: input.ignoredByUserId ?? null,
        reason: 'manual_ignore',
        updated_at: now
      },
      { onConflict: 'owner_id,month_start,client_phone_e164' }
    );

    if (error) {
      throw mapPostgrestError(error, 'Could not ignore WhatsApp QR phone for month');
    }
  }

  async getRdaCredential(ownerId: string): Promise<WhatsappQrRdaCredential | null> {
    const { data, error } = await this.client
      .from('mastercrm_rda_credentials')
      .select('*')
      .eq('owner_id', ownerId)
      .maybeSingle();

    if (error) {
      throw mapPostgrestError(error, 'Could not read RdA credentials');
    }

    return data ? asCredential(data) : null;
  }

  async upsertRdaCredential(input: {
    ownerId: string;
    ownerKey: string;
    loginUsername: string;
    loginPassword: string;
    source?: string;
    sourceRef?: string | null;
    syncedAt?: string;
  }): Promise<WhatsappQrRdaCredential> {
    const syncedAt = input.syncedAt ?? new Date().toISOString();
    const { data, error } = await this.client
      .from('mastercrm_rda_credentials')
      .upsert(
        {
          owner_id: input.ownerId,
          pagina: 'RdA',
          owner_key: normalizeMastercrmOwnerKey(input.ownerKey),
          login_username: input.loginUsername.trim(),
          login_password: input.loginPassword,
          source: input.source ?? 'n8n',
          source_ref: input.sourceRef ?? null,
          synced_at: syncedAt,
          updated_at: syncedAt
        },
        { onConflict: 'owner_id' }
      )
      .select('*')
      .single();

    if (error) {
      throw mapPostgrestError(error, 'Could not upsert RdA credentials');
    }

    return asCredential(data);
  }

  async listCredentialOwnerIds(ownerIds?: string[] | null): Promise<Set<string>> {
    let query = this.client.from('mastercrm_rda_credentials').select('owner_id');
    if (ownerIds && ownerIds.length > 0) {
      query = query.in('owner_id', ownerIds);
    }

    const { data, error } = await query;
    if (error) {
      throw mapPostgrestError(error, 'Could not list RdA credential owners');
    }

    return new Set(((data as Array<{ owner_id?: string }> | null) ?? []).map((row) => row.owner_id).filter(Boolean) as string[]);
  }
}

export function createWhatsappQrStore(client: SupabaseClient): WhatsappQrStore {
  return new SupabaseWhatsappQrStore(client);
}

export function createWhatsappQrStoreFromEnv(): WhatsappQrStore {
  const url = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url || !serviceRoleKey) {
    throw new WhatsappQrStoreError('CONFIGURATION', 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }
  if (serviceRoleKey.startsWith('sb_publishable_')) {
    throw new WhatsappQrStoreError(
      'CONFIGURATION',
      'SUPABASE_SERVICE_ROLE_KEY is invalid: got a publishable key. Use the service_role/secret key.'
    );
  }

  return createWhatsappQrStore(createClient(url, serviceRoleKey, { auth: { persistSession: false } }));
}

export function toWhatsappQrHttpError(error: unknown): { statusCode: number; message: string; code: string } | null {
  if (!(error instanceof WhatsappQrStoreError)) {
    return null;
  }

  if (error.code === 'VALIDATION') {
    return { statusCode: 400, message: error.message, code: 'WHATSAPP_QR_VALIDATION' };
  }
  if (error.code === 'NOT_FOUND') {
    return { statusCode: 404, message: error.message, code: 'WHATSAPP_QR_NOT_FOUND' };
  }
  if (error.code === 'CONFLICT') {
    return { statusCode: 409, message: error.message, code: 'WHATSAPP_QR_CONFLICT' };
  }
  if (error.code === 'CONFIGURATION') {
    return { statusCode: 500, message: error.message, code: 'WHATSAPP_QR_CONFIGURATION' };
  }

  return { statusCode: 500, message: 'Unexpected WhatsApp QR persistence error', code: 'WHATSAPP_QR_INTERNAL' };
}
