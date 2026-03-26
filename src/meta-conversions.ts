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
  valueSignalCurrency: string;
  pageId?: string;
  whatsappBusinessAccountId?: string;
  testEventCode?: string;
}

export interface MetaDispatchResult {
  requestBody: MetaConversionsRequestBody;
  responseStatus: number;
  responseBody: unknown;
  fbtraceId: string | null;
}

export interface MetaConversionsDispatcher {
  dispatch(lease: MetaConversionLease): Promise<MetaDispatchResult>;
}

export class MetaConversionsDispatchError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly statusCode?: number,
    public readonly requestBody?: MetaConversionsRequestBody,
    public readonly responseBody?: unknown,
    public readonly fbtraceId?: string | null,
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

function normalizeCurrency(value: string | undefined): string {
  const normalized = value?.trim().toUpperCase() || 'ARS';
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new Error('META_VALUE_SIGNAL_CURRENCY must be a 3-letter ISO currency code');
  }

  return normalized;
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
  const apiVersion = normalizeApiVersion(env.META_API_VERSION?.trim() || 'v25.0');
  const actionSource = normalizeActionSource(env.META_ACTION_SOURCE || 'system_generated');
  const batchSize = normalizeBatchSize(env.META_BATCH_SIZE);
  const valueSignalCurrency = normalizeCurrency(env.META_VALUE_SIGNAL_CURRENCY);
  const pageId = env.META_PAGE_ID?.trim() || undefined;
  const whatsappBusinessAccountId = env.META_WHATSAPP_BUSINESS_ACCOUNT_ID?.trim() || undefined;
  const testEventCode = env.META_TEST_EVENT_CODE?.trim() || undefined;

  if (!enabled) {
    return {
      enabled: false,
      datasetId,
      accessToken,
      apiVersion,
      actionSource,
      batchSize,
      valueSignalCurrency,
      ...(pageId ? { pageId } : {}),
      ...(whatsappBusinessAccountId ? { whatsappBusinessAccountId } : {}),
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
    valueSignalCurrency,
    ...(pageId ? { pageId } : {}),
    ...(whatsappBusinessAccountId ? { whatsappBusinessAccountId } : {}),
    ...(testEventCode ? { testEventCode } : {})
  };
}

function readNumericSourcePayloadField(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

export function buildMetaConversionsRequestBody(
  lease: MetaConversionLease,
  config: Pick<
    MetaConversionsConfig,
    'testEventCode' | 'actionSource' | 'valueSignalCurrency' | 'pageId' | 'whatsappBusinessAccountId'
  >
): MetaConversionsRequestBody {
  const normalizedPhone = normalizePhoneForMeta(lease.phoneE164);
  const sourceContext = extractMetaSourceContext(lease.sourcePayload);
  const ownerKey = typeof lease.sourcePayload.owner_key === 'string' ? lease.sourcePayload.owner_key : null;
  const ownerLabel = typeof lease.sourcePayload.owner_label === 'string' ? lease.sourcePayload.owner_label : null;
  const userData = {
    ...(normalizedPhone ? { ph: [sha256(normalizedPhone)] } : {}),
    external_id: [normalizeExternalId(lease.ownerId, lease.clientId)],
    ...(sourceContext?.ctwaClid ? { ctwa_clid: sourceContext.ctwaClid } : {})
  };

  const monetaryValue = lease.metaEventName === 'Purchase'
    ? readNumericSourcePayloadField(lease.sourcePayload, 'first_day_cargado_hoy')
    : null;

  if (lease.metaEventName === 'Purchase' && monetaryValue == null) {
    throw new MetaConversionsDispatchError(
      'Purchase event is missing first_day_cargado_hoy in source payload',
      false,
      undefined
    );
  }

  const resolvedEventName =
    config.actionSource === 'business_messaging' && lease.metaEventName === 'Lead'
      ? 'LeadSubmitted'
      : lease.metaEventName;

  const businessMessagingUserData =
    config.actionSource === 'business_messaging'
      ? {
          ...(config.pageId ? { page_id: config.pageId } : {}),
          ...(config.whatsappBusinessAccountId
            ? { whatsapp_business_account_id: config.whatsappBusinessAccountId }
            : {})
        }
      : {};

  if (
    config.actionSource === 'business_messaging' &&
    !('page_id' in businessMessagingUserData) &&
    !('whatsapp_business_account_id' in businessMessagingUserData)
  ) {
    throw new MetaConversionsDispatchError(
      'business_messaging requires META_PAGE_ID or META_WHATSAPP_BUSINESS_ACCOUNT_ID',
      false
    );
  }

  const customData = Object.fromEntries(
    Object.entries({
      event_source: 'crm',
      ...(resolvedEventName === 'Lead' || resolvedEventName === 'LeadSubmitted'
        ? { lead_event_source: 'scrap2' }
        : {}),
      ...(lease.metaEventName === 'Purchase'
        ? {
            value: monetaryValue,
            currency: config.valueSignalCurrency
          }
        : {}),
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
      received_at: sourceContext?.receivedAt ?? null,
      owner_key: ownerKey,
      owner_label: ownerLabel,
      username: lease.username,
      first_day_report_date:
        typeof lease.sourcePayload.first_day_report_date === 'string'
          ? lease.sourcePayload.first_day_report_date
          : null,
      first_day_cargado_hoy: monetaryValue
    }).filter(([, value]) => value != null)
  );

  const event = {
    event_name: resolvedEventName,
    event_time: Math.floor(new Date(lease.eventTime).getTime() / 1000),
    event_id: lease.eventId,
    action_source: config.actionSource,
    ...(sourceContext?.referralSourceUrl ? { event_source_url: sourceContext.referralSourceUrl } : {}),
    ...(config.actionSource === 'business_messaging' ? { messaging_channel: 'whatsapp' } : {}),
    user_data: {
      ...userData,
      ...businessMessagingUserData
    },
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

  async dispatch(lease: MetaConversionLease): Promise<MetaDispatchResult> {
    if (!this.config.enabled) {
      throw new MetaConversionsDispatchError('Meta conversions are disabled', false);
    }

    const requestBody = buildMetaConversionsRequestBody(lease, this.config);
    const response = await this.fetchImpl(
      `https://graph.facebook.com/${this.config.apiVersion}/${this.config.datasetId}/events`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      }
    ).catch((error) => {
      throw new MetaConversionsDispatchError(
        error instanceof Error ? error.message : 'Could not reach Meta Graph API',
        true,
        undefined,
        requestBody,
        undefined,
        null,
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
    const fbtraceId =
      parsedBody && typeof parsedBody === 'object' && 'fbtrace_id' in parsedBody
        ? String((parsedBody as { fbtrace_id?: unknown }).fbtrace_id ?? '')
        : null;

    if (!response.ok) {
      const summary = summarizeErrorBody(parsedBody);
      throw new MetaConversionsDispatchError(
        `Meta Graph API rejected the event (${response.status}): ${summary}`,
        response.status >= 500,
        response.status,
        requestBody,
        parsedBody,
        fbtraceId
      );
    }

    return {
      requestBody,
      responseStatus: response.status,
      responseBody: parsedBody,
      fbtraceId
    };
  }
}
