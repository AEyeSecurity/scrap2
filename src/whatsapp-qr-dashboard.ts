import type {
  WhatsappQrMatchRecord,
  WhatsappQrMatchSource,
  WhatsappQrMessageRecord,
  WhatsappQrMonthClientRecord
} from './whatsapp-qr-store';

export type WhatsappQrQueueStatus = 'assigned' | 'review';
export type WhatsappQrReviewReason =
  | 'no_signal'
  | 'detected_unassigned'
  | 'not_found'
  | 'conflict'
  | 'technical_error';

export interface WhatsappQrPhoneQueueRow {
  clientId: string;
  linkId: string | null;
  phoneE164: string;
  status: WhatsappQrQueueStatus;
  reviewReason: WhatsappQrReviewReason | null;
  assignedUsername: string | null;
  suggestedUsername: string | null;
  contactCandidateUsername: string | null;
  outboundCandidateUsername: string | null;
  primarySignalSource: WhatsappQrMatchSource | null;
  lastSignalAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
}

export interface WhatsappQrQueueSummary {
  totalPhones: number;
  assigned: number;
  review: number;
  ignored: number;
  noSignal: number;
  detectedUnassigned: number;
  notFound: number;
  conflict: number;
  technicalError: number;
}

function compareIsoDesc(left: string | null | undefined, right: string | null | undefined): number {
  const leftValue = left ?? '';
  const rightValue = right ?? '';
  return rightValue.localeCompare(leftValue);
}

function pickLatest<T>(items: T[], getIso: (item: T) => string | null | undefined): T | null {
  let selected: T | null = null;
  let selectedIso: string | null | undefined = null;

  for (const item of items) {
    const currentIso = getIso(item);
    if (!selected || compareIsoDesc(selectedIso, currentIso) > 0) {
      selected = item;
      selectedIso = currentIso;
    }
  }

  return selected;
}

function messageSignalAt(message: WhatsappQrMessageRecord): string | null {
  return message.messageTimestamp ?? message.createdAt;
}

function matchAttemptAt(match: WhatsappQrMatchRecord): string | null {
  return match.assignedAt ?? match.updatedAt ?? match.rdaValidatedAt ?? match.createdAt;
}

function latestCandidateFromMessages(
  messages: WhatsappQrMessageRecord[],
  source: WhatsappQrMatchSource
): { username: string | null; at: string | null } {
  const candidateMessages = messages.filter(
    (message) => message.matchSource === source && typeof message.candidateUsername === 'string' && message.candidateUsername.length > 0
  );
  const latestMessage = pickLatest(candidateMessages, messageSignalAt);
  return {
    username: latestMessage?.candidateUsername ?? null,
    at: latestMessage ? messageSignalAt(latestMessage) : null
  };
}

function latestCandidateFromMatches(
  matches: WhatsappQrMatchRecord[],
  source: WhatsappQrMatchSource
): { username: string | null; at: string | null } {
  const candidateMatches = matches.filter((match) => match.source === source && typeof match.username === 'string' && match.username.length > 0);
  const latestMatch = pickLatest(candidateMatches, (match) => match.createdAt);
  return {
    username: latestMatch?.username ?? null,
    at: latestMatch?.createdAt ?? null
  };
}

function queueReasonFromMatch(match: WhatsappQrMatchRecord | null): WhatsappQrReviewReason {
  switch (match?.status) {
    case 'not_found':
      return 'not_found';
    case 'conflict':
      return 'conflict';
    case 'error':
      return 'technical_error';
    default:
      return 'detected_unassigned';
  }
}

