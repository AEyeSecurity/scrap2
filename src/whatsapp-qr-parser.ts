import { normalizeUsername, normalizePhone } from './player-phone-store';

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;

export function normalizeCandidateUsername(value: string): string | null {
  try {
    const normalized = normalizeUsername(value, 'username');
    return USERNAME_PATTERN.test(normalized) ? normalized : null;
  } catch {
    return null;
  }
}

export function extractUsernameFromOutboundMessage(text: string | null | undefined): string | null {
  if (!text) {
    return null;
  }

  const match = text.match(/^\s*usuario\s*:\s*([^\s\r\n]+)/im);
  return match?.[1] ? normalizeCandidateUsername(match[1]) : null;
}

export function extractUsernameFromContactName(contactName: string | null | undefined): string | null {
  if (!contactName) {
    return null;
  }

  return normalizeCandidateUsername(contactName);
}

export function normalizeWhatsappJidPhone(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const [localPart = '', domain = ''] = value.split('@');
  if (domain.toLowerCase() === 'lid') {
    return null;
  }

  const rawLocalPart = localPart.split(':')[0] ?? '';
  const raw = rawLocalPart.replace(/[^0-9]/g, '');
  if (!raw) {
    return null;
  }

  try {
    return normalizePhone(`+${raw}`);
  } catch {
    return null;
  }
}

export function buildMessageExcerpt(text: string | null | undefined, maxLength = 240): string | null {
  const redacted =
    text?.replace(/((?:contrase(?:n|\u00f1)a|password)\s*:\s*)[^\s\r\n]+/gi, '$1[redacted]') ?? '';
  const normalized = redacted.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return null;
  }

  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}
