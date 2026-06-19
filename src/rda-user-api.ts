import type { Page } from 'playwright';
import {
  formatRdaUnavailableMessage,
  formatRdaUserNotFoundMessage,
  isRdaUnavailableErrorMessage
} from './rda-user-error';

export type RdaUserApiErrorCode = 'NOT_FOUND' | 'AMBIGUOUS' | 'UNAVAILABLE' | 'INTERNAL';

export interface RdaUserApiUser {
  id: string;
  username: string;
  balance: number;
  role?: string;
}

export interface ResolvedRdaUser {
  agentId: string;
  user: RdaUserApiUser;
}

export interface RdaPaymentAgents {
  defaultAgentId: number | null;
}

export interface RdaPaymentInput {
  userId: string;
  amount: number;
  operation: 0 | 1;
  paymentAgentId?: number | null;
}

interface RdaUserCheckResponse {
  status?: unknown;
  result?: {
    id?: unknown;
  };
  error_message?: unknown;
}

interface RdaUserListResponse {
  status?: unknown;
  result?: {
    users?: unknown;
  };
  error_message?: unknown;
}

interface RdaPaymentAgentsResponse {
  status?: unknown;
  result?: {
    default_agent_id?: unknown;
  };
  error_message?: unknown;
}

interface RdaPaymentResponse {
  status?: unknown;
  error_message?: unknown;
}

interface PageFetchResult {
  ok: boolean;
  status: number;
  statusText: string;
  text: string;
  body: unknown;
}

export class RdaUserApiError extends Error {
  constructor(
    public readonly code: RdaUserApiErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'RdaUserApiError';
  }
}

