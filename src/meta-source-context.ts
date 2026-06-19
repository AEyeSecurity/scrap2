import type { MetaCustomerData, MetaSourceContext, OwnerContext } from './types';

export interface StoredMetaSourcePayload extends Record<string, unknown> {
  owner_key?: string;
  owner_label?: string;
  customer_data?: Record<string, unknown>;
  source_context?: Record<string, unknown>;
  ReferralCtwaClid?: string;
  Fbp?: string;
  Fbc?: string;
  Fbclid?: string;
  ReferralSourceId?: string;
  ReferralSourceUrl?: string;
  ReferralHeadline?: string;
  ReferralBody?: string;
  ReferralSourceType?: string;
  EventSourceUrl?: string;
  Referrer?: string;
  LandingSessionId?: string;
  LandingVariant?: string;
  CtaType?: string;
  UtmSource?: string;
  UtmMedium?: string;
  UtmId?: string;
  UtmCampaign?: string;
  UtmContent?: string;
  UtmTerm?: string;
  AdsetId?: string;
  AdId?: string;
  Placement?: string;
  ConsentMarketing?: boolean;
  ConsentTimestamp?: string;
  WhatsappUrl?: string;
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

export function normalizeMetaCustomerData(input: MetaCustomerData | null | undefined): MetaCustomerData | null {
  if (!input) {
    return null;
  }

  const normalized: MetaCustomerData = {
    email: normalizeOptionalText(input.email)?.toLowerCase() ?? null,
    firstName: normalizeOptionalText(input.firstName),
    lastName: normalizeOptionalText(input.lastName),
    fullName: normalizeOptionalText(input.fullName)
  };

  return Object.values(normalized).some((value) => value != null) ? normalized : null;
}

function normalizeMetaDynamicName(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    return null;
  }

