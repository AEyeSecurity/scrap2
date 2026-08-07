import { describe, expect, it, vi } from 'vitest';
import { normalizeN8nRdaCredentialRows, runN8nRdaCredentialSync } from '../src/n8n-rda-credential-sync';

describe('strict n8n platform credential sync', () => {
  it('deduplicates identical rows but rejects an owner with conflicting credentials', () => {
    const normalized = normalizeN8nRdaCredentialRows(
      [
        { table: 'asn', rowid: 1, Sede: 'ASN', Permiso: 'si', owner_key: 'asnlucas10:lucas10', usuario: 'agent', clave: 'one' },
        { table: 'asn', rowid: 2, Sede: 'ASN', Permiso: 'si', owner_key: 'asnlucas10:lucas10', usuario: 'agent', clave: 'one' },
        { table: 'asn', rowid: 3, Sede: 'ASN', Permiso: 'si', owner_key: 'asnlucas10:vicky', usuario: 'agent', clave: 'one' },
        { table: 'asn', rowid: 4, Sede: 'ASN', Permiso: 'si', owner_key: 'asnlucas10:vicky', usuario: 'agent', clave: 'two' }
      ],
      'ASN'
    );

    expect(normalized.rows).toEqual([
      expect.objectContaining({ ownerKey: 'asnlucas10:lucas10', sourceRef: 'asn:1' })
    ]);
    expect(normalized.skippedInvalid).toContainEqual({
      sourceRef: 'asn:3,asn:4',
      reason: 'conflicting_duplicate_credentials:asnlucas10:vicky'
    });
  });

  it('only considers ASN rows explicitly enabled with Permiso=si', () => {
    const normalized = normalizeN8nRdaCredentialRows(
      [
        { table: 'asn', rowid: 1, Sede: 'ASN', Permiso: 'no', owner_key: 'asnlucas10:lucas1', usuario: 'a', clave: 'x' },
        { table: 'asn', rowid: 2, Sede: 'ASN', owner_key: 'asnlucas10:lucas5', usuario: 'a', clave: 'x' },
        { table: 'asn', rowid: 3, Sede: 'ASN', Permiso: 'si', owner_key: 'asnlucas10:lucas10', usuario: 'a', clave: 'x' }
      ],
      'ASN'
    );

    expect(normalized.rows.map((row) => row.ownerKey)).toEqual(['asnlucas10:lucas10']);
  });

  it('writes only through generic platform credential storage', async () => {
    const upsertPlatformCredential = vi.fn(async () => undefined);
    const store = {
      resolveOwnerByKey: vi.fn(async () => ({
        ownerId: 'owner-1',
        ownerKey: 'asnlucas10:lucas10',
        ownerLabel: 'Lucas10',
        pagina: 'ASN',
        telefono: null
      })),
      upsertRdaCredential: vi.fn(() => {
        throw new Error('legacy credential storage must not be called');
      }),
      upsertPlatformCredential
    };

    await runN8nRdaCredentialSync({
      store: store as any,
      pagina: 'ASN',
      dryRun: false,
      rows: [
        {
          ownerKey: 'asnlucas10:lucas10',
          loginUsername: 'agent',
          loginPassword: 'secret',
          sourceRef: 'asn:1'
        }
      ]
    });

    expect(upsertPlatformCredential).toHaveBeenCalledWith(
      expect.objectContaining({ pagina: 'ASN', ownerId: 'owner-1', ownerKey: 'asnlucas10:lucas10' })
    );
    expect(store.upsertRdaCredential).not.toHaveBeenCalled();
  });

  it('fails writes when generic platform credential storage is unavailable', async () => {
    await expect(
      runN8nRdaCredentialSync({
        store: { resolveOwnerByKey: vi.fn(async () => ({ ownerId: 'owner-1' })) } as any,
        pagina: 'ASN',
        dryRun: false,
        rows: [
          {
            ownerKey: 'asnlucas10:lucas10',
            loginUsername: 'agent',
            loginPassword: 'secret',
            sourceRef: 'asn:1'
          }
        ]
      })
    ).rejects.toThrow('Platform credential storage is unavailable');
  });
});
