import { describe, expect, it, vi } from 'vitest';
import {
  buildMetaConversionsConfigFromEnv,
  buildMetaConversionsRequestBody,
  MetaConversionsDispatchError,
  MetaConversionsHttpDispatcher
} from '../src/meta-conversions';
import {
  MetaConversionsStoreError,
  SupabaseMetaConversionsStore,
  type MetaConversionLease,
  type MetaDispatchPersistenceInput,
  type MetaFailurePersistenceInput,
  type MetaConversionsStore
} from '../src/meta-conversions-store';
import { buildStoredMetaSourcePayload, extractMetaSourceContext, isAttributableMetaSourceContext } from '../src/meta-source-context';
import { MetaConversionsWorker } from '../src/meta-conversions-worker';
import { createLogger } from '../src/logging';

class FakeMetaConversionsStore implements MetaConversionsStore {
  public scanned: number[] = [];
  public retries: Array<MetaFailurePersistenceInput & { retryAfterSeconds: number }> = [];
  public failed: MetaFailurePersistenceInput[] = [];
  public sent: MetaDispatchPersistenceInput[] = [];
  public leases: MetaConversionLease[] = [];

  async enqueueLead(_input: {
    ownerId: string;
    clientId: string;
    phoneE164: string;
    ownerContext: { ownerKey: string; ownerLabel: string };
    sourceContext: Record<string, unknown>;
  }): Promise<void> {
    // not used here
  }

  async scanForValueSignals(limit: number): Promise<number> {
    this.scanned.push(limit);
    return 0;
  }

  async leaseNextEvent(_leaseSeconds: number, _maxAttempts: number): Promise<MetaConversionLease | null> {
    return this.leases.shift() ?? null;
  }

  async markSent(input: MetaDispatchPersistenceInput): Promise<void> {
    this.sent.push(input);
  }

  async markRetry(input: MetaFailurePersistenceInput & { retryAfterSeconds: number }): Promise<void> {
    this.retries.push(input);
  }

  async markFailed(input: MetaFailurePersistenceInput): Promise<void> {
    this.failed.push(input);
  }
}

function buildLease(overrides: Partial<MetaConversionLease> = {}): MetaConversionLease {
  return {
    id: 'meta-1',
    ownerId: 'owner-1',
    clientId: 'client-1',
    eventStage: 'lead',
    metaEventName: 'Lead',
    eventId: 'lead:test',
    eventTime: '2026-03-17T10:00:00.000Z',
    phoneE164: '+5491122334455',
    username: null,
    sourcePayload: buildStoredMetaSourcePayload({
      ownerContext: { ownerKey: 'wf_001', ownerLabel: 'Lucas 10' },
      sourceContext: {
        ctwaClid: 'clid-123',
        referralSourceId: '6904268485256',
        referralSourceUrl: 'https://fb.me/8cuWQu6gD',
        referralHeadline: 'ROYAL LUCK',
        referralBody: 'Quiero mi bono',
        referralSourceType: 'ad',
        waId: '5491138294407',
        messageSid: 'SM123',
        accountSid: 'AC123',
        profileName: 'Raul Rodriguez',
        clientIpAddress: '181.45.10.22',
        clientUserAgent: 'Mozilla/5.0',
        receivedAt: '2026-03-17T09:58:00.000Z'
      }
    }),
    attempts: 1,
    maxAttempts: 5,
    ...overrides
  };
}

describe('meta source context helpers', () => {
  it('builds and re-extracts Twilio source metadata', () => {
    const payload = buildStoredMetaSourcePayload({
      ownerContext: { ownerKey: 'WF_001', ownerLabel: ' Lucas 10 ' },
      sourceContext: {
        ctwaClid: ' clid-123 ',
        referralSourceType: ' ad ',
        referralHeadline: ' Royal Luck '
      }
    });

    expect(payload).toMatchObject({
      owner_key: 'wf_001',
      owner_label: 'Lucas 10',
      ReferralCtwaClid: 'clid-123',
      ReferralSourceType: 'ad',
      ReferralHeadline: 'Royal Luck'
    });
    expect(extractMetaSourceContext(payload)).toEqual({
      ctwaClid: 'clid-123',
      referralSourceId: null,
      referralSourceUrl: null,
      referralHeadline: 'Royal Luck',
      referralBody: null,
      referralSourceType: 'ad',
      waId: null,
      messageSid: null,
      accountSid: null,
      profileName: null,
      clientIpAddress: null,
      clientUserAgent: null,
      receivedAt: null
    });
    expect(isAttributableMetaSourceContext(extractMetaSourceContext(payload))).toBe(true);
  });
});

