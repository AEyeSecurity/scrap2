import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function migration(name: string): string {
  return readFileSync(join(__dirname, '..', 'db', 'migrations', name), 'utf8').toLowerCase();
}

describe('RdA/ASN report and QR migrations', () => {
  it('allows an unknown RdA daily amount instead of persisting a false zero', () => {
    const sql = migration('20260806160000_rda_daily_amount_nullable.sql');
    expect(sql).toMatch(/alter\s+column\s+cargado_hoy\s+drop\s+not\s+null/);
    expect(sql).toContain('null means the baseline is unavailable');
  });

  it('adds event-time idempotency and excerpt retention to QR', () => {
    const sql = migration('20260806160100_whatsapp_qr_event_idempotency.sql');
    expect(sql).toContain('event_at timestamptz');
    expect(sql).toMatch(/unique\s*\(session_id,\s*message_id\)/);
    expect(sql).toMatch(/unique\s*\(message_id,\s*username,\s*source\)/);
    expect(sql).toContain('purge_mastercrm_whatsapp_qr_message_excerpts_v1');
  });

  it('keeps neutral platform credentials compatible with existing RdA credentials', () => {
    const sql = migration('20260806160200_mastercrm_platform_credentials.sql');
    expect(sql).toContain('create table if not exists public.mastercrm_platform_credentials');
    expect(sql).toContain("pagina in ('rda', 'asn')");
    expect(sql).toContain('from public.mastercrm_rda_credentials');
    expect(sql).toContain('platform_validated_at');
  });

  it('stores report credentials by reference and fences stale workers with lease tokens', () => {
    const sql = migration('20260806160300_report_run_lease_tokens.sql');
    expect(sql).toContain('create table if not exists public.mastercrm_report_credentials');
    expect(sql).toMatch(/credential_id\s+uuid\s+references\s+public\.mastercrm_report_credentials/);
    expect(sql).toContain('lease_token uuid');
    expect(sql).toContain('v_lease_token uuid := gen_random_uuid()');
    expect(sql).toContain('credentials.login_password');
  });
});
