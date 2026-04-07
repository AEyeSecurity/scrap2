import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Logger } from 'pino';
import { AsnUserCheckError, assertAsnUserExists, type AssertAsnUserExistsInput } from './asn-user-check';
import { formatAsnUserNotFoundMessage } from './asn-user-error';
import { runAsnReportJob } from './asn-report-job';
import { runBalanceJob } from './balance-job';
import { runCreatePlayerJob } from './create-player-job';
import { runDepositJob } from './deposit-job';
import { fundsOperationSchema } from './funds-operation';
import { JobManager } from './jobs';
import { runLoginJob } from './login-job';
import { buildMetaConversionsConfigFromEnv, MetaConversionsHttpDispatcher, type MetaConversionsDispatcher } from './meta-conversions';
import {
  createMetaConversionsStoreFromEnv,
  type MetaConversionsStore
} from './meta-conversions-store';
import { MetaConversionsWorker } from './meta-conversions-worker';
import { isAttributableMetaSourceContext } from './meta-source-context';
import {
  createMastercrmUserStoreFromEnv,
  normalizeMastercrmNombre,
  normalizeMastercrmOwnerKey,
  normalizeMastercrmTelefono,
  normalizeMastercrmUsername,
  toMastercrmHttpError,
  type MastercrmUserRecord,
  type MastercrmUserStore
} from './mastercrm-user-store';
import {
  createPlayerPhoneStoreFromEnv,
  toHttpError,
  type PlayerPhoneStore
} from './player-phone-store';
import {
  createReportRunStoreFromEnv,
  toHttpError as toReportHttpError,
  type ReportRunStore
} from './report-run-store';
import { createReportJobExecutor, ReportRunWorker, type ReportJobExecutor } from './report-worker';
import { paginaCodeSchema } from './site-profile';
import type {
  AppConfig,
  AsnReportJobRequest,
  AsnReportJobResult,
  BalanceJobRequest,
  CreatePlayerJobRequest,
  DepositJobRequest,
  FundsOperation,
  JobExecutionOptions,
  JobRequest,
  JobResult,
  JobStoreEntry,
  LoginJobRequest,
  PaginaCode,
  ServerConfig
} from './types';

interface JobQueue {
  enqueue(request: JobRequest): string;
  getById(id: string): JobStoreEntry | undefined;
  shutdown(): Promise<void>;
}

interface ServerDependencies {
  mastercrmUserStore?: MastercrmUserStore;
  playerPhoneStore?: PlayerPhoneStore;
  reportRunStore?: ReportRunStore;
  metaConversionsStore?: MetaConversionsStore;
  asnUserExistsChecker?: (input: AssertAsnUserExistsInput) => Promise<void>;
  metaEnabled?: boolean;
  metaWorkerEnabled?: boolean;
  metaWorkerConcurrency?: number;
  metaWorkerPollMs?: number;
  metaWorkerLeaseSeconds?: number;
  metaWorkerMaxAttempts?: number;
  metaWorkerScanLimit?: number;
  metaWorkerBatchSize?: number;
  metaConversionsDispatcher?: MetaConversionsDispatcher;
  reportWorkerEnabled?: boolean;
  reportWorkerConcurrency?: number;
  reportWorkerPollMs?: number;
  reportWorkerLeaseSeconds?: number;
  reportWorkerMaxAttempts?: number;
  reportJobExecutor?: ReportJobExecutor;
}

interface ValidationIssue {
  path: string;
  message: string;
}

function formatHttpMoneyWithoutComma(value: number): string {
  return value
    .toLocaleString('es-AR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })
    .replace(/,/g, '');
}

function formatJobResultForHttp(result: JobResult | undefined): JobResult | Record<string, unknown> | undefined {
  if (!result) {
    return undefined;
  }

  if (result.kind === 'balance' && result.pagina === 'RdA') {
    return {
      ...result,
      saldoNumero: formatHttpMoneyWithoutComma(result.saldoNumero)
    };
  }

  if (result.kind === 'rda-funds-operation' && result.operacion !== 'descarga_total') {
    return {
      ...result,
      saldoDespuesNumero: formatHttpMoneyWithoutComma(result.saldoDespuesNumero)
    };
  }

  return result;
}

function formatJobEntryForHttp(entry: JobStoreEntry): JobStoreEntry | (Omit<JobStoreEntry, 'result'> & { result?: JobResult | Record<string, unknown> }) {
  return {
    ...entry,
    result: formatJobResultForHttp(entry.result)
  };
}

const executionOverridesSchema = z.object({
  headless: z.boolean().optional(),
  debug: z.boolean().optional(),
  slowMo: z.number().min(0).optional(),
  timeoutMs: z.number().min(1).optional()
});

const stepActionSchema = z.object({
  type: z.enum(['goto', 'click', 'fill', 'waitFor']),
  selector: z.string().optional(),
  value: z.string().optional(),
  url: z.string().optional(),
  timeoutMs: z.number().int().min(1).optional(),
  screenshotName: z.string().optional()
});

const ownerContextSchema = z.object({
  ownerKey: z.string().trim().min(1),
  ownerLabel: z.string().trim().min(1),
  actorAlias: z.string().trim().min(1).nullable().optional(),
  actorPhone: z.string().trim().min(1).nullable().optional()
});

const sourceContextSchema = z.object({
  ctwaClid: z.string().trim().min(1).nullable().optional(),
  referralSourceId: z.string().trim().min(1).nullable().optional(),
  referralSourceUrl: z.string().trim().min(1).nullable().optional(),
  referralHeadline: z.string().trim().min(1).nullable().optional(),
  referralBody: z.string().trim().min(1).nullable().optional(),
  referralSourceType: z.string().trim().min(1).nullable().optional(),
  waId: z.string().trim().min(1).nullable().optional(),
  messageSid: z.string().trim().min(1).nullable().optional(),
  accountSid: z.string().trim().min(1).nullable().optional(),
  profileName: z.string().trim().min(1).nullable().optional(),
  clientIpAddress: z.string().trim().min(1).nullable().optional(),
  clientUserAgent: z.string().trim().min(1).nullable().optional(),
  receivedAt: z.string().trim().min(1).nullable().optional()
});

const loginBodySchema = z
  .object({
    username: z.string().min(1),
    password: z.string().min(1)
  })
  .merge(executionOverridesSchema);

const createPlayerBodySchema = z
  .object({
    pagina: paginaCodeSchema,
    loginUsername: z.string().min(1),
    loginPassword: z.string().min(1),
    newUsername: z.string().min(1),
    newPassword: z.string().min(1),
    telefono: z.string().trim().min(1).optional(),
    ownerContext: ownerContextSchema.optional(),
    stepsOverride: z.array(stepActionSchema).optional()
  })
  .merge(executionOverridesSchema)
  .superRefine((value, ctx) => {
    if (value.telefono && !value.ownerContext) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ownerContext'],
        message: 'ownerContext is required when telefono is provided'
      });
    }
  });