  try {
    return decodeURIComponent(normalized.replace(/\+/g, ' ')).trim() || null;
  } catch {
    return normalized;
  }
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

function normalizeOptionalBoolean(value: boolean | null | undefined): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export function normalizeMetaSourceContext(input: MetaSourceContext | null | undefined): MetaSourceContext | null {
  if (!input) {
    return null;
  }

  const normalized: MetaSourceContext = {
    ctwaClid: normalizeOptionalText(input.ctwaClid),
    fbp: normalizeOptionalText(input.fbp),
    fbc: normalizeOptionalText(input.fbc),
    fbclid: normalizeOptionalText(input.fbclid),
    referralSourceId: normalizeOptionalText(input.referralSourceId),
    referralSourceUrl: normalizeOptionalText(input.referralSourceUrl),
    referralHeadline: normalizeOptionalText(input.referralHeadline),
    referralBody: normalizeOptionalText(input.referralBody),
    referralSourceType: normalizeOptionalText(input.referralSourceType),
    eventSourceUrl: normalizeOptionalText(input.eventSourceUrl),
    referrer: normalizeOptionalText(input.referrer),
    landingSessionId: normalizeOptionalText(input.landingSessionId),
    landingVariant: normalizeOptionalText(input.landingVariant),
    ctaType: normalizeOptionalText(input.ctaType),
    utmSource: normalizeOptionalText(input.utmSource),
    utmMedium: normalizeOptionalText(input.utmMedium),
    utmId: normalizeOptionalText(input.utmId),
    utmCampaign: normalizeMetaDynamicName(input.utmCampaign),
    utmContent: normalizeMetaDynamicName(input.utmContent),
    utmTerm: normalizeMetaDynamicName(input.utmTerm),
    adsetId: normalizeOptionalText(input.adsetId),
    adId: normalizeOptionalText(input.adId),
    placement: normalizeOptionalText(input.placement),
    consentMarketing: normalizeOptionalBoolean(input.consentMarketing),
    consentTimestamp: normalizeOptionalTimestamp(input.consentTimestamp),
    whatsappUrl: normalizeOptionalText(input.whatsappUrl),
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

export function isLandingMetaSourceContext(input: MetaSourceContext | null | undefined): boolean {
  const normalized = normalizeMetaSourceContext(input);
  return typeof normalized?.landingSessionId === 'string' && normalized.landingSessionId.length > 0;
}

export function buildStoredMetaSourcePayload(input: {
  ownerContext?: Pick<OwnerContext, 'ownerKey' | 'ownerLabel'> | null;
  sourceContext?: MetaSourceContext | null;
  customerData?: MetaCustomerData | null;
}): StoredMetaSourcePayload {
  const sourceContext = normalizeMetaSourceContext(input.sourceContext);
  const customerData = normalizeMetaCustomerData(input.customerData);
  const payload = pruneNullish({
    owner_key: input.ownerContext?.ownerKey?.trim().toLowerCase() || null,
    owner_label: normalizeOptionalText(input.ownerContext?.ownerLabel),
    customer_data: customerData ? pruneNullish({ ...customerData }) : null,
    source_context: sourceContext ? pruneNullish({ ...sourceContext }) : null,
    ReferralCtwaClid: sourceContext?.ctwaClid ?? null,
    Fbp: sourceContext?.fbp ?? null,
    Fbc: sourceContext?.fbc ?? null,
    Fbclid: sourceContext?.fbclid ?? null,
    ReferralSourceId: sourceContext?.referralSourceId ?? null,
    ReferralSourceUrl: sourceContext?.referralSourceUrl ?? null,
    ReferralHeadline: sourceContext?.referralHeadline ?? null,
    ReferralBody: sourceContext?.referralBody ?? null,
    ReferralSourceType: sourceContext?.referralSourceType ?? null,
    EventSourceUrl: sourceContext?.eventSourceUrl ?? null,
    Referrer: sourceContext?.referrer ?? null,
    LandingSessionId: sourceContext?.landingSessionId ?? null,
    LandingVariant: sourceContext?.landingVariant ?? null,
    CtaType: sourceContext?.ctaType ?? null,
    UtmSource: sourceContext?.utmSource ?? null,
    UtmMedium: sourceContext?.utmMedium ?? null,
    UtmId: sourceContext?.utmId ?? null,
    UtmCampaign: sourceContext?.utmCampaign ?? null,
    UtmContent: sourceContext?.utmContent ?? null,
    UtmTerm: sourceContext?.utmTerm ?? null,
    AdsetId: sourceContext?.adsetId ?? null,
    AdId: sourceContext?.adId ?? null,
    Placement: sourceContext?.placement ?? null,
    ConsentMarketing: sourceContext?.consentMarketing ?? null,
    ConsentTimestamp: sourceContext?.consentTimestamp ?? null,
    WhatsappUrl: sourceContext?.whatsappUrl ?? null,
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

function readPayloadBooleanField(payload: Record<string, unknown>, key: string): boolean | null {
  const value = payload[key];
  return typeof value === 'boolean' ? value : null;
}

export function extractMetaCustomerData(payload: Record<string, unknown> | null | undefined): MetaCustomerData | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const nested = payload.customer_data;
  const customerData =
    nested && typeof nested === 'object' && !Array.isArray(nested) ? (nested as Record<string, unknown>) : null;
  if (!customerData) {
    return null;
  }

  return normalizeMetaCustomerData({
    email: readPayloadField(customerData, 'email'),
    firstName: readPayloadField(customerData, 'firstName'),
    lastName: readPayloadField(customerData, 'lastName'),
    fullName: readPayloadField(customerData, 'fullName')
  });
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
    fbp: readPayloadField(payload, 'Fbp') ?? (nestedSource ? readPayloadField(nestedSource, 'fbp') : null),
    fbc: readPayloadField(payload, 'Fbc') ?? (nestedSource ? readPayloadField(nestedSource, 'fbc') : null),
    fbclid: readPayloadField(payload, 'Fbclid') ?? (nestedSource ? readPayloadField(nestedSource, 'fbclid') : null),
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
    eventSourceUrl:
      readPayloadField(payload, 'EventSourceUrl') ??
      (nestedSource ? readPayloadField(nestedSource, 'eventSourceUrl') : null),
    referrer:
      readPayloadField(payload, 'Referrer') ?? (nestedSource ? readPayloadField(nestedSource, 'referrer') : null),
    landingSessionId:
      readPayloadField(payload, 'LandingSessionId') ??
      (nestedSource ? readPayloadField(nestedSource, 'landingSessionId') : null),
    landingVariant:
      readPayloadField(payload, 'LandingVariant') ??
      (nestedSource ? readPayloadField(nestedSource, 'landingVariant') : null),
    ctaType: readPayloadField(payload, 'CtaType') ?? (nestedSource ? readPayloadField(nestedSource, 'ctaType') : null),
    utmSource:
      readPayloadField(payload, 'UtmSource') ?? (nestedSource ? readPayloadField(nestedSource, 'utmSource') : null),
    utmMedium:
      readPayloadField(payload, 'UtmMedium') ?? (nestedSource ? readPayloadField(nestedSource, 'utmMedium') : null),
    utmId: readPayloadField(payload, 'UtmId') ?? (nestedSource ? readPayloadField(nestedSource, 'utmId') : null),
    utmCampaign:
      readPayloadField(payload, 'UtmCampaign') ??
      (nestedSource ? readPayloadField(nestedSource, 'utmCampaign') : null),
    utmContent:
      readPayloadField(payload, 'UtmContent') ?? (nestedSource ? readPayloadField(nestedSource, 'utmContent') : null),
    utmTerm:
      readPayloadField(payload, 'UtmTerm') ?? (nestedSource ? readPayloadField(nestedSource, 'utmTerm') : null),
    adsetId:
      readPayloadField(payload, 'AdsetId') ?? (nestedSource ? readPayloadField(nestedSource, 'adsetId') : null),
    adId: readPayloadField(payload, 'AdId') ?? (nestedSource ? readPayloadField(nestedSource, 'adId') : null),
    placement:
      readPayloadField(payload, 'Placement') ?? (nestedSource ? readPayloadField(nestedSource, 'placement') : null),
    consentMarketing:
      readPayloadBooleanField(payload, 'ConsentMarketing') ??
      (nestedSource ? readPayloadBooleanField(nestedSource, 'consentMarketing') : null),
    consentTimestamp:
      readPayloadField(payload, 'ConsentTimestamp') ??
      (nestedSource ? readPayloadField(nestedSource, 'consentTimestamp') : null),
    whatsappUrl:
      readPayloadField(payload, 'WhatsappUrl') ??
      (nestedSource ? readPayloadField(nestedSource, 'whatsappUrl') : null),
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
