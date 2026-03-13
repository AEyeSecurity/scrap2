import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';
import type { AsnReportJobResult } from './types';

type ReportRunStoreErrorCode = 'CONFIGURATION' | 'VALIDATION' | 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL';

interface DatabaseErrorLike {
  code?: string | null;
  message: string;
}

export type ReportRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'cancelled';

export type ReportRunItemStatus = 'pending' | 'leased' | 'done' | 'failed' | 'retry_wait';

export interface CreateReportRunInput {
  pagina: 'ASN';
  principalKey: string;
  reportDate: string;
  agente: string;
  contrasenaAgente: string;
  metadata?: Record<string, unknown>;
}

export interface ReportRunRecord {
  id: string;
  pagina: 'ASN';
  principalKey: string;
  reportDate: string;
  status: ReportRunStatus;
  agente: string;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  totalItems: number;
  doneItems: number;
  failedItems: number;
  metadata: Record<string, unknown>;
}

export interface ReportRunItemRecord {
  id: string;
  runId: string;
  ownerId: string;
  identityId: string;
  clientId: string;
  linkId: string;
  username: string;
  ownerKey: string;
  ownerLabel: string;
  status: ReportRunItemStatus;
  attempts: number;
  maxAttempts: number;
  leaseUntil: string | null;
  nextRetryAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  cargadoHoy: number | null;
  cargadoMes: number | null;
  rawResult: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReportRunLease {
  itemId: string;
  runId: string;
  pagina: 'ASN';
  principalKey: string;
  reportDate: string;
  agente: string;
  contrasenaAgente: string;
  ownerId: string;
  identityId: string;
  clientId: string;
  linkId: string;
  username: string;
  ownerKey: string;
  ownerLabel: string;
  attempts: number;
  maxAttempts: number;
}

export interface ReportRunItemsPage {
  items: ReportRunItemRecord[];
  total: number;
}

export interface ReportRunStore {
  createRun(input: CreateReportRunInput): Promise<ReportRunRecord>;
  deleteRun(runId: string): Promise<void>;
  enqueueRunItemsFromPrincipal(runId: string, principalKey: string): Promise<number>;
  leaseNextRunItem(leaseSeconds: number, maxAttempts: number): Promise<ReportRunLease | null>;
  completeRunItem(lease: ReportRunLease, result: AsnReportJobResult): Promise<void>;
  failRunItem(lease: ReportRunLease, error: string): Promise<void>;
  upsertDailySnapshot(lease: ReportRunLease, result: AsnReportJobResult): Promise<void>;
  refreshRunStatus(runId: string): Promise<ReportRunRecord>;
  createOutboxEntry(runId: string): Promise<void>;
  getRunById(runId: string): Promise<ReportRunRecord>;
  listRunItems(runId: string, limit: number, offset: number): Promise<ReportRunItemsPage>;
}

export class ReportRunStoreError extends Error {
  constructor(
    public readonly code: ReportRunStoreErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'ReportRunStoreError';
  }
}

function normalizeKey(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw new ReportRunStoreError('VALIDATION', `${label} is required`);
  }

  return normalized;
}

function normalizeDate(value: string): string {
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new ReportRunStoreError('VALIDATION', 'reportDate must follow YYYY-MM-DD');
  }

  return normalized;
}

function normalizeText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ReportRunStoreError('VALIDATION', `${label} is required`);
  }

  return normalized;
}

function mapDatabaseError(error: DatabaseErrorLike, fallbackMessage: string): ReportRunStoreError {
  const code = error.code ?? '';
  if (code === '23505') {
    return new ReportRunStoreError('CONFLICT', fallbackMessage);
  }
  if (code === '23503' || code === 'PGRST116') {
    return new ReportRunStoreError('NOT_FOUND', fallbackMessage);
  }
  if (code === '23514' || code === '22023' || code === '22P02') {
    return new ReportRunStoreError('VALIDATION', fallbackMessage);
  }

  const detail = code ? `${fallbackMessage} (${code}: ${error.message})` : `${fallbackMessage}: ${error.message}`;
  return new ReportRunStoreError('INTERNAL', detail);
}