export function normalizeRdaUsername(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

export function roundRdaMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function formatRdaMoney(value: number): string {
  return roundRdaMoney(value).toLocaleString('es-AR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function parseRdaApiNumber(value: unknown, fieldName: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const compact = value.trim().replace(/\s+/g, '').replace(/[^0-9,.-]/g, '');
    if (!/[0-9]/.test(compact)) {
      throw new Error(`Invalid RdA numeric field "${fieldName}"`);
    }

    const sign = compact.startsWith('-') ? '-' : '';
    const unsigned = compact.replace(/-/g, '');
    let normalized: string;

    if (unsigned.includes(',') && unsigned.includes('.')) {
      normalized =
        unsigned.lastIndexOf(',') > unsigned.lastIndexOf('.')
          ? unsigned.replace(/\./g, '').replace(/,/g, '.')
          : unsigned.replace(/,/g, '');
    } else if (unsigned.includes(',')) {
      const parts = unsigned.split(',');
      const decimalPart = parts.pop() ?? '';
      const integerPart = parts.join('') || '0';
      normalized = `${integerPart}.${decimalPart}`;
    } else {
      normalized = unsigned;
    }

    const parsed = Number(`${sign}${normalized}`);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  throw new Error(`Invalid RdA numeric field "${fieldName}"`);
}

function parseRdaApiUser(rawUser: unknown): RdaUserApiUser | null {
  if (!rawUser || typeof rawUser !== 'object') {
    return null;
  }

  const record = rawUser as Record<string, unknown>;
  const id = record.id;
  const username = record.username;
  if ((typeof id !== 'number' && typeof id !== 'string') || typeof username !== 'string' || username.trim() === '') {
    return null;
  }

  return {
    id: String(id),
    username,
    balance: parseRdaApiNumber(record.balance ?? 0, 'balance'),
    ...(typeof record.role === 'string' ? { role: record.role } : {})
  };
}

export function selectExactRdaUser(rawUsers: unknown[], username: string): RdaUserApiUser {
  const targetUsername = normalizeRdaUsername(username);
  const users = rawUsers.flatMap((rawUser) => {
    const user = parseRdaApiUser(rawUser);
    return user ? [user] : [];
  });
  const exactMatches = users.filter((user) => normalizeRdaUsername(user.username) === targetUsername);

  if (exactMatches.length === 0) {
    throw new RdaUserApiError('NOT_FOUND', formatRdaUserNotFoundMessage(username));
  }

  if (exactMatches.length > 1) {
    throw new RdaUserApiError('AMBIGUOUS', `Se encontraron multiples coincidencias para el usuario ${username}`);
  }

  return exactMatches[0];
}

function assertRdaApiSuccess(response: { status?: unknown; error_message?: unknown }, endpoint: string): void {
  if (response.status === 0 || response.status === '0') {
    return;
  }

  const apiMessage = typeof response.error_message === 'string' && response.error_message.trim() ? response.error_message : null;
  throw new RdaUserApiError(
    'INTERNAL',
    `RdA API ${endpoint} returned status ${String(response.status ?? 'unknown')}${apiMessage ? `: ${apiMessage}` : ''}`
  );
}

function bodyContainsUnavailableSignal(result: PageFetchResult): boolean {
  if (result.status >= 500) {
    return true;
  }

  return isRdaUnavailableErrorMessage(result.text);
}

async function fetchRdaJson(page: Page, path: string, timeoutMs: number): Promise<unknown> {
  let result: PageFetchResult;
  try {
    result = await page.evaluate(
      async ({ apiPath, requestTimeoutMs }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
        try {
          const response = await fetch(apiPath, {
            credentials: 'include',
            signal: controller.signal,
            headers: {
              accept: 'application/json, text/plain, */*'
            }
          });
          const text = await response.text();
          let body: unknown = null;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            body = text;
          }

          return {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            text,
            body
          };
        } finally {
          clearTimeout(timer);
        }
      },
      { apiPath: path, requestTimeoutMs: timeoutMs }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isRdaUnavailableErrorMessage(message) || /abort/i.test(message) || /timeout/i.test(message)) {
      throw new RdaUserApiError('UNAVAILABLE', formatRdaUnavailableMessage(), { cause: error as Error });
    }
    throw new RdaUserApiError('INTERNAL', `Could not call RdA API ${path}: ${message}`, { cause: error as Error });
  }

  if (bodyContainsUnavailableSignal(result)) {
    throw new RdaUserApiError('UNAVAILABLE', formatRdaUnavailableMessage());
  }

  if (!result.ok) {
    throw new RdaUserApiError(
      'INTERNAL',
      `RdA API ${path} returned HTTP ${result.status}${result.statusText ? ` ${result.statusText}` : ''}`
    );
  }

  return result.body;
}

async function postRdaJson(page: Page, path: string, payload: unknown, timeoutMs: number): Promise<unknown> {
  let result: PageFetchResult;
  try {
    result = await page.evaluate(
      async ({ apiPath, requestPayload, requestTimeoutMs }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
        try {
          const response = await fetch(apiPath, {
            method: 'POST',
            credentials: 'include',
            signal: controller.signal,
            headers: {
              accept: 'application/json, text/plain, */*',
              'content-type': 'application/json'
            },
            body: JSON.stringify(requestPayload)
          });
          const text = await response.text();
          let body: unknown = null;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            body = text;
          }

          return {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            text,
            body
          };
        } finally {
          clearTimeout(timer);
        }
      },
      { apiPath: path, requestPayload: payload, requestTimeoutMs: timeoutMs }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isRdaUnavailableErrorMessage(message) || /abort/i.test(message) || /timeout/i.test(message)) {
      throw new RdaUserApiError('UNAVAILABLE', formatRdaUnavailableMessage(), { cause: error as Error });
    }
    throw new RdaUserApiError('INTERNAL', `Could not call RdA API ${path}: ${message}`, { cause: error as Error });
  }

  if (bodyContainsUnavailableSignal(result)) {
    throw new RdaUserApiError('UNAVAILABLE', formatRdaUnavailableMessage());
  }

  if (!result.ok) {
    throw new RdaUserApiError(
      'INTERNAL',
      `RdA API ${path} returned HTTP ${result.status}${result.statusText ? ` ${result.statusText}` : ''}`
    );
  }

  return result.body;
}

