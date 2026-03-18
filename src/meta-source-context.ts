import type { MetaSourceContext, OwnerContext } from './types';

export interface StoredMetaSourcePayload extends Record<string, unknown> {
  owner_key?: string;
  owner_label?: string;
  source_context?: Record<string, unknown>;
  ReferralCtwaClid?: string;
  ReferralSourceId?: string;
  ReferralSourceUrl?: string;
  ReferralHeadline?: string;
  ReferralBody?: string;
  ReferralSourceType?: string;
  WaId?: string;
  MessageSid?: string;
  AccountSid?: string;
  ProfileName?: string;
  ClientIpAddress?: string;
  ClientUserAgent?: string;
  ReceivedAt?: string;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (value == null) {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeOptionalTimestamp(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    return null;
  }

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

export function normalizeMetaSourceContext(input: MetaSourceContext | null | undefined): MetaSourceContext | null {
  if (!input) {
    return null;
  }

  const normalized: MetaSourceContext = {
    ctwaClid: normalizeOptionalText(input.ctwaClid),
    referralSourceId: normalizeOptionalText(input.referralSourceId),
    referralSourceUrl: normalizeOptionalText(input.referralSourceUrl),
    referralHeadline: normalizeOptionalText(input.referralHeadline),
    referralBody: normalizeOptionalText(input.referralBody),
    referralSourceType: normalizeOptionalText(input.referralSourceType),
    waId: normalizeOptionalText(input.waId),
    messageSid: normalizeOptionalText(input.messageSid),
    accountSid: normalizeOptionalText(input.accountSid),
    profileName: normalizeOptionalText(input.profileName),
    clientIpAddress: normalizeOptionalText(input.clientIpAddress),
    clientUserAgent: normalizeOptionalText(input.clientUserAgent),
    receivedAt: normalizeOptionalTimestamp(input.receivedAt)
  };

  return Object.values(normalized).some((value) => value != null) ? normalized : null;
}

function pruneNullish<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value != null)) as T;
}

export function isAttributableMetaSourceContext(input: MetaSourceContext | null | undefined): boolean {
  const normalized = normalizeMetaSourceContext(input);
  if (!normalized) {
    return false;
  }

  return normalized.referralSourceType?.toLowerCase() === 'ad' && typeof normalized.ctwaClid === 'string';
}

export function buildStoredMetaSourcePayload(input: {
  ownerContext?: Pick<OwnerContext, 'ownerKey' | 'ownerLabel'> | null;
  sourceContext?: MetaSourceContext | null;
}): StoredMetaSourcePayload {
  const sourceContext = normalizeMetaSourceContext(input.sourceContext);
  const payload = pruneNullish({
    owner_key: input.ownerContext?.ownerKey?.trim().toLowerCase() || null,
    owner_label: normalizeOptionalText(input.ownerContext?.ownerLabel),
    source_context: sourceContext ? pruneNullish({ ...sourceContext }) : null,
    ReferralCtwaClid: sourceContext?.ctwaClid ?? null,
    ReferralSourceId: sourceContext?.referralSourceId ?? null,
    ReferralSourceUrl: sourceContext?.referralSourceUrl ?? null,
    ReferralHeadline: sourceContext?.referralHeadline ?? null,
    ReferralBody: sourceContext?.referralBody ?? null,
    ReferralSourceType: sourceContext?.referralSourceType ?? null,
    WaId: sourceContext?.waId ?? null,
    MessageSid: sourceContext?.messageSid ?? null,
    AccountSid: sourceContext?.accountSid ?? null,
    ProfileName: sourceContext?.profileName ?? null,
    ClientIpAddress: sourceContext?.clientIpAddress ?? null,
    ClientUserAgent: sourceContext?.clientUserAgent ?? null,
    ReceivedAt: sourceContext?.receivedAt ?? null
  });

  return payload as StoredMetaSourcePayload;
}

function readPayloadField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' ? normalizeOptionalText(value) : null;
}

export function extractMetaSourceContext(payload: Record<string, unknown> | null | undefined): MetaSourceContext | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const nested = payload.source_context;
  const nestedSource =
    nested && typeof nested === 'object' && !Array.isArray(nested) ? (nested as Record<string, unknown>) : null;

  return normalizeMetaSourceContext({
    ctwaClid:
      readPayloadField(payload, 'ReferralCtwaClid') ??
      (nestedSource ? readPayloadField(nestedSource, 'ctwaClid') : null),
    referralSourceId:
      readPayloadField(payload, 'ReferralSourceId') ??
      (nestedSource ? readPayloadField(nestedSource, 'referralSourceId') : null),
    referralSourceUrl:
      readPayloadField(payload, 'ReferralSourceUrl') ??
      (nestedSource ? readPayloadField(nestedSource, 'referralSourceUrl') : null),
    referralHeadline:
      readPayloadField(payload, 'ReferralHeadline') ??
      (nestedSource ? readPayloadField(nestedSource, 'referralHeadline') : null),
    referralBody:
      readPayloadField(payload, 'ReferralBody') ??
      (nestedSource ? readPayloadField(nestedSource, 'referralBody') : null),
    referralSourceType:
      readPayloadField(payload, 'ReferralSourceType') ??
      (nestedSource ? readPayloadField(nestedSource, 'referralSourceType') : null),
    waId: readPayloadField(payload, 'WaId') ?? (nestedSource ? readPayloadField(nestedSource, 'waId') : null),
    messageSid:
      readPayloadField(payload, 'MessageSid') ?? (nestedSource ? readPayloadField(nestedSource, 'messageSid') : null),
    accountSid:
      readPayloadField(payload, 'AccountSid') ?? (nestedSource ? readPayloadField(nestedSource, 'accountSid') : null),
    profileName:
      readPayloadField(payload, 'ProfileName') ?? (nestedSource ? readPayloadField(nestedSource, 'profileName') : null),
    clientIpAddress:
      readPayloadField(payload, 'ClientIpAddress') ??
      (nestedSource ? readPayloadField(nestedSource, 'clientIpAddress') : null),
    clientUserAgent:
      readPayloadField(payload, 'ClientUserAgent') ??
      (nestedSource ? readPayloadField(nestedSource, 'clientUserAgent') : null),
    receivedAt:
      readPayloadField(payload, 'ReceivedAt') ?? (nestedSource ? readPayloadField(nestedSource, 'receivedAt') : null)
  });
}