describe('meta conversions dispatcher', () => {
  it('builds a Graph API payload with hashed user data', () => {
    const body = buildMetaConversionsRequestBody(buildLease(), {
      testEventCode: 'TEST87269',
      actionSource: 'business_messaging',
      valueSignalCurrency: 'ARS'
    });
    expect(body.test_event_code).toBe('TEST87269');
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      event_name: 'Lead',
      event_id: 'lead:test',
      action_source: 'business_messaging'
    });
    expect(body.data[0]).not.toHaveProperty('event_source_url');
    expect(
      (
        body.data[0].user_data as {
          ph?: string[];
          external_id?: string[];
          ctwa_clid?: string;
        }
      ).ph?.[0]
    ).toMatch(/^[a-f0-9]{64}$/);
    expect(
      (
        body.data[0].user_data as {
          ph?: string[];
          external_id?: string[];
          ctwa_clid?: string;
        }
      ).external_id?.[0]
    ).toMatch(
      /^[a-f0-9]{64}$/
    );
    expect((body.data[0].user_data as { ctwa_clid?: string }).ctwa_clid).toBe('clid-123');
    expect((body.data[0].user_data as Record<string, unknown>).client_ip_address).toBeUndefined();
    expect((body.data[0].user_data as Record<string, unknown>).client_user_agent).toBeUndefined();
    expect((body.data[0].custom_data as { ctwa_clid?: string; received_at?: string }).ctwa_clid).toBe('clid-123');
    expect((body.data[0].custom_data as { ctwa_clid?: string; received_at?: string }).received_at).toBe(
      '2026-03-17T09:58:00.000Z'
    );
    expect((body.data[0].custom_data as Record<string, unknown>).client_ip_address).toBeUndefined();
    expect((body.data[0].custom_data as Record<string, unknown>).client_user_agent).toBeUndefined();
  });

  it('builds Purchase payloads with real value and currency', () => {
    const body = buildMetaConversionsRequestBody(
      buildLease({
        eventStage: 'value_signal',
        metaEventName: 'Purchase',
        eventId: 'value_signal:test',
        username: 'leandro034',
        sourcePayload: {
          ...buildLease().sourcePayload,
          first_day_report_date: '2026-03-25',
          first_day_cargado_hoy: 12500
        }
      }),
      {
        actionSource: 'business_messaging',
        valueSignalCurrency: 'ARS'
      }
    );

    expect(body.data[0]).toMatchObject({
      event_name: 'Purchase',
      event_id: 'value_signal:test',
      action_source: 'business_messaging',
      custom_data: {
        value: 12500,
        currency: 'ARS',
        first_day_report_date: '2026-03-25',
        first_day_cargado_hoy: 12500,
        username: 'leandro034'
      }
    });
  });

  it('posts events to Meta Graph API and includes the test event code', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ events_received: 1 })
    });
    const dispatcher = new MetaConversionsHttpDispatcher(
      {
        enabled: true,
        datasetId: '900004339427467',
        accessToken: 'secret-token',
        apiVersion: 'v23.0',
        actionSource: 'business_messaging',
        batchSize: 1,
        valueSignalCurrency: 'ARS',
        testEventCode: 'TEST87269'
      },
      fetchMock as unknown as typeof fetch
    );

    const result = await dispatcher.dispatch(buildLease());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://graph.facebook.com/v23.0/900004339427467/events');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toMatchObject({
      test_event_code: 'TEST87269'
    });
    expect(result.responseStatus).toBe(200);
  });

  it('marks 5xx responses as retryable dispatch errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ error: { message: 'temporary' } })
    });
    const dispatcher = new MetaConversionsHttpDispatcher(
      {
        enabled: true,
        datasetId: '900004339427467',
        accessToken: 'secret-token',
        apiVersion: 'v23.0',
        actionSource: 'business_messaging',
        batchSize: 1,
        valueSignalCurrency: 'ARS'
      },
      fetchMock as unknown as typeof fetch
    );

    await expect(dispatcher.dispatch(buildLease())).rejects.toMatchObject({
      retryable: true,
      statusCode: 500
    });
  });

  it('requires dataset/token only when META_ENABLED=true', () => {
    expect(() =>
      buildMetaConversionsConfigFromEnv({
        META_ENABLED: 'true',
        META_DATASET_ID: '',
        META_ACCESS_TOKEN: ''
      })
    ).toThrow(/META_DATASET_ID and META_ACCESS_TOKEN/i);
  });

  it('reads configurable action source and batch size from env', () => {
    expect(
      buildMetaConversionsConfigFromEnv({
        META_ENABLED: 'true',
        META_DATASET_ID: '900004339427467',
        META_ACCESS_TOKEN: 'secret-token',
        META_ACTION_SOURCE: 'business_messaging',
        META_BATCH_SIZE: '3'
      })
    ).toMatchObject({
      enabled: true,
      actionSource: 'business_messaging',
      batchSize: 3,
      valueSignalCurrency: 'ARS'
    });
  });
});

