import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';
import type { MetaSourceContext, OwnerContext, PaginaCode } from './types';

type LandingSessionStoreErrorCode = 'CONFIGURATION' | 'VALIDATION' | 'CONFLICT' | 'INTERNAL';
export type LandingSessionStatus = 'pending' | 'claimed' | 'expired';

interface DatabaseErrorLike {
  code?: string | null;
  message: string;
}

export interface CreateLandingSessionInput {
  landingSessionId: string;
  contactEventId: string;
  messageText: string;
  messageKey: string;
  pagina: PaginaCode;
  ownerContext: Pick<OwnerContext, 'ownerKey' | 'ownerLabel'>;
  botPhoneE164: string;
  cashierPhoneE164: string;
  fbp?: string | null;
  fbc?: string | null;
  fbclid?: string | null;
  eventSourceUrl?: string | null;
  referrer?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmId?: string | null;
  utmCampaign?: string | null;
  utmContent?: string | null;
  utmTerm?: string | null;
  adsetId?: string | null;
  adId?: string | null;
  placement?: string | null;
  clientIpAddress?: string | null;
  clientUserAgent?: string | null;
  whatsappUrl: string;
}

export interface ClaimLandingSessionInput {
  messageText?: string | null;
  phoneE164: string;
  messageSid?: string | null;
  claimedAt?: string;
}

export interface LandingSessionRecord {
  id: string;
  landingSessionId: string;
  contactEventId: string;
  messageText: string;
  messageKey: string;
  status: LandingSessionStatus;
  pagina: PaginaCode;
  ownerKey: string;
  ownerLabel: string;
  botPhoneE164: string;
  cashierPhoneE164: string;
  fbp: string | null;
  fbc: string | null;
  fbclid: string | null;
  eventSourceUrl: string | null;
  referrer: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmId: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  adsetId: string | null;
  adId: string | null;
  placement: string | null;
  clientIpAddress: string | null;
  clientUserAgent: string | null;
  whatsappUrl: string;
  createdAt: string;
  claimedAt: string | null;
  claimedPhoneE164: string | null;
  claimedMessageSid: string | null;
}

export interface LandingSessionStore {
  createSession(input: CreateLandingSessionInput): Promise<LandingSessionRecord>;
  claimPendingSession(input: ClaimLandingSessionInput): Promise<LandingSessionRecord | null>;
}

export class LandingSessionStoreError extends Error {
  constructor(
    public readonly code: LandingSessionStoreErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'LandingSessionStoreError';
  }
}

interface LandingSessionRow {
  id: string;
  landing_session_id: string;
  contact_event_id: string;
  message_text: string;
  message_key: string;
  status: LandingSessionStatus;
  pagina: PaginaCode;
  owner_key: string;
  owner_label: string;
  bot_phone_e164: string;
  cashier_phone_e164: string;
  fbp: string | null;
  fbc: string | null;
  fbclid: string | null;
  event_source_url: string | null;
  referrer: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_id: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  adset_id: string | null;
  ad_id: string | null;
  placement: string | null;
  client_ip_address: string | null;
  client_user_agent: string | null;
  whatsapp_url: string;
  created_at: string;
  claimed_at: string | null;
  claimed_phone_e164: string | null;
  claimed_message_sid: string | null;
}

export function normalizeLandingMessageKey(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');

  return normalized.length > 0 ? normalized : null;
}

function mapRow(row: LandingSessionRow): LandingSessionRecord {
  return {
    id: row.id,
    landingSessionId: row.landing_session_id,
    contactEventId: row.contact_event_id,
    messageText: row.message_text,
    messageKey: row.message_key,
    status: row.status,
    pagina: row.pagina,
    ownerKey: row.owner_key,
    ownerLabel: row.owner_label,
    botPhoneE164: row.bot_phone_e164,
    cashierPhoneE164: row.cashier_phone_e164,
    fbp: row.fbp,
    fbc: row.fbc,
    fbclid: row.fbclid,
    eventSourceUrl: row.event_source_url,
    referrer: row.referrer,
    utmSource: row.utm_source,
    utmMedium: row.utm_medium,
    utmId: row.utm_id,
    utmCampaign: row.utm_campaign,
    utmContent: row.utm_content,
    utmTerm: row.utm_term,
    adsetId: row.adset_id,
    adId: row.ad_id,
    placement: row.placement,
    clientIpAddress: row.client_ip_address,
    clientUserAgent: row.client_user_agent,
    whatsappUrl: row.whatsapp_url,
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
    claimedPhoneE164: row.claimed_phone_e164,
    claimedMessageSid: row.claimed_message_sid
  };
}

function mapDatabaseError(error: DatabaseErrorLike, fallbackMessage: string): LandingSessionStoreError {
  if (error.code === '23505') {
    return new LandingSessionStoreError('CONFLICT', fallbackMessage);
  }
  if (error.code === '23514' || error.code === '22023' || error.code === '22P02') {
    return new LandingSessionStoreError('VALIDATION', fallbackMessage);
  }

  const detail = error.code ? `${fallbackMessage} (${error.code}: ${error.message})` : `${fallbackMessage}: ${error.message}`;
  return new LandingSessionStoreError('INTERNAL', detail);
}