function buildRdaUserListPath(agentId: string, username: string): string {
  const params = new URLSearchParams({
    count: '10',
    page: '0',
    user_id: agentId,
    is_banned: 'false',
    is_direct_structure: 'true',
    username: username.trim().toLowerCase()
  });

  return `/api/agent_admin/user/?${params.toString()}`;
}

export async function fetchRdaAgentId(page: Page, timeoutMs: number): Promise<string> {
  const body = (await fetchRdaJson(page, '/api/user/check', timeoutMs)) as RdaUserCheckResponse;
  assertRdaApiSuccess(body, '/api/user/check');

  const agentId = body.result?.id;
  if (typeof agentId !== 'number' && typeof agentId !== 'string') {
    throw new RdaUserApiError('INTERNAL', 'RdA API /api/user/check did not return an agent id');
  }

  return String(agentId);
}

export async function fetchRdaUsersByUsername(
  page: Page,
  agentId: string,
  username: string,
  timeoutMs: number
): Promise<unknown[]> {
  const path = buildRdaUserListPath(agentId, username);
  const body = (await fetchRdaJson(page, path, timeoutMs)) as RdaUserListResponse;
  assertRdaApiSuccess(body, '/api/agent_admin/user');

  const users = body.result?.users;
  if (!Array.isArray(users)) {
    throw new RdaUserApiError('INTERNAL', 'RdA API /api/agent_admin/user did not return result.users');
  }

  return users;
}

export async function resolveRdaUserByApi(
  page: Page,
  username: string,
  timeoutMs: number,
  knownAgentId?: string
): Promise<ResolvedRdaUser> {
  const requestTimeoutMs = Math.max(1_000, Math.min(timeoutMs, 10_000));
  const agentId = knownAgentId ?? (await fetchRdaAgentId(page, requestTimeoutMs));
  const users = await fetchRdaUsersByUsername(page, agentId, username, requestTimeoutMs);
  return {
    agentId,
    user: selectExactRdaUser(users, username)
  };
}

export async function fetchRdaPaymentAgents(page: Page, userId: string, timeoutMs: number): Promise<RdaPaymentAgents> {
  const requestTimeoutMs = Math.max(1_000, Math.min(timeoutMs, 10_000));
  const path = `/api/agent_admin/user/${encodeURIComponent(userId)}/payment/agents/`;
  const body = (await fetchRdaJson(page, path, requestTimeoutMs)) as RdaPaymentAgentsResponse;
  assertRdaApiSuccess(body, path);

  const rawDefaultAgentId = body.result?.default_agent_id;
  const defaultAgentId =
    typeof rawDefaultAgentId === 'number'
      ? rawDefaultAgentId
      : typeof rawDefaultAgentId === 'string' && rawDefaultAgentId.trim() !== ''
        ? Number(rawDefaultAgentId)
        : null;

  return {
    defaultAgentId: Number.isFinite(defaultAgentId) ? defaultAgentId : null
  };
}

export async function submitRdaPayment(page: Page, input: RdaPaymentInput, timeoutMs: number): Promise<void> {
  const requestTimeoutMs = Math.max(1_000, Math.min(timeoutMs, 10_000));
  const path = `/api/agent_admin/user/${encodeURIComponent(input.userId)}/payment/`;
  const payload = {
    amount: roundRdaMoney(input.amount),
    operation: input.operation,
    bonus_amount: null,
    is_bonus: null,
    percent_amount: null,
    ...(input.paymentAgentId != null ? { payment_agent_id: input.paymentAgentId } : {})
  };

  const body = (await postRdaJson(page, path, payload, requestTimeoutMs)) as RdaPaymentResponse;
  assertRdaApiSuccess(body, path);
}
