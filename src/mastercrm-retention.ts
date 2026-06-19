import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from 'pino';

type MastercrmRetentionErrorCode = 'CONFIGURATION' | 'INTERNAL';

interface DatabaseErrorLike {
  code?: string | null;
  message: string;
}

interface MastercrmTechnicalPurgeRow {
  cutoff_date: string;
  report_daily_snapshots_deleted: number | string | null;
  report_runs_deleted: number | string | null;
  report_run_items_deleted: number | string | null;
  report_outbox_deleted: number | string | null;
  meta_conversion_outbox_deleted: number | string | null;
  landing_sessions_deleted: number | string | null;
}

export interface MastercrmTechnicalPurgeRecord {
  cutoffDate: string;
  reportDailySnapshotsDeleted: number;
  reportRunsDeleted: number;
  reportRunItemsDeleted: number;
  reportOutboxDeleted: number;
  metaConversionOutboxDeleted: number;
  landingSessionsDeleted: number;
}

export interface MastercrmRetentionStore {
  purgeTechnicalHistory(cutoffDate: string): Promise<MastercrmTechnicalPurgeRecord>;
}

export interface MastercrmRetentionWorkerOptions {
  runOnStart: boolean;
  pollMs: number;
  now?: () => Date;
}

export class MastercrmRetentionError extends Error {
  constructor(
    public readonly code: MastercrmRetentionErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'MastercrmRetentionError';
  }
}

function mapDatabaseError(error: DatabaseErrorLike, fallbackMessage: string): MastercrmRetentionError {
  const code = error.code ?? '';
  const detail = code ? `${fallbackMessage} (${code}: ${error.message})` : `${fallbackMessage}: ${error.message}`;
  return new MastercrmRetentionError('INTERNAL', detail);
}

function mapPostgrestError(error: PostgrestError, fallbackMessage: string): MastercrmRetentionError {
  return mapDatabaseError({ code: error.code, message: error.message }, fallbackMessage);
}

function toNonNegativeInteger(value: number | string | null | undefined): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

function normalizePurgeRow(row: MastercrmTechnicalPurgeRow | null | undefined): MastercrmTechnicalPurgeRecord {
  if (!row || typeof row.cutoff_date !== 'string') {
    throw new MastercrmRetentionError('INTERNAL', 'purge_mastercrm_technical_history_v1 returned invalid payload');
  }

  return {
    cutoffDate: row.cutoff_date,
    reportDailySnapshotsDeleted: toNonNegativeInteger(row.report_daily_snapshots_deleted),
    reportRunsDeleted: toNonNegativeInteger(row.report_runs_deleted),
    reportRunItemsDeleted: toNonNegativeInteger(row.report_run_items_deleted),
    reportOutboxDeleted: toNonNegativeInteger(row.report_outbox_deleted),
    metaConversionOutboxDeleted: toNonNegativeInteger(row.meta_conversion_outbox_deleted),
    landingSessionsDeleted: toNonNegativeInteger(row.landing_sessions_deleted)
  };
}

export function getBuenosAiresCurrentMonthStartDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(now);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;

  if (!year || !month) {
    throw new MastercrmRetentionError('INTERNAL', 'Could not resolve Buenos Aires month start date');
  }

  return `${year}-${month}-01`;
}

class SupabaseMastercrmRetentionStore implements MastercrmRetentionStore {
  constructor(private readonly client: SupabaseClient) {}

  async purgeTechnicalHistory(cutoffDate: string): Promise<MastercrmTechnicalPurgeRecord> {
    const { data, error } = await this.client.rpc('purge_mastercrm_technical_history_v1', {
      p_cutoff_date: cutoffDate
    });

    if (error) {
      throw mapPostgrestError(error, 'Could not purge MasterCRM technical history');
    }

    const row = Array.isArray(data) ? data[0] : data;
    return normalizePurgeRow(row as MastercrmTechnicalPurgeRow | null | undefined);
  }
}

export class MastercrmRetentionWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly store: MastercrmRetentionStore,
    private readonly logger: Logger,
    private readonly options: MastercrmRetentionWorkerOptions
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }

    if (this.options.runOnStart) {
      void this.runOnce();
    }

    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.options.pollMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runOnce(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    const cutoffDate = getBuenosAiresCurrentMonthStartDate(this.options.now?.() ?? new Date());
    try {
      const result = await this.store.purgeTechnicalHistory(cutoffDate);
      this.logger.info({ cutoffDate, result }, 'MasterCRM technical retention purge completed');
    } catch (error) {
      this.logger.error({ error, cutoffDate }, 'MasterCRM technical retention purge failed');
    } finally {
      this.running = false;
    }
  }
}

export function createMastercrmRetentionStore(client: SupabaseClient): MastercrmRetentionStore {
  return new SupabaseMastercrmRetentionStore(client);
}

export function createMastercrmRetentionStoreFromEnv(env: NodeJS.ProcessEnv = process.env): MastercrmRetentionStore {
  const url = env.SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url || !serviceRoleKey) {
    throw new MastercrmRetentionError(
      'CONFIGURATION',
      'Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'
    );
  }

  if (serviceRoleKey.startsWith('sb_publishable_')) {
    throw new MastercrmRetentionError(
      'CONFIGURATION',
      'SUPABASE_SERVICE_ROLE_KEY is invalid: got a publishable key. Use the service_role/secret key.'
    );
  }

  return createMastercrmRetentionStore(createClient(url, serviceRoleKey, { auth: { persistSession: false } }));
}