function mapPostgrestError(error: PostgrestError, fallbackMessage: string): LandingSessionStoreError {
  return mapDatabaseError({ code: error.code, message: error.message }, fallbackMessage);
}

function toMetaSourceContext(row: LandingSessionRecord): MetaSourceContext {
  return {
    fbp: row.fbp,
    fbc: row.fbc,
    fbclid: row.fbclid,
    eventSourceUrl: row.eventSourceUrl,
    referrer: row.referrer,
    landingSessionId: row.landingSessionId,
    landingVariant: 'rda-luqui10-v1',
    ctaType: 'whatsapp_click',
    utmSource: row.utmSource,
    utmMedium: row.utmMedium,
    utmId: row.utmId,
    utmCampaign: row.utmCampaign,
    utmContent: row.utmContent,
    utmTerm: row.utmTerm,
    adsetId: row.adsetId,
    adId: row.adId,
    placement: row.placement,
    whatsappUrl: row.whatsappUrl,
    clientIpAddress: row.clientIpAddress,
    clientUserAgent: row.clientUserAgent
  };
}

export function landingSessionToSourceContext(row: LandingSessionRecord): MetaSourceContext {
  return toMetaSourceContext(row);
}

export class SupabaseLandingSessionStore implements LandingSessionStore {
  constructor(private readonly client: SupabaseClient) {}

  async createSession(input: CreateLandingSessionInput): Promise<LandingSessionRecord> {
    const { data, error } = await this.client
      .from('landing_sessions')
      .insert({
        landing_session_id: input.landingSessionId,
        contact_event_id: input.contactEventId,
        message_text: input.messageText,
        message_key: input.messageKey,
        status: 'pending',
        pagina: input.pagina,
        owner_key: input.ownerContext.ownerKey,
        owner_label: input.ownerContext.ownerLabel,
        bot_phone_e164: input.botPhoneE164,
        cashier_phone_e164: input.cashierPhoneE164,
        fbp: input.fbp ?? null,
        fbc: input.fbc ?? null,
        fbclid: input.fbclid ?? null,
        event_source_url: input.eventSourceUrl ?? null,
        referrer: input.referrer ?? null,
        utm_source: input.utmSource ?? null,
        utm_medium: input.utmMedium ?? null,
        utm_id: input.utmId ?? null,
        utm_campaign: input.utmCampaign ?? null,
        utm_content: input.utmContent ?? null,
        utm_term: input.utmTerm ?? null,
        adset_id: input.adsetId ?? null,
        ad_id: input.adId ?? null,
        placement: input.placement ?? null,
        client_ip_address: input.clientIpAddress ?? null,
        client_user_agent: input.clientUserAgent ?? null,
        whatsapp_url: input.whatsappUrl
      })
      .select('*')
      .single();

    if (error) {
      throw mapPostgrestError(error, 'Could not persist landing session');
    }

    return mapRow(data as LandingSessionRow);
  }

  async claimPendingSession(input: ClaimLandingSessionInput): Promise<LandingSessionRecord | null> {
    const messageKey = normalizeLandingMessageKey(input.messageText);
    if (!messageKey) {
      return null;
    }

    const nowIso = input.claimedAt ?? new Date().toISOString();
    const cutoffIso = new Date(Date.parse(nowIso) - 24 * 60 * 60 * 1000).toISOString();

    const { error: expireError } = await this.client
      .from('landing_sessions')
      .update({
        status: 'expired',
        updated_at: nowIso
      })
      .eq('status', 'pending')
      .eq('message_key', messageKey)
      .lt('created_at', cutoffIso);

    if (expireError) {
      throw mapPostgrestError(expireError, 'Could not expire stale landing sessions');
    }

    const { data, error } = await this.client
      .from('landing_sessions')
      .update({
        status: 'claimed',
        claimed_at: nowIso,
        claimed_phone_e164: input.phoneE164,
        claimed_message_sid: input.messageSid ?? null,
        updated_at: nowIso
      })
      .eq('status', 'pending')
      .eq('message_key', messageKey)
      .gte('created_at', cutoffIso)
      .select('*')
      .maybeSingle();

    if (error) {
      throw mapPostgrestError(error, 'Could not claim landing session');
    }

    return data ? mapRow(data as LandingSessionRow) : null;
  }
}

export function createLandingSessionStoreFromEnv(env: NodeJS.ProcessEnv = process.env): LandingSessionStore {
  const url = env.SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url || !serviceRoleKey) {
    throw new LandingSessionStoreError(
      'CONFIGURATION',
      'Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'
    );
  }

  if (serviceRoleKey.startsWith('sb_publishable_')) {
    throw new LandingSessionStoreError(
      'CONFIGURATION',
      'SUPABASE_SERVICE_ROLE_KEY is invalid: got a publishable key. Use the service_role/secret key.'
    );
  }

  return new SupabaseLandingSessionStore(
    createClient(url, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    })
  );
}
