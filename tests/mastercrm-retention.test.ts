import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createMastercrmRetentionStore,
  getBuenosAiresCurrentMonthStartDate,
  MastercrmRetentionWorker,
  type MastercrmRetentionStore
} from '../src/mastercrm-retention';

function createLogger() {
  return {
    info: vi.fn(),
    error: vi.fn()
  };
}

describe('mastercrm retention', () => {
  it('resolves the current month start in Buenos Aires timezone', () => {
    expect(getBuenosAiresCurrentMonthStartDate(new Date('2026-07-01T02:30:00.000Z'))).toBe('2026-06-01');
    expect(getBuenosAiresCurrentMonthStartDate(new Date('2026-07-01T03:00:00.000Z'))).toBe('2026-07-01');
  });

  it('calls the technical retention RPC and normalizes deleted counts', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          cutoff_date: '2026-06-01',
          report_daily_snapshots_deleted: '100',
          report_runs_deleted: 2,
          report_run_items_deleted: '200',
          report_outbox_deleted: null,
          meta_conversion_outbox_deleted: '5',
          landing_sessions_deleted: 7
        }
      ],
      error: null
    });
    const store = createMastercrmRetentionStore({ rpc } as never);

    await expect(store.purgeTechnicalHistory('2026-06-01')).resolves.toEqual({
      cutoffDate: '2026-06-01',
      reportDailySnapshotsDeleted: 100,
      reportRunsDeleted: 2,
      reportRunItemsDeleted: 200,
      reportOutboxDeleted: 0,
      metaConversionOutboxDeleted: 5,
      landingSessionsDeleted: 7
    });
    expect(rpc).toHaveBeenCalledWith('purge_mastercrm_technical_history_v1', { p_cutoff_date: '2026-06-01' });
  });

  it('logs retention worker failures without throwing', async () => {
    const store: MastercrmRetentionStore = {
      purgeTechnicalHistory: vi.fn().mockRejectedValue(new Error('database unavailable'))
    };
    const logger = createLogger();
    const worker = new MastercrmRetentionWorker(store, logger as never, {
      runOnStart: false,
      pollMs: 86_400_000,
      now: () => new Date('2026-06-19T15:00:00.000Z')
    });

    await expect(worker.runOnce()).resolves.toBeUndefined();

    expect(store.purgeTechnicalHistory).toHaveBeenCalledWith('2026-06-01');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        cutoffDate: '2026-06-01',
        error: expect.any(Error)
      }),
      'MasterCRM technical retention purge failed'
    );
  });

  it('keeps the technical retention migration scoped to non-business history', () => {
    const migration = readFileSync(
      join(__dirname, '..', 'db', 'migrations', '20260619_mastercrm_technical_retention.sql'),
      'utf8'
    ).toLowerCase();

    expect(migration).toMatch(/delete\s+from\s+public\.report_daily_snapshots/);
    expect(migration).toMatch(/delete\s+from\s+public\.report_runs/);
    expect(migration).toMatch(/delete\s+from\s+public\.meta_conversion_outbox/);
    expect(migration).toMatch(/delete\s+from\s+public\.landing_sessions/);
    expect(migration).toMatch(/status\s+in\s*\(\s*'sent'\s*,\s*'failed'\s*,\s*'discarded'\s*\)/);
    expect(migration).toMatch(/interval\s+'48 hours'/);

    for (const businessTable of [
      'clients',
      'owner_client_links',
      'owner_client_identities',
      'owner_client_events',
      'owner_client_monthly_facts',
      'owner_marketing_daily_budgets',
      'owner_financial_settings'
    ]) {
      expect(migration).not.toMatch(new RegExp(`delete\\s+from\\s+public\\.${businessTable}\\b`));
    }
  });
});