describe('meta conversions store', () => {
  it('stores lead attribution_key and stable event metadata from ctwa_clid', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const client = {
      from: vi.fn().mockReturnValue({
        insert
      })
    } as any;
    const store = new SupabaseMetaConversionsStore(client);

    await store.enqueueLead({
      ownerId: 'owner-1',
      clientId: 'client-1',
      phoneE164: '+5491122334455',
      ownerContext: { ownerKey: 'wf_001', ownerLabel: 'Lucas 10' },
      sourceContext: {
        ctwaClid: 'CLID-123',
        referralSourceType: 'ad',
        clientIpAddress: '181.45.10.22',
        clientUserAgent: 'Mozilla/5.0',
        receivedAt: '2026-03-17T09:58:00.000Z'
      }
    });

    expect(client.from).toHaveBeenCalledWith('meta_conversion_outbox');
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        owner_id: 'owner-1',
        client_id: 'client-1',
        event_stage: 'lead',
        meta_event_name: 'Lead',
        attribution_key: 'clid-123',
        event_time: '2026-03-17T09:58:00.000Z',
        phone_e164: '+5491122334455',
        source_payload: expect.objectContaining({
          ReferralCtwaClid: 'CLID-123',
          ClientIpAddress: '181.45.10.22',
          ClientUserAgent: 'Mozilla/5.0',
          ReceivedAt: '2026-03-17T09:58:00.000Z'
        })
      })
    );
    const insertedLead = insert.mock.calls[0][0] as { event_id: string };
    expect(insertedLead.event_id).toMatch(/^lead:[a-f0-9]{64}$/);
  });

  it('uses a different stable event id for a different ctwa_clid', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const client = {
      from: vi.fn().mockReturnValue({
        insert
      })
    } as any;
    const store = new SupabaseMetaConversionsStore(client);

    await store.enqueueLead({
      ownerId: 'owner-1',
      clientId: 'client-1',
      phoneE164: '+5491122334455',
      ownerContext: { ownerKey: 'wf_001', ownerLabel: 'Lucas 10' },
      sourceContext: {
        ctwaClid: 'clid-123',
        referralSourceType: 'ad'
      }
    });

    await store.enqueueLead({
      ownerId: 'owner-1',
      clientId: 'client-1',
      phoneE164: '+5491122334455',
      ownerContext: { ownerKey: 'wf_001', ownerLabel: 'Lucas 10' },
      sourceContext: {
        ctwaClid: 'clid-456',
        referralSourceType: 'ad'
      }
    });

    const firstInsert = insert.mock.calls[0][0] as { event_id: string; attribution_key: string };
    const secondInsert = insert.mock.calls[1][0] as { event_id: string; attribution_key: string };

    expect(firstInsert.attribution_key).toBe('clid-123');
    expect(secondInsert.attribution_key).toBe('clid-456');
    expect(firstInsert.event_id).not.toBe(secondInsert.event_id);
  });

  it('treats duplicate lead inserts as a no-op when the database returns 23505', async () => {
    const insert = vi.fn().mockResolvedValue({
      error: { code: '23505', message: 'duplicate key value violates unique constraint' }
    });
    const client = {
      from: vi.fn().mockReturnValue({
        insert
      })
    } as any;
    const store = new SupabaseMetaConversionsStore(client);

    await expect(
      store.enqueueLead({
        ownerId: 'owner-1',
        clientId: 'client-1',
        phoneE164: '+5491122334455',
        ownerContext: { ownerKey: 'wf_001', ownerLabel: 'Lucas 10' },
        sourceContext: {
          ctwaClid: 'clid-123',
          referralSourceType: 'ad'
        }
      })
    ).resolves.toBeUndefined();
  });

  it('rejects attributable lead enqueue when ctwa_clid is missing', async () => {
    const client = {
      from: vi.fn()
    } as any;
    const store = new SupabaseMetaConversionsStore(client);

    await expect(
      store.enqueueLead({
        ownerId: 'owner-1',
        clientId: 'client-1',
        phoneE164: '+5491122334455',
        ownerContext: { ownerKey: 'wf_001', ownerLabel: 'Lucas 10' },
        sourceContext: {
          referralSourceType: 'ad'
        }
      })
    ).rejects.toMatchObject<Partial<MetaConversionsStoreError>>({
      code: 'VALIDATION'
    });
  });
});

