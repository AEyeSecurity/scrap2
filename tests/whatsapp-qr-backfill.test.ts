import { describe, expect, it } from 'vitest';
import { summarizeWhatsappQrBackfill } from '../src/whatsapp-qr-backfill';

describe('WhatsApp QR month backfill summary', () => {
  it('classifies direct matches, chat matches and unmatched phones', () => {
    const result = summarizeWhatsappQrBackfill('luqui10:luqui10', '2026-06-01', [
      {
        phone: '+5491111111111',
        contactName: 'player_direct',
        seenContact: true,
        seenOutbound: false,
        direct: {
          source: 'contact_name',
          candidateUsername: 'player_direct',
          status: 'assigned',
          errorMessage: null
        },
        chatAttempts: []
      },
      {
        phone: '+5492222222222',
        contactName: 'Nombre Libre',
        seenContact: true,
        seenOutbound: true,
        direct: {
          source: 'contact_name',
          candidateUsername: null,
          status: 'no_candidate',
          errorMessage: null
        },
        chatAttempts: [
          {
            source: 'outbound_message',
            candidateUsername: 'player_chat',
            status: 'assigned',
            errorMessage: null
          }
        ]
      },
      {
        phone: '+5493333333333',
        contactName: null,
        seenContact: false,
        seenOutbound: false,
        direct: {
          source: 'contact_name',
          candidateUsername: null,
          status: 'not_seen',
          errorMessage: null
        },
        chatAttempts: []
      }
    ]);

    expect(result.summary).toMatchObject({
      totalPhones: 3,
      directMatched: 1,
      chatMatched: 1,
      unmatched: 1,
      unmatchedNoSignal: 1
    });
    expect(result.phones.map((phone) => [phone.phone, phone.classification])).toEqual([
      ['+5491111111111', 'direct'],
      ['+5492222222222', 'chat'],
      ['+5493333333333', 'unmatched']
    ]);
  });
});
