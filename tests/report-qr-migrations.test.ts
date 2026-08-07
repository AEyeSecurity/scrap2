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

  it('adds shared physical-session routes and route-specific match idempotency', () => {
    const sql = migration('20260807121000_whatsapp_qr_shared_session_routes.sql');
    expect(sql).toContain('create table if not exists public.mastercrm_whatsapp_qr_session_routes');
    expect(sql).toMatch(/unique\s*\(session_id,\s*owner_id\)/);
    expect(sql).toMatch(/unique\s*\(message_id,\s*owner_id,\s*username,\s*source\)/);
    expect(sql).toContain("route_status in ('unrouted', 'resolved', 'conflict', 'not_found', 'error')");
    expect(sql).toContain('set_whatsapp_qr_message_route_v1');
    expect(sql).toContain("route_resolution = 'legacy_primary_owner'");
    expect(sql).toContain('set owner_id = v_route.owner_id');
    expect(sql).toContain('uq_mastercrm_whatsapp_qr_session_routes_active_owner');
  });

  it('supports both an exact owner pilot and a principal-wide report run', () => {
    const sql = migration('20260807122500_report_run_exact_principal.sql');
    expect(sql).toContain('o.owner_key = v_principal_key');
    expect(sql).toContain("o.owner_key like v_principal_key || ':%'");
  });

  it('creates active ASN owners and merges only the incorrect ASN Vicky owner transactionally', () => {
    const sql = migration('20260807123000_normalize_asn_owners.sql');
    expect(sql).toContain("where pagina = 'asn' and owner_key = 'luqui10:vicky'");
    expect(sql).toContain("where pagina = 'asn' and owner_key = 'asnlucas10:vicky'");
    expect(sql).toContain('asn vicky owner merge has overlapping clients');
    expect(sql).toContain('update public.owner_client_identities set owner_id = v_target_owner_id');
    expect(sql).toContain('update public.owner_client_monthly_facts set owner_id = v_target_owner_id');
    expect(sql).toMatch(/update public\.report_daily_snapshots\s+set owner_id = v_target_owner_id/);
    expect(sql).toContain('owner_key = v_target_owner_key');
    expect(sql).toContain("('asn', 'asnlucas10:lucas1', 'lucas1')");
    expect(sql).toContain("('asn', 'asnlucas10:leandro', 'leandro')");
  });

  it('pairs cashiers explicitly and assigns dual-platform QR identities transactionally', () => {
    const sql = migration('20260807124500_whatsapp_qr_dual_platform_pairs.sql');
    expect(sql).toContain('create table if not exists public.mastercrm_platform_owner_pairs');
    expect(sql).toContain('create table if not exists public.mastercrm_whatsapp_qr_message_resolutions');
    expect(sql).toContain('assign_username_to_platform_owner_pair_v1');
    expect(sql).toContain('set_whatsapp_qr_message_routes_v1');
    expect(sql).toContain("('luqui10:luqui10', 'asnlucas10:lucas10')");
    expect(sql).not.toContain("('luqui10:lucas10', 'asnlucas10:lucas10')");
    expect(sql).not.toContain("'asnlucas10:lucas5'");
  });
});
