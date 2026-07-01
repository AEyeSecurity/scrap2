import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { normalizeMastercrmOwnerKey } from './mastercrm-user-store';
import type { WhatsappQrStore } from './whatsapp-qr-store';

export interface N8nRdaCashierCredentialRow {
  ownerKey: string;
  loginUsername: string;
  loginPassword: string;
  sourceRef: string;
}

export interface N8nRdaCredentialSyncResult {
  dryRun: boolean;
  scanned: number;
  eligible: number;
  synced: number;
  skippedMissingOwner: Array<{ ownerKey: string; sourceRef: string }>;
  skippedInvalid: Array<{ sourceRef: string; reason: string }>;
}

interface RawN8nSqliteRow {
  table?: string;
  rowid?: number;
  [key: string]: unknown;
}

function readStringField(row: Record<string, unknown>, aliases: string[]): string {
  for (const alias of aliases) {
    const value = row[alias];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value).trim();
    }
  }

  return '';
}

function isTruthyPermission(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return !['no', 'false', '0', 'inactivo', 'inactive', 'deshabilitado'].includes(normalized);
}

function isRdaRow(row: Record<string, unknown>): boolean {
  const pagina = readStringField(row, ['pagina', 'Pagina', 'PAGINA', 'sede', 'Sede', 'SEDE']);
  if (!pagina) {
    return true;
  }

  const normalized = pagina.toLowerCase();
  return ['rda', 'rey de ases', 'reydeases', 'reydeases.com'].includes(normalized);
}

export function normalizeN8nRdaCredentialRows(rawRows: RawN8nSqliteRow[]): {
  rows: N8nRdaCashierCredentialRow[];
  skippedInvalid: Array<{ sourceRef: string; reason: string }>;
} {
  const rows: N8nRdaCashierCredentialRow[] = [];
  const skippedInvalid: Array<{ sourceRef: string; reason: string }> = [];

  for (const rawRow of rawRows) {
    const table = typeof rawRow.table === 'string' ? rawRow.table : 'n8n';
    const rowid = typeof rawRow.rowid === 'number' ? rawRow.rowid : 0;
    const sourceRef = `${table}:${rowid}`;

    if (!isRdaRow(rawRow)) {
      continue;
    }

    const permission = readStringField(rawRow, ['Permiso', 'permiso', 'active', 'is_active']);
    if (permission && !isTruthyPermission(permission)) {
      continue;
    }

    const ownerKeyRaw = readStringField(rawRow, ['owner_key', 'Owner_Key', 'OWNER_KEY']);
    const loginUsername = readStringField(rawRow, ['usuario', 'Usuario', 'USUARIO', 'login_username']);
    const loginPassword = readStringField(rawRow, ['clave', 'Clave', 'CLAVE', 'password', 'login_password']);

    if (!ownerKeyRaw || !loginUsername || !loginPassword) {
      skippedInvalid.push({ sourceRef, reason: 'missing_owner_key_usuario_or_clave' });
      continue;
    }

    let ownerKey = '';
    try {
      ownerKey = normalizeMastercrmOwnerKey(ownerKeyRaw);
    } catch {
      skippedInvalid.push({ sourceRef, reason: 'invalid_owner_key' });
      continue;
    }

    rows.push({
      ownerKey,
      loginUsername,
      loginPassword,
      sourceRef
    });
  }

  const deduped = new Map<string, N8nRdaCashierCredentialRow>();
  for (const row of rows) {
    deduped.set(row.ownerKey, row);
  }

  return { rows: [...deduped.values()], skippedInvalid };
}

function runPythonJson(script: string, args: string[], pythonBin: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, ['-c', script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Python exited with code ${code}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Could not parse n8n SQLite reader output: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

export async function readN8nRdaCredentialRowsFromSqlite(
  sqlitePath: string,
  pythonBin = process.env.PYTHON_BIN?.trim() || 'python'
): Promise<N8nRdaCashierCredentialRow[]> {
  await access(sqlitePath);

  const script = String.raw`
import json
import sqlite3
import sys

db_path = sys.argv[1]
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row

def quote_ident(name):
    return '"' + name.replace('"', '""') + '"'

rows = []
tables = conn.execute("select name from sqlite_master where type = 'table' and name like 'data_table_user_%'").fetchall()
for table_row in tables:
    table = table_row["name"]
    columns = [column["name"] for column in conn.execute("pragma table_info(" + quote_ident(table) + ")").fetchall()]
    lower_columns = {column.lower() for column in columns}
    if "usuario" not in lower_columns or "clave" not in lower_columns or "owner_key" not in lower_columns:
        continue
    for row in conn.execute("select rowid, * from " + quote_ident(table)).fetchall():
        item = {key: row[key] for key in row.keys()}
        item["table"] = table
        rows.append(item)

print(json.dumps(rows, ensure_ascii=False))
`;

  const rawRows = (await runPythonJson(script, [sqlitePath], pythonBin)) as RawN8nSqliteRow[];
  if (!Array.isArray(rawRows)) {
    throw new Error('n8n SQLite reader returned an invalid payload');
  }

  return normalizeN8nRdaCredentialRows(rawRows).rows;
}

export async function runN8nRdaCredentialSync(input: {
  store: WhatsappQrStore;
  rows: N8nRdaCashierCredentialRow[];
  dryRun?: boolean;
}): Promise<N8nRdaCredentialSyncResult> {
  const dryRun = input.dryRun ?? true;
  const result: N8nRdaCredentialSyncResult = {
    dryRun,
    scanned: input.rows.length,
    eligible: 0,
    synced: 0,
    skippedMissingOwner: [],
    skippedInvalid: []
  };

  for (const row of input.rows) {
    result.eligible += 1;
    const owner = await input.store.resolveOwnerByKey('RdA', row.ownerKey);
    if (!owner) {
      result.skippedMissingOwner.push({ ownerKey: row.ownerKey, sourceRef: row.sourceRef });
      continue;
    }

    if (!dryRun) {
      await input.store.upsertRdaCredential({
        ownerId: owner.ownerId,
        ownerKey: row.ownerKey,
        loginUsername: row.loginUsername,
        loginPassword: row.loginPassword,
        source: 'n8n',
        sourceRef: row.sourceRef
      });
    }

    result.synced += 1;
  }

  return result;
}
