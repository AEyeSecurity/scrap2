import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('strict ASN/report credential migration', () => {
  it('leases with the exact owner/platform credential and has no run-secret fallback', () => {
    const sql = readFileSync(
      join(__dirname, '..', 'db', 'migrations', '20260807122000_report_run_strict_credentials.sql'),
      'utf8'
    ).toLowerCase();

    expect(sql).toContain("last_error = 'platform_credential_missing'");
    expect(sql).toMatch(/join\s+public\.mastercrm_platform_credentials\s+credentials/);
    expect(sql).toContain('credentials.owner_id = ri.owner_id');
    expect(sql).toContain('credentials.pagina = rr.pagina');
    expect(sql).toContain('credentials.owner_key = ri.owner_key');
    expect(sql).not.toMatch(/coalesce\s*\(\s*credentials\.login_(username|password)/);
    expect(sql).not.toContain('rr.contrasena_agente as contrasena_agente');
    expect(sql).not.toContain('delete from public.mastercrm_report_credentials');
    expect(sql).not.toMatch(/credential_id\s*=\s*null/);
    expect(sql).toContain('lease_token = v_lease_token');
  });
});