describe('meta conversions worker', () => {
  it('scans for qualified leads and marks successful dispatches as sent', async () => {
    const store = new FakeMetaConversionsStore();
    store.leases.push(buildLease({ id: 'meta-1' }));
    const dispatcher = {
      dispatch: vi.fn().mockResolvedValue({
        requestBody: { data: [{ event_name: 'Lead' }] },
        responseStatus: 200,
        responseBody: { events_received: 1 },
        fbtraceId: 'TRACE123'
      })
    };
    const worker = new MetaConversionsWorker(store, dispatcher, createLogger('silent', false), {
      concurrency: 1,
      pollMs: 10,
      leaseSeconds: 60,
      maxAttempts: 5,
      scanLimit: 25
    });

    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await worker.stop();

    expect(store.scanned[0]).toBe(25);
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(store.sent).toEqual([
      {
        id: 'meta-1',
        requestPayload: { data: [{ event_name: 'Lead' }] },
        responseStatus: 200,
        responseBody: { events_received: 1 },
        fbtraceId: 'TRACE123'
      }
    ]);
    expect(store.failed).toEqual([]);
    expect(store.retries).toEqual([]);
  });

  it('retries retryable dispatch errors and fails non-retryable ones', async () => {
    const retryStore = new FakeMetaConversionsStore();
    retryStore.leases.push(buildLease({ id: 'meta-retry', attempts: 1, maxAttempts: 5 }));
    const retryWorker = new MetaConversionsWorker(
      retryStore,
      {
        dispatch: vi.fn().mockRejectedValue(new MetaConversionsDispatchError('temporary', true, 500))
      },
      createLogger('silent', false),
      {
        concurrency: 1,
        pollMs: 10,
        leaseSeconds: 60,
        maxAttempts: 5,
        scanLimit: 10
      }
    );

    retryWorker.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await retryWorker.stop();

    expect(retryStore.retries).toEqual([
      expect.objectContaining({
        id: 'meta-retry',
        error: 'temporary',
        retryAfterSeconds: 60
      })
    ]);

    const failedStore = new FakeMetaConversionsStore();
    failedStore.leases.push(buildLease({ id: 'meta-failed', attempts: 1, maxAttempts: 5 }));
    const failedWorker = new MetaConversionsWorker(
      failedStore,
      {
        dispatch: vi.fn().mockRejectedValue(new MetaConversionsDispatchError('bad request', false, 400))
      },
      createLogger('silent', false),
      {
        concurrency: 1,
        pollMs: 10,
        leaseSeconds: 60,
        maxAttempts: 5,
        scanLimit: 10
      }
    );

    failedWorker.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await failedWorker.stop();

    expect(failedStore.failed).toEqual([expect.objectContaining({ id: 'meta-failed', error: 'bad request' })]);
  });
});