function mapPostgrestError(error: PostgrestError, fallbackMessage: string): ReportRunStoreError {
  return mapDatabaseError({ code: error.code, message: error.message }, fallbackMessage);
}

function mapRpcError(error: PostgrestError, fallbackMessage: string): ReportRunStoreError {
  const message = error.message || fallbackMessage;
  const normalized = message.toLowerCase();
  if (error.code === 'P0001' && normalized.includes('no report users found')) {
    return new ReportRunStoreError('NOT_FOUND', 'No report users found for principalKey');
  }
  return mapPostgrestError(error, fallbackMessage);
}

type ReportRunRow = {
  id: string;
  pagina: 'ASN';
  principal_key: string;
  report_date: string;
  status: ReportRunStatus;
  agente: string;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  total_items: number;
  done_items: number;
  failed_items: number;
  metadata: Record<string, unknown> | null;
};

type ReportRunItemRow = {
  id: string;
  run_id: string;
  owner_id: string;
  identity_id: string;
  client_id: string;
  link_id: string;
  username: string;
  owner_key: string;
  owner_label: string;
  status: ReportRunItemStatus;
  attempts: number;
  max_attempts: number;
  lease_until: string | null;
  next_retry_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  last_error: string | null;
  cargado_hoy: number | null;
  cargado_mes: number | null;
  raw_result: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

type ClaimRow = {
  item_id: string;
  run_id: string;
  pagina: 'ASN';
  principal_key: string;
  report_date: string;
  agente: string;
  contrasena_agente: string;
  owner_id: string;
  identity_id: string;
  client_id: string;
  link_id: string;
  username: string;
  owner_key: string;
  owner_label: string;
  attempts: number;
  max_attempts: number;
};

const REDACTED_REPORT_SECRET = '[redacted]';

function asRunRecord(row: ReportRunRow): ReportRunRecord {
  return {
    id: row.id,
    pagina: row.pagina,
    principalKey: row.principal_key,
    reportDate: row.report_date,
    status: row.status,
    agente: row.agente,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    totalItems: row.total_items,
    doneItems: row.done_items,
    failedItems: row.failed_items,
    metadata: row.metadata ?? {}
  };
}

function asItemRecord(row: ReportRunItemRow): ReportRunItemRecord {
  return {
    id: row.id,
    runId: row.run_id,
    ownerId: row.owner_id,
    identityId: row.identity_id,
    clientId: row.client_id,
    linkId: row.link_id,
    username: row.username,
    ownerKey: row.owner_key,
    ownerLabel: row.owner_label,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    leaseUntil: row.lease_until,
    nextRetryAt: row.next_retry_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    lastError: row.last_error,
    cargadoHoy: row.cargado_hoy,
    cargadoMes: row.cargado_mes,
    rawResult: row.raw_result,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function asLease(row: ClaimRow): ReportRunLease {
  return {
    itemId: row.item_id,
    runId: row.run_id,
    pagina: row.pagina,
    principalKey: row.principal_key,
    reportDate: row.report_date,
    agente: row.agente,
    contrasenaAgente: row.contrasena_agente,
    ownerId: row.owner_id,
    identityId: row.identity_id,
    clientId: row.client_id,
    linkId: row.link_id,
    username: row.username,
    ownerKey: row.owner_key,
    ownerLabel: row.owner_label,
    attempts: row.attempts,
    maxAttempts: row.max_attempts
  };
}

export class SupabaseReportRunStore implements ReportRunStore {
  constructor(private readonly client: SupabaseClient) {}

  private async redactRunSecret(runId: string): Promise<void> {
    const { error } = await this.client
      .from('report_runs')
      .update({ contrasena_agente: REDACTED_REPORT_SECRET })
      .eq('id', runId)
      .neq('contrasena_agente', REDACTED_REPORT_SECRET);

    if (error) {
      throw mapPostgrestError(error, 'Could not redact report run secret');
    }
  }

  async createRun(input: CreateReportRunInput): Promise<ReportRunRecord> {
    const principalKey = normalizeKey(input.principalKey, 'principalKey');
    const reportDate = normalizeDate(input.reportDate);
    const agente = normalizeText(input.agente, 'agente');
    const contrasenaAgente = normalizeText(input.contrasenaAgente, 'contrasena_agente');

    const { data, error } = await this.client
      .from('report_runs')
      .insert({
        pagina: input.pagina,
        principal_key: principalKey,
        report_date: reportDate,
        status: 'queued',
        agente,
        contrasena_agente: contrasenaAgente,
        metadata: input.metadata ?? {}
      })
      .select('*')
      .single();

    if (error) {
      throw mapPostgrestError(error, 'Could not create report run');
    }

    return asRunRecord(data as ReportRunRow);
  }

  async deleteRun(runId: string): Promise<void> {
    const { error } = await this.client.from('report_runs').delete().eq('id', runId);
    if (error) {
      throw mapPostgrestError(error, 'Could not delete report run');
    }
  }

  async enqueueRunItemsFromPrincipal(runId: string, principalKey: string): Promise<number> {
    const { data, error } = await this.client.rpc('enqueue_report_run_items', {
      p_run_id: runId,
      p_principal_key: normalizeKey(principalKey, 'principalKey')
    });

    if (error) {
      throw mapRpcError(error, 'Could not enqueue report run items');
    }

    return Number(data ?? 0);
  }

  async leaseNextRunItem(leaseSeconds: number, maxAttempts: number): Promise<ReportRunLease | null> {
    const { data, error } = await this.client.rpc('claim_next_report_run_item', {
      p_lease_seconds: Math.max(1, Math.trunc(leaseSeconds)),
      p_max_attempts: Math.max(1, Math.trunc(maxAttempts))
    });

    if (error) {
      throw mapRpcError(error, 'Could not claim report run item');
    }

    const rows = Array.isArray(data) ? data : data ? [data] : [];
    if (rows.length === 0) {
      return null;
    }

    return asLease(rows[0] as ClaimRow);
  }

  async completeRunItem(lease: ReportRunLease, result: AsnReportJobResult): Promise<void> {
    const { error } = await this.client
      .from('report_run_items')
      .update({
        status: 'done',
        lease_until: null,
        next_retry_at: null,
        finished_at: new Date().toISOString(),
        last_error: null,
        cargado_hoy: result.cargadoHoyNumero,
        cargado_mes: result.cargadoNumero,
        raw_result: result
      })
      .eq('id', lease.itemId);

    if (error) {
      throw mapPostgrestError(error, 'Could not complete report run item');
    }
  }

  async failRunItem(lease: ReportRunLease, errorMessage: string): Promise<void> {
    const terminal = lease.attempts >= lease.maxAttempts;
    const delaySeconds = lease.attempts >= lease.maxAttempts - 1 ? 300 : 60;
    const nextRetryAt = terminal ? null : new Date(Date.now() + delaySeconds * 1000).toISOString();

    const { error } = await this.client
      .from('report_run_items')
      .update({
        status: terminal ? 'failed' : 'retry_wait',
        lease_until: null,
        next_retry_at: nextRetryAt,
        finished_at: terminal ? new Date().toISOString() : null,
        last_error: errorMessage
      })
      .eq('id', lease.itemId);

    if (error) {
      throw mapPostgrestError(error, 'Could not fail report run item');
    }
  }

  async upsertDailySnapshot(lease: ReportRunLease, result: AsnReportJobResult): Promise<void> {
    const { error } = await this.client.from('report_daily_snapshots').upsert(
      {
        pagina: lease.pagina,
        report_date: lease.reportDate,
        principal_key: lease.principalKey,
        owner_id: lease.ownerId,
        identity_id: lease.identityId,
        client_id: lease.clientId,
        link_id: lease.linkId,
        username: lease.username,
        owner_key: lease.ownerKey,
        owner_label: lease.ownerLabel,
        cargado_hoy: result.cargadoHoyNumero,
        cargado_mes: result.cargadoNumero,
        raw_result: result
      },
      { onConflict: 'report_date,pagina,username' }
    );

    if (error) {
      throw mapPostgrestError(error, 'Could not upsert report daily snapshot');
    }
  }

  async refreshRunStatus(runId: string): Promise<ReportRunRecord> {
    const { data, error } = await this.client.rpc('refresh_report_run_state', { p_run_id: runId });
    if (error) {
      throw mapRpcError(error, 'Could not refresh report run state');
    }

    return this.getRunById(runId);
  }

  async createOutboxEntry(runId: string): Promise<void> {
    const run = await this.getRunById(runId);
    if (!['completed', 'completed_with_errors', 'failed'].includes(run.status)) {
      return;
    }

    const itemsPage = await this.listRunItems(runId, 10_000, 0);
    const payload = {
      runId: run.id,
      pagina: run.pagina,
      principalKey: run.principalKey,
      reportDate: run.reportDate,
      status: run.status,
      requestedAt: run.requestedAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      totalItems: run.totalItems,
      doneItems: run.doneItems,
      failedItems: run.failedItems,
      items: itemsPage.items.map((item) => ({
        username: item.username,
        ownerKey: item.ownerKey,
        ownerLabel: item.ownerLabel,
        status: item.status,
        attempts: item.attempts,
        cargadoHoy: item.cargadoHoy,
        cargadoMes: item.cargadoMes,
        error: item.lastError
      }))
    };

    await this.redactRunSecret(runId);

    const { error } = await this.client.from('report_outbox').upsert(
      {
        run_id: runId,
        kind: 'asn_report_run_completed',
        payload,
        status: 'consumed',
        consumed_at: new Date().toISOString()
      },
      { onConflict: 'run_id,kind' }
    );

    if (error) {
      throw mapPostgrestError(error, 'Could not create report outbox entry');
    }
  }

  async getRunById(runId: string): Promise<ReportRunRecord> {
    const { data, error } = await this.client.from('report_runs').select('*').eq('id', runId).single();
    if (error) {
      throw mapPostgrestError(error, 'Report run not found');
    }

    return asRunRecord(data as ReportRunRow);
  }

  async listRunItems(runId: string, limit: number, offset: number): Promise<ReportRunItemsPage> {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const safeOffset = Math.max(0, Math.trunc(offset));
    const { data, error, count } = await this.client
      .from('report_run_items')
      .select('*', { count: 'exact' })
      .eq('run_id', runId)
      .order('created_at', { ascending: true })
      .range(safeOffset, safeOffset + safeLimit - 1);

    if (error) {
      throw mapPostgrestError(error, 'Could not list report run items');
    }

    return {
      items: (data as ReportRunItemRow[]).map(asItemRecord),
      total: count ?? 0
    };
  }
}

export function toHttpError(error: unknown): { statusCode: number; message: string } | null {
  if (!(error instanceof ReportRunStoreError)) {
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
  if (error.code === 'CONFIGURATION') {
    return { statusCode: 500, message: error.message };
  }

  return { statusCode: 500, message: 'Unexpected report persistence error' };
}

export function createReportRunStoreFromEnv(env: NodeJS.ProcessEnv = process.env): ReportRunStore {
  const url = env.SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url || !serviceRoleKey) {
    throw new ReportRunStoreError(
      'CONFIGURATION',
      'Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'
    );
  }

  if (serviceRoleKey.startsWith('sb_publishable_')) {
    throw new ReportRunStoreError(
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

  return new SupabaseReportRunStore(client);
}
