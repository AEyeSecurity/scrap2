import { createHash } from 'node:crypto';
import type { MetaConversionLease } from './meta-conversions-store';
import { extractMetaSourceContext } from './meta-source-context';

export interface MetaConversionsConfig {
  enabled: boolean;
  datasetId: string;
  accessToken: string;
  apiVersion: string;
  actionSource: 'system_generated' | 'business_messaging';
  batchSize: number;
  testEventCode?: string;
}

export interface MetaConversionsDispatcher {
  dispatch(lease: MetaConversionLease): Promise<void>;
}

export class MetaConversionsDispatchError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly statusCode?: number,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'MetaConversionsDispatchError';
  }
}

interface MetaConversionsRequestBody {
  data: Array<Record<string, unknown>>;
  test_event_code?: string;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function normalizePhoneForMeta(phoneE164: string | null): string | null {
  if (!phoneE164) {
    return null;
  }

  const digits = phoneE164.replace(/\D/g, '');
  return digits.length >= 8 ? digits : null;
}

function normalizeExternalId(ownerId: string, clientId: string): string {
  return sha256(`${ownerId}:${clientId}`.toLowerCase());
}

function normalizeActionSource(value: string | undefined): 'system_generated' | 'business_messaging' {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === 'system_generated') {
    return 'system_generated';
  }
  if (normalized === 'business_messaging') {
    return 'business_messaging';
  }

  throw new Error('META_ACTION_SOURCE must be system_generated or business_messaging');
}

function normalizeBatchSize(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 1;
  }

  return Math.trunc(parsed);
}

function normalizeApiVersion(value: string): string {
  const normalized = value.trim();
  if (!/^v\d+\.\d+$/.test(normalized)) {
    throw new Error('META_API_VERSION must follow vNN.N');
  }

  return normalized;
}

function summarizeErrorBody(body: unknown): string {
  if (typeof body === 'string') {
    return body;
  }
  if (body && typeof body === 'object') {
    return JSON.stringify(body);
  }

  return String(body);
}

export function buildMetaConversionsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MetaConversionsConfig {
  const enabled = ['1', 'true', 'yes', 'on'].includes((env.META_ENABLED ?? '').trim().toLowerCase());
  const datasetId = env.META_DATASET_ID?.trim() ?? '';
  const accessToken = env.META_ACCESS_TOKEN?.trim() ?? '';
  const apiVersion = normalizeApiVersion(env.META_API_VERSION?.trim() || 'v23.0');
  const actionSource = normalizeActionSource(env.META_ACTION_SOURCE);
  const batchSize = normalizeBatchSize(env.META_BATCH_SIZE);
  const testEventCode = env.META_TEST_EVENT_CODE?.trim() || undefined;

  if (!enabled) {
    return {
      enabled: false,
      datasetId,
      accessToken,
      apiVersion,
      actionSource,
      batchSize,
      ...(testEventCode ? { testEventCode } : {})
    };
  }

  if (!datasetId || !accessToken) {
    throw new Error('META_DATASET_ID and META_ACCESS_TOKEN are required when META_ENABLED is true');
  }

  return {
    enabled,
    datasetId,
    accessToken,
    apiVersion,
    actionSource,
    batchSize,
    ...(testEventCode ? { testEventCode } : {})
  };
}

export function buildMetaConversionsRequestBody(
  lease: MetaConversionLease,
  config: Pick<MetaConversionsConfig, 'testEventCode' | 'actionSource'>
): MetaConversionsRequestBody {
  const normalizedPhone = normalizePhoneForMeta(lease.phoneE164);
  const sourceContext = extractMetaSourceContext(lease.sourcePayload);
  const ownerKey = typeof lease.sourcePayload.owner_key === 'string' ? lease.sourcePayload.owner_key : null;
  const ownerLabel = typeof lease.sourcePayload.owner_label === 'string' ? lease.sourcePayload.owner_label : null;
  const userData = {
    ...(normalizedPhone ? { ph: [sha256(normalizedPhone)] } : {}),
    external_id: [normalizeExternalId(lease.ownerId, lease.clientId)],
    ...(sourceContext?.ctwaClid ? { ctwa_clid: sourceContext.ctwaClid } : {}),
    ...(sourceContext?.clientIpAddress ? { client_ip_address: sourceContext.clientIpAddress } : {}),
    ...(sourceContext?.clientUserAgent ? { client_user_agent: sourceContext.clientUserAgent } : {})
  };

  const customData = Object.fromEntries(
    Object.entries({
      ctwa_clid: sourceContext?.ctwaClid ?? null,
      referral_source_id: sourceContext?.referralSourceId ?? null,
      referral_source_url: sourceContext?.referralSourceUrl ?? null,
      referral_headline: sourceContext?.referralHeadline ?? null,
      referral_body: sourceContext?.referralBody ?? null,
      referral_source_type: sourceContext?.referralSourceType ?? null,
      wa_id: sourceContext?.waId ?? null,
      message_sid: sourceContext?.messageSid ?? null,
      account_sid: sourceContext?.accountSid ?? null,
      profile_name: sourceContext?.profileName ?? null,
      client_ip_address: sourceContext?.clientIpAddress ?? null,
      client_user_agent: sourceContext?.clientUserAgent ?? null,
      received_at: sourceContext?.receivedAt ?? null,
      owner_key: ownerKey,
      owner_label: ownerLabel,
      username: lease.username
    }).filter(([, value]) => value != null)
  );

  const event = {
    event_name: lease.metaEventName,
    event_time: Math.floor(new Date(lease.eventTime).getTime() / 1000),
    event_id: lease.eventId,
    action_source: config.actionSource,
    user_data: userData,
    ...(Object.keys(customData).length > 0 ? { custom_data: customData } : {})
  };

  return {
    data: [event],
    ...(config.testEventCode ? { test_event_code: config.testEventCode } : {})
  };
}

export class MetaConversionsHttpDispatcher implements MetaConversionsDispatcher {
  constructor(
    private readonly config: MetaConversionsConfig,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async dispatch(lease: MetaConversionLease): Promise<void> {
    if (!this.config.enabled) {
      throw new MetaConversionsDispatchError('Meta conversions are disabled', false);
    }

    const response = await this.fetchImpl(
      `https://graph.facebook.com/${this.config.apiVersion}/${this.config.datasetId}/events`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(buildMetaConversionsRequestBody(lease, this.config))
      }
    ).catch((error) => {
      throw new MetaConversionsDispatchError(
        error instanceof Error ? error.message : 'Could not reach Meta Graph API',
        true,
        undefined,
        error instanceof Error ? { cause: error } : undefined
      );
    });

    const rawBody = await response.text();
    let parsedBody: unknown = rawBody;
    if (rawBody) {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        parsedBody = rawBody;
      }
    }

    if (!response.ok) {
      const summary = summarizeErrorBody(parsedBody);
      throw new MetaConversionsDispatchError(
        `Meta Graph API rejected the event (${response.status}): ${summary}`,
        response.status >= 500,
        response.status
      );
    }
  }
}
