import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { SupabaseLandingSessionStore } from '../src/landing-session-store';

const claimedRow = {
  id: 'landing-row-1',
  landing_session_id: 'session-1',
  contact_event_id: 'contact-1',
  landing_token: 'ABCDEFG2',
  message_text: 'Hola, quiero mi usuario con mi bono: ABCDEFG2',
  message_key: 'hola quiero mi usuario con mi bono abcdefg2',
  status: 'claimed',
  pagina: 'RdA',
  owner_key: 'central:rls',
  owner_label: 'Leandro central',
  landing_variant: 'rda-central-auto-v1',
  bot_phone_e164: '+5491125671037',
  cashier_phone_e164: '+5491125671037',
  fbp: null,
  fbc: null,
  fbclid: null,
  event_source_url: null,
  referrer: null,
  utm_source: null,
  utm_medium: null,
  utm_id: null,
  utm_campaign: null,
  utm_content: null,
  utm_term: null,
  adset_id: null,
  ad_id: null,
  placement: null,
  client_ip_address: null,
  client_user_agent: null,
  whatsapp_url: 'https://wa.me/5491125671037?text=hola',
  created_at: '2026-09-02T12:00:00.000Z',
  claimed_at: '2026-09-02T12:01:00.000Z',
  claimed_phone_e164: '+5493515550101',
  claimed_message_sid: 'SM-SAME'
};

function fluentBuilder() {
  const builder: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ['update', 'select', 'eq', 'gte', 'lt']) {
    builder[method] = vi.fn(() => builder);
  }
  builder.maybeSingle = vi.fn();
  return builder;
}

describe('SupabaseLandingSessionStore', () => {
  it('returns the already claimed session only for the same phone and MessageSid', async () => {
    const expire = fluentBuilder();
    expire.lt.mockResolvedValue({ error: null });
    const claim = fluentBuilder();
    claim.maybeSingle.mockResolvedValue({ data: null, error: null });
    const readClaimed = fluentBuilder();
    readClaimed.maybeSingle.mockResolvedValue({ data: claimedRow, error: null });
    const client = { from: vi.fn().mockReturnValueOnce(expire).mockReturnValueOnce(claim).mockReturnValueOnce(readClaimed) };
    const store = new SupabaseLandingSessionStore(client as unknown as SupabaseClient);

    const result = await store.claimPendingSession({
      landingToken: 'ABCDEFG2',
      phoneE164: '+5493515550101',
      messageSid: 'SM-SAME',
      claimedAt: '2026-09-02T12:02:00.000Z'
    });

    expect(result).toMatchObject({
      landingSessionId: 'session-1',
      status: 'claimed',
      claimedPhoneE164: '+5493515550101',
      claimedMessageSid: 'SM-SAME'
    });
    expect(readClaimed.eq).toHaveBeenCalledWith('status', 'claimed');
    expect(readClaimed.eq).toHaveBeenCalledWith('landing_token', 'ABCDEFG2');
    expect(readClaimed.eq).toHaveBeenCalledWith('claimed_phone_e164', '+5493515550101');
    expect(readClaimed.eq).toHaveBeenCalledWith('claimed_message_sid', 'SM-SAME');
  });

  it('does not recover an already claimed session when MessageSid is absent', async () => {
    const expire = fluentBuilder();
    expire.lt.mockResolvedValue({ error: null });
    const claim = fluentBuilder();
    claim.maybeSingle.mockResolvedValue({ data: null, error: null });
    const client = { from: vi.fn().mockReturnValueOnce(expire).mockReturnValueOnce(claim) };
    const store = new SupabaseLandingSessionStore(client as unknown as SupabaseClient);

    await expect(store.claimPendingSession({
      landingToken: 'ABCDEFG2',
      phoneE164: '+5493515550101',
      messageSid: null,
      claimedAt: '2026-09-02T12:02:00.000Z'
    })).resolves.toBeNull();
    expect(client.from).toHaveBeenCalledTimes(2);
  });
});