export function buildWhatsappQrPhoneQueue(input: {
  monthClients: WhatsappQrMonthClientRecord[];
  messages: WhatsappQrMessageRecord[];
  matches: WhatsappQrMatchRecord[];
  ignoredPhones?: ReadonlySet<string>;
}): {
  summary: WhatsappQrQueueSummary;
  queue: WhatsappQrPhoneQueueRow[];
} {
  const ignoredPhones = input.ignoredPhones ?? new Set<string>();
  const messagesByPhone = new Map<string, WhatsappQrMessageRecord[]>();
  const matchesByPhone = new Map<string, WhatsappQrMatchRecord[]>();

  for (const message of input.messages) {
    const entries = messagesByPhone.get(message.clientPhoneE164) ?? [];
    entries.push(message);
    messagesByPhone.set(message.clientPhoneE164, entries);
  }

  for (const match of input.matches) {
    const entries = matchesByPhone.get(match.clientPhoneE164) ?? [];
    entries.push(match);
    matchesByPhone.set(match.clientPhoneE164, entries);
  }

  const allRows = input.monthClients.map((monthClient) => {
    const phoneMessages = messagesByPhone.get(monthClient.phoneE164) ?? [];
    const phoneMatches = matchesByPhone.get(monthClient.phoneE164) ?? [];

    const latestMatch = pickLatest(phoneMatches, matchAttemptAt);
    const contactCandidateFromMessages = latestCandidateFromMessages(phoneMessages, 'contact_name');
    const outboundCandidateFromMessages = latestCandidateFromMessages(phoneMessages, 'outbound_message');
    const contactCandidateFromMatches =
      contactCandidateFromMessages.username ? { username: null, at: null } : latestCandidateFromMatches(phoneMatches, 'contact_name');
    const outboundCandidateFromMatches =
      outboundCandidateFromMessages.username ? { username: null, at: null } : latestCandidateFromMatches(phoneMatches, 'outbound_message');

    const contactCandidateUsername = contactCandidateFromMessages.username ?? contactCandidateFromMatches.username;
    const outboundCandidateUsername = outboundCandidateFromMessages.username ?? outboundCandidateFromMatches.username;
    const contactSignalAt = contactCandidateFromMessages.at ?? contactCandidateFromMatches.at;
    const outboundSignalAt = outboundCandidateFromMessages.at ?? outboundCandidateFromMatches.at;
    const suggestedUsername = contactCandidateUsername ?? outboundCandidateUsername ?? latestMatch?.username ?? null;
    const primarySignalSource = contactCandidateUsername
      ? 'contact_name'
      : outboundCandidateUsername
        ? 'outbound_message'
        : latestMatch?.source ?? null;
    const lastSignalAt = compareIsoDesc(contactSignalAt, outboundSignalAt) < 0 ? contactSignalAt : outboundSignalAt;
    const lastAttemptAt = latestMatch ? matchAttemptAt(latestMatch) : null;

    if (monthClient.assignedUsername) {
      return {
        clientId: monthClient.clientId,
        linkId: monthClient.linkId,
        phoneE164: monthClient.phoneE164,
        status: 'assigned' as const,
        reviewReason: null,
        assignedUsername: monthClient.assignedUsername,
        suggestedUsername,
        contactCandidateUsername,
        outboundCandidateUsername,
        primarySignalSource,
        lastSignalAt,
        lastAttemptAt,
        lastError: latestMatch?.errorMessage ?? null
      };
    }

    const hasUsableSignal = Boolean(suggestedUsername);
    const reviewReason = hasUsableSignal ? queueReasonFromMatch(latestMatch) : 'no_signal';

    return {
      clientId: monthClient.clientId,
      linkId: monthClient.linkId,
      phoneE164: monthClient.phoneE164,
      status: 'review' as const,
      reviewReason,
      assignedUsername: null,
      suggestedUsername,
      contactCandidateUsername,
      outboundCandidateUsername,
      primarySignalSource,
      lastSignalAt,
      lastAttemptAt,
      lastError: latestMatch?.errorMessage ?? null
    };
  });

  const ignored = allRows.filter((row) => row.status === 'review' && ignoredPhones.has(row.phoneE164)).length;
  const queue = allRows.filter((row) => row.status === 'assigned' || !ignoredPhones.has(row.phoneE164));

  queue.sort((left, right) => {
    if (left.status !== right.status) {
      return left.status === 'review' ? -1 : 1;
    }

    const leftTime = left.lastAttemptAt ?? left.lastSignalAt;
    const rightTime = right.lastAttemptAt ?? right.lastSignalAt;
    const timeCompare = compareIsoDesc(leftTime, rightTime);
    if (timeCompare !== 0) {
      return timeCompare;
    }

    return left.phoneE164.localeCompare(right.phoneE164);
  });

  const summary: WhatsappQrQueueSummary = {
    totalPhones: allRows.length,
    assigned: allRows.filter((row) => row.status === 'assigned').length,
    review: queue.filter((row) => row.status === 'review').length,
    ignored,
    noSignal: queue.filter((row) => row.reviewReason === 'no_signal').length,
    detectedUnassigned: queue.filter((row) => row.reviewReason === 'detected_unassigned').length,
    notFound: queue.filter((row) => row.reviewReason === 'not_found').length,
    conflict: queue.filter((row) => row.reviewReason === 'conflict').length,
    technicalError: queue.filter((row) => row.reviewReason === 'technical_error').length
  };

  return { summary, queue };
}
