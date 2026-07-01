import { describe, expect, it } from 'vitest';
import { buildWhatsappQrPhoneQueue } from '../src/whatsapp-qr-dashboard';
import type { WhatsappQrMatchRecord, WhatsappQrMessageRecord, WhatsappQrMonthClientRecord } from '../src/whatsapp-qr-store';

const baseMonthClient: WhatsappQrMonthClientRecord = {
  clientId: 'client-1',
  linkId: 'link-1',
  phoneE164: '+5493511111111',
  assignedUsername: null
};

function buildMessage(overrides: Partial<WhatsappQrMessageRecord>): WhatsappQrMessageRecord {
  return {
    id: 'message-1',
    sessionId: 'session-1',
    ownerId: 'owner-1',
    direction: 'contact_sync',
    clientPhoneE164: '+5493511111111',
    contactName: 'player_contact',
    pushName: null,
    textExcerpt: null,
    candidateUsername: 'player_contact',
    matchSource: 'contact_name',
    messageTimestamp: '2026-07-01T15:43:00.000Z',
    createdAt: '2026-07-01T15:43:00.000Z',
    ...overrides
  };
}

function buildMatch(overrides: Partial<WhatsappQrMatchRecord>): WhatsappQrMatchRecord {
  return {
    id: 'match-1',
    sessionId: 'session-1',
    ownerId: 'owner-1',
    messageId: 'message-1',
    pagina: 'RdA',
    clientPhoneE164: '+5493511111111',
    username: 'player_contact',
    source: 'contact_name',
    status: 'candidate',
    rdaValidatedAt: null,
    assignedAt: null,
    errorMessage: null,
    createdAt: '2026-07-01T15:43:00.000Z',
    updatedAt: '2026-07-01T15:43:00.000Z',
    ...overrides
  };
}

describe('buildWhatsappQrPhoneQueue', () => {
  it('keeps currently assigned phones as assigned even if a newer candidate exists', () => {
    const result = buildWhatsappQrPhoneQueue({
      monthClients: [{ ...baseMonthClient, assignedUsername: 'player_real' }],
      messages: [buildMessage({ candidateUsername: 'player_newer', createdAt: '2026-07-02T12:00:00.000Z' })],
      matches: [buildMatch({ username: 'player_newer', createdAt: '2026-07-02T12:00:00.000Z' })]
    });

    expect(result.summary.assigned).toBe(1);
    expect(result.summary.review).toBe(0);
    expect(result.queue[0]).toMatchObject({
      status: 'assigned',
      assignedUsername: 'player_real',
      suggestedUsername: 'player_newer'
    });
  });

  it('prefers the contact signal when contact and outbound disagree', () => {
    const result = buildWhatsappQrPhoneQueue({
      monthClients: [baseMonthClient],
      messages: [
        buildMessage({
          id: 'message-contact',
          candidateUsername: 'player_contact',
          matchSource: 'contact_name',
          createdAt: '2026-07-01T15:43:00.000Z'
        }),
        buildMessage({
          id: 'message-outbound',
          direction: 'outbound',
          candidateUsername: 'player_chat',
          matchSource: 'outbound_message',
          createdAt: '2026-07-01T15:44:00.000Z'
        })
      ],
      matches: [buildMatch({ status: 'candidate', createdAt: '2026-07-01T15:44:00.000Z' })]
    });

    expect(result.queue[0]).toMatchObject({
      status: 'review',
      reviewReason: 'detected_unassigned',
      contactCandidateUsername: 'player_contact',
      outboundCandidateUsername: 'player_chat',
      suggestedUsername: 'player_contact',
      primarySignalSource: 'contact_name'
    });
  });

  it('maps not found and no-signal rows to the expected review reasons', () => {
    const result = buildWhatsappQrPhoneQueue({
      monthClients: [
        baseMonthClient,
        { ...baseMonthClient, clientId: 'client-2', linkId: 'link-2', phoneE164: '+5493512222222' }
      ],
      messages: [],
      matches: [
        buildMatch({
          clientPhoneE164: '+5493511111111',
          status: 'not_found',
          errorMessage: 'No se ha encontrado el usuario player_contact'
        })
      ]
    });

    expect(result.summary.notFound).toBe(1);
    expect(result.summary.noSignal).toBe(1);
    expect(result.queue).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phoneE164: '+5493511111111', reviewReason: 'not_found' }),
        expect.objectContaining({ phoneE164: '+5493512222222', reviewReason: 'no_signal' })
      ])
    );
  });
});
