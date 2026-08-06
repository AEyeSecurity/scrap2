import { describe, expect, it } from 'vitest';
import { extractMessageSourceContext } from '../src/whatsapp-qr-manager';

describe('WhatsApp QR source attribution', () => {
  it('extracts CTWA acquisition metadata while preserving QR as the transport', () => {
    expect(
      extractMessageSourceContext({
        message: {
          ephemeralMessage: {
            message: {
              extendedTextMessage: {
                text: 'Hola',
                contextInfo: {
                  externalAdReply: {
                    ctwaClid: 'ctwa-123',
                    sourceId: 'ad-456',
                    sourceUrl: 'https://fb.me/ad-456',
                    title: 'Promoción',
                    body: 'Escribinos por WhatsApp',
                    sourceType: 'ad'
                  }
                }
              }
            }
          }
        }
      })
    ).toEqual({
      intakeTransport: 'whatsapp_qr',
      ctwaClid: 'ctwa-123',
      referralSourceId: 'ad-456',
      referralSourceUrl: 'https://fb.me/ad-456',
      referralHeadline: 'Promoción',
      referralBody: 'Escribinos por WhatsApp',
      referralSourceType: 'ad'
    });
  });

  it('does not invent acquisition metadata for an organic QR chat', () => {
    expect(extractMessageSourceContext({ message: { conversation: 'Hola' } })).toBeNull();
  });
});