const assignPhoneBodySchema = z.object({
  pagina: paginaCodeSchema,
  usuario: z.string().trim().min(1),
  agente: z.string().trim().min(1),
  contrasena_agente: z.string().trim().min(1),
  telefono: z.string().trim().min(1),
  ownerContext: ownerContextSchema
});

const unassignPhoneBodySchema = z.object({
  pagina: paginaCodeSchema,
  telefono: z.string().trim().min(1),
  ownerContext: ownerContextSchema
});

const intakePendingBodySchema = z.object({
  pagina: paginaCodeSchema,
  telefono: z.string().trim().min(1),
  ownerContext: ownerContextSchema,
  sourceContext: sourceContextSchema.optional()
});

const depositBodySchema = z
  .object({
    pagina: paginaCodeSchema,
    operacion: fundsOperationSchema,
    usuario: z.string().trim().min(1),
    agente: z.string().trim().min(1),
    contrasena_agente: z.string().trim().min(1),
    cantidad: z.number().int().positive().optional()
  })
  .merge(executionOverridesSchema)
  .superRefine((value, ctx) => {
    if (DEPOSIT_AMOUNT_REQUIRED_OPERATIONS.includes(value.operacion) && typeof value.cantidad !== 'number') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cantidad'],
        message: 'cantidad is required for carga/descarga operations'
      });
    }
  });

const jobParamsSchema = z.object({
  id: z.string().min(1)
});

const reportRunBodySchema = z.object({
  pagina: z.literal('ASN'),
  principalKey: z.string().trim().min(1),
  agente: z.string().trim().min(1),
  contrasena_agente: z.string().trim().min(1),
  reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

const reportRunParamsSchema = z.object({
  runId: z.string().trim().min(1)
});

const reportRunItemsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional()
});

const mastercrmLoginBodySchema = z
  .object({
    username: z.string().optional(),
    usuario: z.string().optional(),
    password: z.string().optional(),
    contrasena: z.string().optional()
  })
  .passthrough();

const mastercrmRegisterBodySchema = z
  .object({
    username: z.string().optional(),
    usuario: z.string().optional(),
    password: z.string().optional(),
    contrasena: z.string().optional(),
    nombre: z.string().optional(),
    name: z.string().optional(),
    telefono: z.string().optional(),
    phone: z.string().optional(),
    celular: z.string().optional()
  })
  .passthrough();

const mastercrmClientsBodySchema = z
  .object({
    id: z.union([z.string(), z.number().int()]).optional(),
    user_id: z.union([z.string(), z.number().int()]).optional(),
    usuario_id: z.union([z.string(), z.number().int()]).optional(),
    month: z.string().optional(),
    mes: z.string().optional()
  })
  .passthrough();

const mastercrmLinkCashierBodySchema = z
  .object({
    user_id: z.union([z.string(), z.number().int()]).optional(),
    owner_key: z.string().optional(),
    staff_password: z.string().optional()
  })
  .passthrough();

const mastercrmOwnerFinancialsBodySchema = z
  .object({
    user_id: z.union([z.string(), z.number().int()]).optional(),
    month: z.string().optional(),
    mes: z.string().optional(),
    ad_spend_ars: z.union([z.string(), z.number()]).optional(),
    inversion_publicitaria_ars: z.union([z.string(), z.number()]).optional(),
    commission_pct: z.union([z.string(), z.number()]).optional(),
    porcentaje_cajero: z.union([z.string(), z.number()]).optional()
  })
  .passthrough();

const DEPOSIT_TURBO_TIMEOUT_MS = 15_000;
const DEPOSIT_AMOUNT_REQUIRED_OPERATIONS: FundsOperation[] = ['carga', 'descarga'];
const DEFAULT_MASTERCRM_CORS_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

function parseBooleanEnv(input: string | undefined): boolean | undefined {
  if (input == null) {
    return undefined;
  }

  const normalized = input.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }

  return undefined;
}

function parsePositiveIntegerEnv(input: string | undefined, fallback: number): number {
  const parsed = Number(input);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }

  return Math.trunc(parsed);
}

function parsePositiveNumberEnv(input: string | undefined, fallback: number): number {
  const parsed = Number(input);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parseListEnv(input: string | undefined, fallback: string[]): string[] {
  const values = input
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return values && values.length > 0 ? values : fallback;
}

function resolveAliasStringField(
  payload: Record<string, unknown>,
  aliases: string[],
  label: string,
  issues: ValidationIssue[],
  options: {
    required?: boolean;
    normalize?: (value: string) => string;
    trim?: boolean;
  } = {}
): string | undefined {
  const required = options.required ?? true;
  const trim = options.trim ?? true;
  const normalize = options.normalize ?? ((value: string) => value);
  const present = aliases.flatMap((alias) => {
    const value = payload[alias];
    if (value == null) {
      return [];
    }

    if (typeof value !== 'string') {
      issues.push({ path: alias, message: `${alias} must be a string` });
      return [];
    }

    const prepared = trim ? value.trim() : value;
    return [{ alias, raw: prepared, normalized: normalize(prepared) }];
  });

  const nonEmpty = present.filter((entry) => entry.raw.length > 0);
  if (present.length > 1) {
    const distinct = new Set(nonEmpty.map((entry) => entry.normalized));
    if (distinct.size > 1) {
      issues.push({
        path: aliases.join(','),
        message: `${label} aliases must match when provided`
      });
      return undefined;
    }
  }

  if (nonEmpty.length === 0) {
    if (required) {
      issues.push({ path: aliases[0] ?? label, message: `${label} is required` });
    }
    return undefined;
  }

  return nonEmpty[0]?.raw;
}

function resolveAliasPositiveIntegerField(
  payload: Record<string, unknown>,
  aliases: string[],
  label: string,
  issues: ValidationIssue[]
): number | undefined {
  const present = aliases.flatMap((alias) => {
    const value = payload[alias];
    if (value == null || value === '') {
      return [];
    }

    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
      issues.push({ path: alias, message: `${alias} must be a positive integer` });
      return [];
    }

    return [{ alias, value: parsed }];
  });

  if (present.length > 1) {
    const distinct = new Set(present.map((entry) => entry.value));
    if (distinct.size > 1) {
      issues.push({
        path: aliases.join(','),
        message: `${label} aliases must match when provided`
      });
      return undefined;
    }
  }

  if (present.length === 0) {
    issues.push({ path: aliases[0] ?? label, message: `${label} is required` });
    return undefined;
  }

  return present[0]?.value;
}

function mastercrmUserToResponse(user: MastercrmUserRecord): Record<string, unknown> {
  return {
    id: user.id,
    usuario: user.username,
    nombre: user.nombre,
    telefono: user.telefono,
    created_at: user.createdAt,
    inversion: user.inversion
  };
}

function resolveMastercrmCorsOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return parseListEnv(env.MASTERCRM_CORS_ORIGINS, DEFAULT_MASTERCRM_CORS_ORIGINS);
}

function resolveMastercrmStaffLinkPassword(env: NodeJS.ProcessEnv = process.env): string {
  const password = env.MASTERCRM_STAFF_LINK_PASSWORD?.trim();
  if (!password) {
    throw new Error('MASTERCRM_STAFF_LINK_PASSWORD is not configured');
  }

  return password;
}

function getBuenosAiresDateToken(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
}

function buildAsnUserNotFoundResponse(usuario: string): {
  message: string;
  code: 'ASN_USER_NOT_FOUND';
  details: { usuario: string };
} {
  return {
    message: formatAsnUserNotFoundMessage(usuario),
    code: 'ASN_USER_NOT_FOUND',
    details: { usuario }
  };
}

function resolveExecutionOptions(
  appConfig: AppConfig,
  overrides: Partial<Pick<JobExecutionOptions, 'headless' | 'debug' | 'slowMo' | 'timeoutMs'>>
): JobExecutionOptions {
  return {
    headless: overrides.headless ?? appConfig.headless,
    debug: overrides.debug ?? appConfig.debug,
    slowMo: overrides.slowMo ?? appConfig.slowMo,
    timeoutMs: overrides.timeoutMs ?? appConfig.timeoutMs
  };
}

function resolveDepositExecutionOptions(
  appConfig: AppConfig,
  overrides: Partial<Pick<JobExecutionOptions, 'headless' | 'debug' | 'slowMo' | 'timeoutMs'>>,
  pagina?: PaginaCode
): JobExecutionOptions {
  if (pagina === 'ASN') {
    const requestedTimeout = overrides.timeoutMs ?? appConfig.timeoutMs;
    return {
      headless: true,
      debug: false,
      slowMo: 0,
      timeoutMs: Math.min(requestedTimeout, DEPOSIT_TURBO_TIMEOUT_MS)
    };
  }

  return {
    headless: overrides.headless ?? appConfig.headless,
    debug: overrides.debug ?? false,
    slowMo: overrides.slowMo ?? 0,
    timeoutMs: overrides.timeoutMs ?? Math.min(appConfig.timeoutMs, DEPOSIT_TURBO_TIMEOUT_MS)
  };
}

function toValidationIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

function parseMastercrmLoginPayload(body: unknown): { data?: { username: string; password: string }; issues: ValidationIssue[] } {
  const parsed = mastercrmLoginBodySchema.safeParse(body);
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
    };
  }

  const issues: ValidationIssue[] = [];
  const username = resolveAliasStringField(parsed.data, ['username', 'usuario'], 'username', issues, {
    normalize: (value) => value.trim().toLowerCase()
  });
  const password = resolveAliasStringField(parsed.data, ['password', 'contrasena'], 'password', issues, {
    normalize: (value) => value,
    trim: false
  });

  if (issues.length > 0 || !username || !password) {
    return { issues };
  }

  return { data: { username, password }, issues };
}

function parseMastercrmRegisterPayload(body: unknown): {
  data?: { username: string; password: string; nombre: string; telefono?: string };
  issues: ValidationIssue[];
} {
  const parsed = mastercrmRegisterBodySchema.safeParse(body);
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
    };
  }

  const issues: ValidationIssue[] = [];
  const username = resolveAliasStringField(parsed.data, ['username', 'usuario'], 'username', issues, {
    normalize: (value) => value.trim().toLowerCase()
  });
  const password = resolveAliasStringField(parsed.data, ['password', 'contrasena'], 'password', issues, {
    normalize: (value) => value,
    trim: false
  });
  const nombre = resolveAliasStringField(parsed.data, ['nombre', 'name'], 'nombre', issues);
  const telefono = resolveAliasStringField(parsed.data, ['telefono', 'phone', 'celular'], 'telefono', issues, {
    required: false
  });

  if (issues.length > 0 || !username || !password || !nombre) {
    return { issues };
  }

  return {
    data: {
      username,
      password,
      nombre,
      ...(telefono ? { telefono } : {})
    },
    issues
  };
}

function resolveAliasNumberField(
  payload: Record<string, unknown>,
  aliases: string[],
  label: string,
  issues: ValidationIssue[],
  options: { min?: number; max?: number } = {}
): number | undefined {
  const present = aliases.flatMap((alias) => {
    const value = payload[alias];
    if (value == null || value === '') {
      return [];
    }

    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) {
      issues.push({ path: alias, message: `${alias} must be a number` });
      return [];
    }

    if (options.min != null && parsed < options.min) {
      issues.push({ path: alias, message: `${alias} must be >= ${options.min}` });
      return [];
    }

    if (options.max != null && parsed > options.max) {
      issues.push({ path: alias, message: `${alias} must be <= ${options.max}` });
      return [];
    }

    return [{ alias, value: parsed }];
  });

  if (present.length > 1) {
    const distinct = new Set(present.map((entry) => entry.value));
    if (distinct.size > 1) {
      issues.push({
        path: aliases.join(','),
        message: `${label} aliases must match when provided`
      });
      return undefined;
    }
  }

  if (present.length === 0) {
    issues.push({ path: aliases[0] ?? label, message: `${label} is required` });
    return undefined;
  }

  return present[0]?.value;
}

function parseMastercrmClientsPayload(body: unknown): { data?: { userId: number; month?: string }; issues: ValidationIssue[] } {
  const parsed = mastercrmClientsBodySchema.safeParse(body);
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
    };
  }

  const issues: ValidationIssue[] = [];
  const userId = resolveAliasPositiveIntegerField(parsed.data, ['id', 'user_id', 'usuario_id'], 'id', issues);
  const month = resolveAliasStringField(parsed.data, ['month', 'mes'], 'month', issues, { required: false });
  if (issues.length > 0 || !userId) {
    return { issues };
  }

  return { data: { userId, ...(month ? { month } : {}) }, issues };
}

function parseMastercrmLinkCashierPayload(body: unknown): {
  data?: { userId: number; ownerKey: string; staffPassword: string };
  issues: ValidationIssue[];
} {
  const parsed = mastercrmLinkCashierBodySchema.safeParse(body);
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
    };
  }

  const issues: ValidationIssue[] = [];
  const userId = resolveAliasPositiveIntegerField(parsed.data, ['user_id'], 'user_id', issues);
  const ownerKey = resolveAliasStringField(parsed.data, ['owner_key'], 'owner_key', issues, {
    normalize: (value) => value.trim().toLowerCase()
  });
  const staffPassword = resolveAliasStringField(parsed.data, ['staff_password'], 'staff_password', issues, {
    normalize: (value) => value,
    trim: false
  });

  if (issues.length > 0 || !userId || !ownerKey || !staffPassword) {
    return { issues };
  }

  return { data: { userId, ownerKey, staffPassword }, issues };
}

