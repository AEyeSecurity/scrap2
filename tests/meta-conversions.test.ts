import { describe, expect, it, vi } from 'vitest';
import {
  buildMetaConversionsConfigFromEnv,
  buildMetaConversionsRequestBody,
  MetaConversionsDispatchError,
  MetaConversionsHttpDispatcher
} from '../src/meta-conversions';
import type { MetaConversionLease, MetaConversionsStore } from '../src/meta-conversions-store';
import { buildStoredMetaSourcePayload, extractMetaSourceContext, isAttributableMetaSourceContext } from '../src/meta-source-context';
import { MetaConversionsWorker } from '../src/meta-conversions-worker';
import { createLogger } from '../src/logging';

class FakeMetaConversionsStore implements MetaConversionsStore {
  public scanned: number[] = [];
  public retries: Array<{ id: string; error: string; retryAfterSeconds: number }> = [];
  public failed: Array<{ id: string; error: string }> = [];
  public sent: string[] = [];
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

  async scanForQualifiedLeads(limit: number): Promise<number> {
    this.scanned.push(limit);
    return 0;
  }

  async leaseNextEvent(_leaseSeconds: number, _maxAttempts: number): Promise<MetaConversionLease | null> {
    return this.leases.shift() ?? null;
  }

  async markSent(id: string): Promise<void> {
    this.sent.push(id);
  }

  async markRetry(id: string, error: string, retryAfterSeconds: number): Promise<void> {
    this.retries.push({ id, error, retryAfterSeconds });
  }

  async markFailed(id: string, error: string): Promise<void> {
    this.failed.push({ id, error });
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
        profileName: 'Raul Rodriguez'
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
      profileName: null
    });
    expect(isAttributableMetaSourceContext(extractMetaSourceContext(payload))).toBe(true);
  });
});

describe('meta conversions dispatcher', () => {
  it('builds a Graph API payload with hashed user data', () => {
    const body = buildMetaConversionsRequestBody(buildLease(), { testEventCode: 'TEST87269' });
    expect(body.test_event_code).toBe('TEST87269');
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      event_name: 'Lead',
      event_id: 'lead:test',
      action_source: 'system_generated'
    });
    expect(body.data[0]).not.toHaveProperty('event_source_url');
    expect((body.data[0].user_data as { ph?: string[]; external_id?: string[] }).ph?.[0]).toMatch(/^[a-f0-9]{64}$/);
    expect((body.data[0].user_data as { ph?: string[]; external_id?: string[] }).external_id?.[0]).toMatch(
      /^[a-f0-9]{64}$/
    );
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
        testEventCode: 'TEST87269'
      },
      fetchMock as unknown as typeof fetch
    );

    await dispatcher.dispatch(buildLease());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://graph.facebook.com/v23.0/900004339427467/events');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toMatchObject({
      test_event_code: 'TEST87269'
    });
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
        apiVersion: 'v23.0'
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
});

describe('meta conversions worker', () => {
  it('scans for qualified leads and marks successful dispatches as sent', async () => {
    const store = new FakeMetaConversionsStore();
    store.leases.push(buildLease({ id: 'meta-1' }));
    const dispatcher = {
      dispatch: vi.fn().mockResolvedValue(undefined)
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
    expect(store.sent).toEqual(['meta-1']);
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
      {
        id: 'meta-retry',
        error: 'temporary',
        retryAfterSeconds: 60
      }
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

    expect(failedStore.failed).toEqual([{ id: 'meta-failed', error: 'bad request' }]);
  });
});