function parseMastercrmOwnerFinancialsPayload(body: unknown): {
  data?: { userId: number; month: string; adSpendArs: number; commissionPct: number };
  issues: ValidationIssue[];
} {
  const parsed = mastercrmOwnerFinancialsBodySchema.safeParse(body);
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
    };
  }

  const issues: ValidationIssue[] = [];
  const userId = resolveAliasPositiveIntegerField(parsed.data, ['user_id'], 'user_id', issues);
  const month = resolveAliasStringField(parsed.data, ['month', 'mes'], 'month', issues);
  const adSpendArs = resolveAliasNumberField(
    parsed.data,
    ['ad_spend_ars', 'inversion_publicitaria_ars'],
    'ad_spend_ars',
    issues,
    { min: 0 }
  );
  const commissionPct = resolveAliasNumberField(
    parsed.data,
    ['commission_pct', 'porcentaje_cajero'],
    'commission_pct',
    issues,
    { min: 0, max: 100 }
  );

  if (issues.length > 0 || !userId || !month || adSpendArs == null || commissionPct == null) {
    return { issues };
  }

  return { data: { userId, month, adSpendArs, commissionPct }, issues };
}

export function createServer(
  appConfig: AppConfig,
  serverConfig: ServerConfig,
  logger: Logger,
  queue?: JobQueue,
  dependencies?: ServerDependencies
): FastifyInstance {
  const fastify = Fastify({ logger: false });
  let cachedMastercrmUserStore: MastercrmUserStore | null = dependencies?.mastercrmUserStore ?? null;
  let cachedPlayerPhoneStore: PlayerPhoneStore | null = dependencies?.playerPhoneStore ?? null;
  let cachedReportRunStore: ReportRunStore | null = dependencies?.reportRunStore ?? null;
  let cachedMetaConversionsStore: MetaConversionsStore | null = dependencies?.metaConversionsStore ?? null;
  let reportWorker: ReportRunWorker | null = null;
  let metaWorker: MetaConversionsWorker | null = null;
  const asnUserExistsChecker = dependencies?.asnUserExistsChecker ?? assertAsnUserExists;
  const hasSupabaseConfig = Boolean(
    process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  );
  const rawMetaEnabled = parseBooleanEnv(process.env.META_ENABLED) ?? false;
  const metaConfiguredFromEnv = Boolean(
    process.env.META_DATASET_ID?.trim() && process.env.META_ACCESS_TOKEN?.trim() && hasSupabaseConfig
  );
  const metaEnabled = dependencies?.metaEnabled ?? (rawMetaEnabled && metaConfiguredFromEnv);
  const metaLeadEnabled = parseBooleanEnv(process.env.META_LEAD_ENABLED) ?? true;
  const metaPurchaseEnabled = parseBooleanEnv(process.env.META_PURCHASE_ENABLED) ?? true;
  const metaValueSignalThreshold = parsePositiveNumberEnv(process.env.META_VALUE_SIGNAL_THRESHOLD, 10_000);
  const metaValueSignalWindowMode = process.env.META_VALUE_SIGNAL_WINDOW_MODE?.trim() || 'intake_local_day';
  const metaValueSignalTimezone = 'America/Argentina/Buenos_Aires';
  const metaWorkerEnabled = dependencies?.metaWorkerEnabled ?? metaEnabled;
  const metaWorkerConcurrency =
    dependencies?.metaWorkerConcurrency ?? parsePositiveIntegerEnv(process.env.META_WORKER_CONCURRENCY, 2);
  const metaWorkerPollMs = dependencies?.metaWorkerPollMs ?? parsePositiveIntegerEnv(process.env.META_WORKER_POLL_MS, 1000);
  const metaWorkerLeaseSeconds =
    dependencies?.metaWorkerLeaseSeconds ?? parsePositiveIntegerEnv(process.env.META_WORKER_LEASE_SECONDS, 60);
  const metaWorkerMaxAttempts =
    dependencies?.metaWorkerMaxAttempts ?? parsePositiveIntegerEnv(process.env.META_WORKER_MAX_ATTEMPTS, 5);
  const metaWorkerScanLimit =
    dependencies?.metaWorkerScanLimit ?? parsePositiveIntegerEnv(process.env.META_WORKER_SCAN_LIMIT, 100);
  const metaWorkerBatchSize =
    dependencies?.metaWorkerBatchSize ?? parsePositiveIntegerEnv(process.env.META_BATCH_SIZE, 1);
  const reportWorkerEnabled =
    dependencies?.reportWorkerEnabled ??
    ((parseBooleanEnv(process.env.REPORT_WORKER_ENABLED) ?? true) && (Boolean(dependencies?.reportRunStore) || hasSupabaseConfig));
  const reportWorkerConcurrency =
    dependencies?.reportWorkerConcurrency ?? parsePositiveIntegerEnv(process.env.REPORT_WORKER_CONCURRENCY, 3);
  const reportWorkerPollMs = dependencies?.reportWorkerPollMs ?? parsePositiveIntegerEnv(process.env.REPORT_WORKER_POLL_MS, 1000);
  const reportWorkerLeaseSeconds =
    dependencies?.reportWorkerLeaseSeconds ?? parsePositiveIntegerEnv(process.env.REPORT_WORKER_LEASE_SECONDS, 60);
  const reportWorkerMaxAttempts =
    dependencies?.reportWorkerMaxAttempts ?? parsePositiveIntegerEnv(process.env.REPORT_WORKER_MAX_ATTEMPTS, 3);

  fastify.register(cors, {
    origin: resolveMastercrmCorsOrigins()
  });

  function getMastercrmUserStore(): MastercrmUserStore {
    if (cachedMastercrmUserStore) {
      return cachedMastercrmUserStore;
    }

    cachedMastercrmUserStore = createMastercrmUserStoreFromEnv();
    return cachedMastercrmUserStore;
  }

  function getPlayerPhoneStore(): PlayerPhoneStore {
    if (cachedPlayerPhoneStore) {
      return cachedPlayerPhoneStore;
    }

    cachedPlayerPhoneStore = createPlayerPhoneStoreFromEnv();
    return cachedPlayerPhoneStore;
  }

  function getReportRunStore(): ReportRunStore {
    if (cachedReportRunStore) {
      return cachedReportRunStore;
    }

    cachedReportRunStore = createReportRunStoreFromEnv();
    return cachedReportRunStore;
  }

  function getMetaConversionsStore(): MetaConversionsStore {
    if (cachedMetaConversionsStore) {
      return cachedMetaConversionsStore;
    }

    cachedMetaConversionsStore = createMetaConversionsStoreFromEnv();
    return cachedMetaConversionsStore;
  }

  const internalQueue =
    queue ??
    new JobManager({
      concurrency: serverConfig.loginConcurrency,
      ttlMinutes: serverConfig.jobTtlMinutes,
      logger,
      executor: async (request) => {
        if (request.jobType === 'login') {
          return runLoginJob(request, appConfig, logger);
        }

        if (request.jobType === 'create-player') {
          const execution = await runCreatePlayerJob(request, appConfig, logger);
          const result = execution.result;
          if (result?.kind === 'create-player' && typeof request.payload.telefono === 'string') {
            if (!request.payload.ownerContext) {
              throw new Error('ownerContext is required when telefono is provided');
            }
            await getPlayerPhoneStore().syncCreatePlayerLink({
              pagina: request.payload.pagina,
              jugadorUsername: result.createdUsername,
              telefono: request.payload.telefono,
              ownerContext: request.payload.ownerContext
            });
          }

          return execution;
        }

        if (request.jobType === 'deposit') {
          return runDepositJob(request, appConfig, logger);
        }

        if (request.jobType === 'balance') {
          return runBalanceJob(request, appConfig, logger);
        }

        if (request.jobType === 'report') {
          return runAsnReportJob(request, appConfig, logger);
        }

        throw new Error('Unsupported job type');
      }
    });

  if (reportWorkerEnabled) {
    const executor =
      dependencies?.reportJobExecutor ??
      createReportJobExecutor(appConfig, logger, resolveDepositExecutionOptions(appConfig, {}, 'ASN'));
    reportWorker = new ReportRunWorker(getReportRunStore(), logger, {
      concurrency: reportWorkerConcurrency,
      pollMs: reportWorkerPollMs,
      leaseSeconds: reportWorkerLeaseSeconds,
      maxAttempts: reportWorkerMaxAttempts
    }, executor);
    reportWorker.start();
  }

  if (metaEnabled && metaWorkerEnabled) {
    const dispatcher =
      dependencies?.metaConversionsDispatcher ??
      new MetaConversionsHttpDispatcher(buildMetaConversionsConfigFromEnv());
    metaWorker = new MetaConversionsWorker(getMetaConversionsStore(), dispatcher, logger, {
      concurrency: metaWorkerConcurrency,
      pollMs: metaWorkerPollMs,
      leaseSeconds: metaWorkerLeaseSeconds,
      maxAttempts: metaWorkerMaxAttempts,
      scanLimit: metaWorkerScanLimit,
      scanEnabled: metaPurchaseEnabled,
      scanOptions: {
        threshold: metaValueSignalThreshold,
        timezone: metaValueSignalTimezone,
        windowMode: metaValueSignalWindowMode
      },
      batchSize: metaWorkerBatchSize
    });
    metaWorker.start();
  }

  fastify.post('/login', async (request, reply) => {
    const parsed = loginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: 'Invalid payload',
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
      });
    }

    const payload = parsed.data;
    const createdAt = new Date().toISOString();
    const id = randomUUID();
    const jobRequest: LoginJobRequest = {
      id,
      jobType: 'login',
      createdAt,
      payload: {
        username: payload.username,
        password: payload.password
      },
      options: resolveExecutionOptions(appConfig, payload)
    };

    internalQueue.enqueue(jobRequest);

    return reply.code(202).send({
      jobId: id,
      status: 'queued',
      statusUrl: `/jobs/${id}`
    });
  });

  fastify.post('/mastercrm-register', async (request, reply) => {
    const parsed = parseMastercrmRegisterPayload(request.body);
    if (!parsed.data) {
      return reply.code(400).send({
        message: 'Invalid payload',
        issues: parsed.issues
      });
    }

    try {
      const createdUser = await getMastercrmUserStore().createUser({
        username: normalizeMastercrmUsername(parsed.data.username),
        password: parsed.data.password,
        nombre: normalizeMastercrmNombre(parsed.data.nombre),
        ...(parsed.data.telefono ? { telefono: normalizeMastercrmTelefono(parsed.data.telefono) ?? undefined } : {})
      });

      return reply.code(201).send(mastercrmUserToResponse(createdUser));
    } catch (error) {
      const mappedError = toMastercrmHttpError(error);
      if (mappedError) {
        return reply.code(mappedError.statusCode).send({ message: mappedError.message });
      }

      logger.error({ error }, 'Unexpected /mastercrm-register error');
      return reply.code(500).send({ message: 'Unexpected mastercrm auth error' });
    }
  });

  fastify.post('/mastercrm-login', async (request, reply) => {
    const parsed = parseMastercrmLoginPayload(request.body);
    if (!parsed.data) {
      return reply.code(400).send({
        message: 'Invalid payload',
        issues: parsed.issues
      });
    }

    try {
      const user = await getMastercrmUserStore().authenticate({
        username: normalizeMastercrmUsername(parsed.data.username),
        password: parsed.data.password
      });

      return reply.code(200).send(mastercrmUserToResponse(user));
    } catch (error) {
      const mappedError = toMastercrmHttpError(error);
      if (mappedError) {
        return reply.code(mappedError.statusCode).send({ message: mappedError.message });
      }

      logger.error({ error }, 'Unexpected /mastercrm-login error');
      return reply.code(500).send({ message: 'Unexpected mastercrm auth error' });
    }
  });

  fastify.post('/mastercrm-clients', async (request, reply) => {
    const parsed = parseMastercrmClientsPayload(request.body);
    if (!parsed.data) {
      return reply.code(400).send({
        message: 'Invalid payload',
        issues: parsed.issues
      });
    }

    try {
      const dashboard = await getMastercrmUserStore().getClientsDashboard({
        userId: parsed.data.userId,
        month: parsed.data.month
      });
      return reply.code(200).send({
        linkedOwner: dashboard.linkedOwner
          ? {
              ownerKey: dashboard.linkedOwner.ownerKey,
              ownerLabel: dashboard.linkedOwner.ownerLabel,
              pagina: dashboard.linkedOwner.pagina,
              telefono: dashboard.linkedOwner.telefono
            }
          : null,
        summary: dashboard.summary
          ? {
              totalClients: dashboard.summary.totalClients,
              assignedClients: dashboard.summary.assignedClients,
              pendingClients: dashboard.summary.pendingClients,
              reportDate: dashboard.summary.reportDate,
              reportUpdatedAt: dashboard.summary.reportUpdatedAt,
              cargadoHoyTotal: dashboard.summary.cargadoHoyTotal,
              cargadoMesTotal: dashboard.summary.cargadoMesTotal,
              hasReport: dashboard.summary.hasReport
            }
          : null,
        financialInputs: {
          month: dashboard.financialInputs.month,
          adSpendArs: dashboard.financialInputs.adSpendArs,
          commissionPct: dashboard.financialInputs.commissionPct
        },
        primaryKpis: {
          cargadoMesArs: dashboard.primaryKpis.cargadoMesArs,
          gananciaEstimadaArs: dashboard.primaryKpis.gananciaEstimadaArs,
          roiEstimadoPct: dashboard.primaryKpis.roiEstimadoPct,
          costoPorLeadRealArs: dashboard.primaryKpis.costoPorLeadRealArs,
          conversionAsignadoPct: dashboard.primaryKpis.conversionAsignadoPct
        },
        statsKpis: {
          clientesTotales: dashboard.statsKpis.clientesTotales,
          asignados: dashboard.statsKpis.asignados,
          pendientes: dashboard.statsKpis.pendientes,
          cargadoHoyArs: dashboard.statsKpis.cargadoHoyArs,
          cargadoMesArs: dashboard.statsKpis.cargadoMesArs,
          intakesMes: dashboard.statsKpis.intakesMes,
          reingresosMes: dashboard.statsKpis.reingresosMes,
          asignacionesMes: dashboard.statsKpis.asignacionesMes,
          asignacionesBacklogMes: dashboard.statsKpis.asignacionesBacklogMes,
          tasaIntakeAsignacionPct: dashboard.statsKpis.tasaIntakeAsignacionPct,
          clientesConReporte: dashboard.statsKpis.clientesConReporte,
          promedioCargaGeneralArs: dashboard.statsKpis.promedioCargaGeneralArs,
          tasaActivacionPct: dashboard.statsKpis.tasaActivacionPct
        },
        charts: {
          monthlyTrend: dashboard.charts.monthlyTrend.map((point) => ({
            month: point.month,
            reportDate: point.reportDate,
            cargadoMesArs: point.cargadoMesArs
          }))
        },
        clientes: dashboard.clientes.map((client) => ({
          id: client.id,
          username: client.username,
          telefono: client.telefono,
          pagina: client.pagina,
          estado: client.estado,
          ownerKey: client.ownerKey,
          ownerLabel: client.ownerLabel,
          cargadoHoy: client.cargadoHoy,
          cargadoMes: client.cargadoMes,
          reportDate: client.reportDate,
          isNewIntakeMes: client.isNewIntakeMes,
          isReingresoMes: client.isReingresoMes,
          assignedEnMes: client.assignedEnMes,
          assignedDesdeBacklogMes: client.assignedDesdeBacklogMes
        }))
      });
    } catch (error) {
      const mappedError = toMastercrmHttpError(error);
      if (mappedError) {
        return reply.code(mappedError.statusCode).send({ message: mappedError.message });
      }

      logger.error({ error }, 'Unexpected /mastercrm-clients error');
      return reply.code(500).send({ message: 'Unexpected mastercrm auth error' });
    }
  });

  fastify.post('/mastercrm-owner-financials', async (request, reply) => {
    const parsed = parseMastercrmOwnerFinancialsPayload(request.body);
    if (!parsed.data) {
      return reply.code(400).send({
        message: 'Invalid payload',
        issues: parsed.issues
      });
    }

    try {
      const financialInputs = await getMastercrmUserStore().upsertOwnerFinancials({
        userId: parsed.data.userId,
        month: parsed.data.month,
        adSpendArs: parsed.data.adSpendArs,
        commissionPct: parsed.data.commissionPct
      });

      return reply.code(200).send({
        month: financialInputs.month,
        adSpendArs: financialInputs.adSpendArs,
        commissionPct: financialInputs.commissionPct
      });
    } catch (error) {
      const mappedError = toMastercrmHttpError(error);
      if (mappedError) {
        return reply.code(mappedError.statusCode).send({ message: mappedError.message });
      }

      logger.error({ error }, 'Unexpected /mastercrm-owner-financials error');
      return reply.code(500).send({ message: 'Unexpected mastercrm auth error' });
    }
  });

  fastify.post('/mastercrm-link-cashier', async (request, reply) => {
    const parsed = parseMastercrmLinkCashierPayload(request.body);
    if (!parsed.data) {
      return reply.code(400).send({
        success: false,
        message: 'Faltan datos requeridos',
        issues: parsed.issues
      });
    }

    try {
      const configuredStaffPassword = resolveMastercrmStaffLinkPassword();
      if (parsed.data.staffPassword !== configuredStaffPassword) {
        return reply.code(403).send({
          success: false,
          message: 'Clave tecnica invalida'
        });
      }

      const link = await getMastercrmUserStore().linkCashierToUser({
        userId: parsed.data.userId,
        ownerKey: normalizeMastercrmOwnerKey(parsed.data.ownerKey)
      });

      return reply.code(201).send({
        success: true,
        message: 'Usuario vinculado al cajero correctamente',
        data: {
          user_id: link.userId,
          owner_key: link.ownerKey,
          owner_label: link.ownerLabel,
          pagina: link.pagina,
          linked: link.linked,
          replaced: link.replaced,
          previous_owner_key: link.previousOwnerKey
        }
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'MASTERCRM_STAFF_LINK_PASSWORD is not configured') {
        return reply.code(500).send({ success: false, message: 'Clave tecnica no configurada en backend' });
      }

      const mappedError = toMastercrmHttpError(error);
      if (mappedError) {
        if (mappedError.statusCode === 400) {
          return reply.code(400).send({ success: false, message: 'Faltan datos requeridos' });
        }
        if (mappedError.statusCode === 404) {
          return reply.code(404).send({ success: false, message: 'Usuario o cajero no encontrado' });
        }
        if (mappedError.statusCode === 409) {
          return reply.code(409).send({ success: false, message: 'El usuario ya esta vinculado a ese cajero' });
        }
      }

      logger.error({ error }, 'Unexpected /mastercrm-link-cashier error');
      return reply.code(500).send({ success: false, message: 'Error interno del servidor' });
    }
  });

  fastify.post('/users/create-player', async (request, reply) => {
    const parsed = createPlayerBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: 'Invalid payload',
        issues: toValidationIssues(parsed.error)
      });
    }

    const payload = parsed.data;
    const createdAt = new Date().toISOString();
    const id = randomUUID();
    const jobRequest: CreatePlayerJobRequest = {
      id,
      jobType: 'create-player',
      createdAt,
      payload: {
        pagina: payload.pagina,
        loginUsername: payload.loginUsername,
        loginPassword: payload.loginPassword,
        newUsername: payload.newUsername,
        newPassword: payload.newPassword,
        ...(payload.telefono ? { telefono: payload.telefono } : {}),
        ...(payload.ownerContext ? { ownerContext: payload.ownerContext } : {}),
        stepsOverride: payload.stepsOverride
      },
      options: resolveExecutionOptions(appConfig, payload)
    };

    internalQueue.enqueue(jobRequest);

    return reply.code(202).send({
      jobId: id,
      status: 'queued',
      statusUrl: `/jobs/${id}`
    });
  });

  fastify.post('/users/intake-pending', async (request, reply) => {
    const parsed = intakePendingBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: 'Invalid payload',
        code: 'INVALID_PAYLOAD',
        details: {
          issues: toValidationIssues(parsed.error)
        }
      });
    }

    try {
      const payload = parsed.data;
      const intake = await getPlayerPhoneStore().intakePendingCliente({
        pagina: payload.pagina,
        telefono: payload.telefono,
        ownerContext: payload.ownerContext,
        ...(payload.sourceContext ? { sourceContext: payload.sourceContext } : {})
      });

      if (
        metaEnabled &&
        metaLeadEnabled &&
        intake.ownerId &&
        intake.clientId &&
        payload.sourceContext &&
        isAttributableMetaSourceContext(payload.sourceContext)
      ) {
        try {
          await getMetaConversionsStore().enqueueLead({
            ownerId: intake.ownerId,
            clientId: intake.clientId,
            phoneE164: payload.telefono,
            ownerContext: payload.ownerContext,
            sourceContext: payload.sourceContext,
            ...(payload.sourceContext.receivedAt ? { eventTime: payload.sourceContext.receivedAt } : {})
          });
        } catch (error) {
          logger.warn(
            {
              error,
              ownerId: intake.ownerId,
              clientId: intake.clientId,
              telefono: payload.telefono
            },
            'Meta attributable lead enqueue failed after intake persistence'
          );
        }
      }

      return reply.code(200).send({
        status: 'ok',
        cajeroId: intake.cajeroId,
        jugadorId: intake.jugadorId,
        linkId: intake.linkId,
        estado: intake.estado,
        ...(intake.ownerId ? { ownerId: intake.ownerId } : {})
      });
    } catch (error) {
      const mappedError = toHttpError(error);
      if (mappedError) {
        return reply.code(mappedError.statusCode).send({
          message: mappedError.message,
          code: mappedError.code,
          ...(mappedError.details ? { details: mappedError.details } : {})
        });
      }

      logger.error({ error }, 'Unexpected /users/intake-pending error');
      return reply.code(500).send({ message: 'Unexpected persistence error' });
    }
  });

  fastify.post('/users/assign-phone', async (request, reply) => {
    const parsed = assignPhoneBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: 'Invalid payload',
        code: 'INVALID_PAYLOAD',
        details: {
          issues: toValidationIssues(parsed.error)
        }
      });
    }

    if (parsed.data.pagina !== 'ASN') {
      return reply.code(501).send({
        message: 'assign-phone with ASN existence check is implemented only for ASN',
        code: 'UNSUPPORTED_PAGINA',
        details: { pagina: parsed.data.pagina }
      });
    }

    try {
      await asnUserExistsChecker({
        usuario: parsed.data.usuario,
        agente: parsed.data.agente,
        contrasenaAgente: parsed.data.contrasena_agente,
        appConfig,
        logger
      });

      const store = getPlayerPhoneStore();
      const assignment = await store.assignUsernameByPhone({
        pagina: parsed.data.pagina,
        jugadorUsername: parsed.data.usuario,
        telefono: parsed.data.telefono,
        ownerContext: parsed.data.ownerContext
      });

      return reply.code(200).send({
        status: 'ok',
        overwritten: assignment.overwritten,
        previousUsername: assignment.previousUsername,
        currentUsername: assignment.currentUsername,
        ...(assignment.createdClient ? { createdClient: true } : {}),
        ...(assignment.createdLink ? { createdLink: true } : {}),
        ...(assignment.movedFromPhone ? { movedFromPhone: assignment.movedFromPhone } : {}),
        ...(assignment.deletedOldPhone ? { deletedOldPhone: true } : {})
      });
    } catch (error) {
      if (error instanceof AsnUserCheckError) {
        if (error.code === 'NOT_FOUND') {
          return reply.code(404).send(buildAsnUserNotFoundResponse(parsed.data.usuario));
        }
        logger.error({ error }, 'Unexpected ASN user existence checker error');
        return reply.code(500).send({
          message: 'No se pudo verificar el usuario en ASN',
          code: 'ASN_USER_CHECK_FAILED',
          details: { usuario: parsed.data.usuario }
        });
      }

      const mappedError = toHttpError(error);
      if (mappedError) {
        if (mappedError.code === 'USERNAME_ALREADY_EXISTS_IN_PAGINA') {
          return reply.code(409).send({
            message: 'Ese usuario ya esta vinculado a otro numero dentro de ASN',
            code: mappedError.code,
            ...(mappedError.details ? { details: mappedError.details } : {})
          });
        }
        if (mappedError.code === 'PHONE_ALREADY_ASSIGNED_FOR_OWNER') {
          return reply.code(409).send({
            message: 'Ese numero ya tiene otro usuario asignado para este cajero',
            code: mappedError.code,
            ...(mappedError.details ? { details: mappedError.details } : {})
          });
        }
        if (mappedError.code === 'OWNER_CLIENT_LINK_NOT_FOUND') {
          return reply.code(404).send({
            message: 'No se encontro el cliente dentro de la cartera del cajero',
            code: mappedError.code,
            ...(mappedError.details ? { details: mappedError.details } : {})
          });
        }
        return reply.code(mappedError.statusCode).send({
          message: mappedError.message,
          code: mappedError.code,
          ...(mappedError.details ? { details: mappedError.details } : {})
        });
      }

      logger.error({ error }, 'Unexpected /users/assign-phone error');
      return reply.code(500).send({
        message: 'Unexpected persistence error',
        code: 'UNEXPECTED_PERSISTENCE_ERROR'
      });
    }
  });

  fastify.post('/users/unassign-phone', async (request, reply) => {
    const parsed = unassignPhoneBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: 'Invalid payload',
        code: 'INVALID_PAYLOAD',
        details: {
          issues: toValidationIssues(parsed.error)
        }
      });
    }

    try {
      const store = getPlayerPhoneStore();
      const unassignment = await store.unassignUsernameByPhone({
        pagina: parsed.data.pagina,
        telefono: parsed.data.telefono,
        ownerContext: parsed.data.ownerContext
      });

      return reply.code(200).send({
        status: 'ok',
        previousUsername: unassignment.previousUsername,
        currentStatus: unassignment.currentStatus,
        unlinked: unassignment.unlinked
      });
    } catch (error) {
      const mappedError = toHttpError(error);
      if (mappedError) {
        if (mappedError.code === 'OWNER_CLIENT_LINK_NOT_FOUND') {
          return reply.code(404).send({
            message: 'No se encontro el cliente dentro de la cartera del cajero',
            code: mappedError.code,
            ...(mappedError.details ? { details: mappedError.details } : {})
          });
        }

        return reply.code(mappedError.statusCode).send({
          message: mappedError.message,
          code: mappedError.code,
          ...(mappedError.details ? { details: mappedError.details } : {})
        });
      }

      logger.error({ error }, 'Unexpected /users/unassign-phone error');
      return reply.code(500).send({
        message: 'Unexpected persistence error',
        code: 'UNEXPECTED_PERSISTENCE_ERROR'
      });
    }
  });

  fastify.post('/users/deposit', async (request, reply) => {
    const parsed = depositBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: 'Invalid payload',
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
      });
    }

    const payload = parsed.data;
    if (payload.operacion === 'reporte') {
      if (payload.pagina !== 'ASN') {
        return reply.code(501).send({
          message: 'report operation is implemented only for ASN'
        });
      }

      const createdAt = new Date().toISOString();
      const id = randomUUID();
      const reportRequest: AsnReportJobRequest = {
        id,
        jobType: 'report',
        createdAt,
        payload: {
          pagina: 'ASN',
          operacion: 'reporte',
          usuario: payload.usuario,
          agente: payload.agente,
          contrasena_agente: payload.contrasena_agente,
          ...(typeof payload.cantidad === 'number' ? { cantidad: payload.cantidad } : {})
        },
        options: resolveDepositExecutionOptions(appConfig, payload, payload.pagina)
      };

      internalQueue.enqueue(reportRequest);

      return reply.code(202).send({
        jobId: id,
        status: 'queued',
        statusUrl: `/jobs/${id}`
      });
    }

    if (payload.pagina === 'ASN') {
      try {
        await asnUserExistsChecker({
          usuario: payload.usuario,
          agente: payload.agente,
          contrasenaAgente: payload.contrasena_agente,
          appConfig,
          logger
        });
      } catch (error) {
        if (error instanceof AsnUserCheckError && error.code === 'NOT_FOUND') {
          return reply.code(404).send(buildAsnUserNotFoundResponse(payload.usuario));
        }

        logger.warn(
          { error, usuario: payload.usuario, operacion: payload.operacion },
          'ASN user precheck was inconclusive; continuing with turbo job enqueue'
        );
      }
    }

    const createdAt = new Date().toISOString();
    const id = randomUUID();
    const jobRequest: DepositJobRequest | BalanceJobRequest =
      payload.operacion === 'consultar_saldo'
        ? {
            id,
            jobType: 'balance',
            createdAt,
            payload: {
              operacion: 'consultar_saldo',
              pagina: payload.pagina,
              usuario: payload.usuario,
              agente: payload.agente,
              contrasena_agente: payload.contrasena_agente,
              ...(typeof payload.cantidad === 'number' ? { cantidad: payload.cantidad } : {})
            },
            options: resolveDepositExecutionOptions(appConfig, payload, payload.pagina)
          }
        : {
            id,
            jobType: 'deposit',
            createdAt,
            payload:
              payload.operacion === 'descarga_total'
                ? {
                    operacion: 'descarga_total',
                    pagina: payload.pagina,
                    usuario: payload.usuario,
                    agente: payload.agente,
                    contrasena_agente: payload.contrasena_agente,
                    ...(typeof payload.cantidad === 'number' ? { cantidad: payload.cantidad } : {})
                  }
                : {
                    operacion: payload.operacion,
                    pagina: payload.pagina,
                    usuario: payload.usuario,
                    agente: payload.agente,
                    contrasena_agente: payload.contrasena_agente,
                    cantidad: payload.cantidad as number
                  },
            options: resolveDepositExecutionOptions(appConfig, payload, payload.pagina)
          };

    internalQueue.enqueue(jobRequest);

    return reply.code(202).send({
      jobId: id,
      status: 'queued',
      statusUrl: `/jobs/${id}`
    });
  });

  fastify.post('/reports/asn/run', async (request, reply) => {
    const parsed = reportRunBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: 'Invalid payload',
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
      });
    }

    let runId: string | null = null;
    try {
      const payload = parsed.data;
      const store = getReportRunStore();
      const run = await store.createRun({
        pagina: 'ASN',
        principalKey: payload.principalKey,
        reportDate: payload.reportDate ?? getBuenosAiresDateToken(),
        agente: payload.agente,
        contrasenaAgente: payload.contrasena_agente
      });
      runId = run.id;
      await store.enqueueRunItemsFromPrincipal(run.id, payload.principalKey);

      return reply.code(202).send({
        runId: run.id,
        status: 'queued',
        statusUrl: `/reports/asn/run/${run.id}`
      });
    } catch (error) {
      if (runId) {
        await getReportRunStore()
          .deleteRun(runId)
          .catch((cleanupError) => logger.warn({ error: cleanupError, runId }, 'Could not clean report run after enqueue failure'));
      }

      const mappedError = toReportHttpError(error);
      if (mappedError) {
        return reply.code(mappedError.statusCode).send({ message: mappedError.message });
      }

      logger.error({ error }, 'Unexpected /reports/asn/run error');
      return reply.code(500).send({ message: 'Unexpected report persistence error' });
    }
  });

  fastify.get('/reports/asn/run/:runId', async (request, reply) => {
    const parsed = reportRunParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ message: 'Invalid run id' });
    }

    try {
      const run = await getReportRunStore().getRunById(parsed.data.runId);
      return reply.send(run);
    } catch (error) {
      const mappedError = toReportHttpError(error);
      if (mappedError) {
        return reply.code(mappedError.statusCode).send({ message: mappedError.message });
      }

      logger.error({ error }, 'Unexpected /reports/asn/run/:runId error');
      return reply.code(500).send({ message: 'Unexpected report persistence error' });
    }
  });

  fastify.get('/reports/asn/run/:runId/items', async (request, reply) => {
    const parsedParams = reportRunParamsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ message: 'Invalid run id' });
    }

    const parsedQuery = reportRunItemsQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply.code(400).send({
        message: 'Invalid query',
        issues: parsedQuery.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
      });
    }

    try {
      const page = await getReportRunStore().listRunItems(
        parsedParams.data.runId,
        parsedQuery.data.limit ?? 100,
        parsedQuery.data.offset ?? 0
      );
      return reply.send(page);
    } catch (error) {
      const mappedError = toReportHttpError(error);
      if (mappedError) {
        return reply.code(mappedError.statusCode).send({ message: mappedError.message });
      }

      logger.error({ error }, 'Unexpected /reports/asn/run/:runId/items error');
      return reply.code(500).send({ message: 'Unexpected report persistence error' });
    }
  });

  fastify.get('/jobs/:id', async (request, reply) => {
    const parsed = jobParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ message: 'Invalid job id' });
    }

    const entry = internalQueue.getById(parsed.data.id);
    if (!entry) {
      return reply.code(404).send({ message: 'Job not found' });
    }

    return reply.send(formatJobEntryForHttp(entry));
  });

  fastify.addHook('onClose', async () => {
    if (reportWorker) {
      await reportWorker.stop();
    }
    if (metaWorker) {
      await metaWorker.stop();
    }
    await internalQueue.shutdown();
  });

  return fastify;
}

export async function startServer(appConfig: AppConfig, serverConfig: ServerConfig, logger: Logger): Promise<void> {
  const server = createServer(appConfig, serverConfig, logger);

  await server.listen({ host: serverConfig.host, port: serverConfig.port });
  logger.info(
    {
      host: serverConfig.host,
      port: serverConfig.port,
      loginConcurrency: serverConfig.loginConcurrency,
      jobTtlMinutes: serverConfig.jobTtlMinutes
    },
    'Login API server started'
  );
}
