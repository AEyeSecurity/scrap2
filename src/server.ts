import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
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
import {
  buildLandingMetaConversionsConfigFromEnv,
  buildMetaConversionsConfigFromEnv,
  MetaConversionsHttpDispatcher,
  MetaConversionsRoutingDispatcher,
  type MetaConversionsDispatcher
} from './meta-conversions';
import {
  createLandingSessionStoreFromEnv,
  landingSessionToSourceContext,
  LandingSessionStoreError,
  normalizeLandingMessageKey,
  type LandingSessionRecord,
  type LandingSessionStore
} from './landing-session-store';
import {
  createMetaConversionsStoreFromEnv,
  type MetaConversionsStore
} from './meta-conversions-store';
import { MetaConversionsWorker } from './meta-conversions-worker';
import {
  buildStoredMetaSourcePayload,
  isAttributableMetaSourceContext,
  isLandingMetaSourceContext,
  normalizeMetaSourceContext
} from './meta-source-context';
import {
  createMastercrmUserStoreFromEnv,
  normalizeMastercrmNombre,
  normalizeMastercrmOwnerKey,
  normalizeMastercrmTelefono,
  normalizeMastercrmUsername,
  toMastercrmHttpError,
  type DistributeMastercrmMarketingBudgetsInput,
  type MastercrmUserRecord,
  type MastercrmUserStore
} from './mastercrm-user-store';
import {
  createMastercrmRetentionStoreFromEnv,
  MastercrmRetentionWorker,
  type MastercrmRetentionStore
} from './mastercrm-retention';
import {
  issueMastercrmSessionToken,
  readBearerToken,
  resolveMastercrmSessionSecret,
  secretsEqual,
  verifyMastercrmSessionToken,
  type MastercrmSessionClaims,
  MastercrmSessionError
} from './mastercrm-session';
import {
  createPlayerPhoneStoreFromEnv,
  normalizePhone,
  toHttpError,
  type PlayerPhoneStore
} from './player-phone-store';
import {
  createReportRunStoreFromEnv,
  toHttpError as toReportHttpError,
  type ReportRunStore
} from './report-run-store';
import { createReportJobExecutor, ReportRunWorker, type ReportJobExecutor } from './report-worker';
import { runRdaReportJob } from './rda-report-job';
import { assertRdaUserExists, RdaUserCheckError, type AssertRdaUserExistsInput } from './rda-user-check';
import { paginaCodeSchema } from './site-profile';
import type {
  AppConfig,
  AsnReportJobRequest,
  BalanceJobRequest,
  CreatePlayerJobRequest,
  DepositJobRequest,
  FundsOperation,
  JobExecutionOptions,
  JobRequest,
  JobResult,
  JobStoreEntry,
  LoginJobRequest,
  MetaCustomerData,
  MetaSourceContext,
  OwnerContext,
  PaginaCode,
  ReportJobRequest,
  RdaReportJobRequest,
  ServerConfig
} from './types';

interface JobQueue {
  enqueue(request: JobRequest): string;
  getById(id: string): JobStoreEntry | undefined;
  shutdown(): Promise<void>;
}

interface ServerDependencies {
  mastercrmUserStore?: MastercrmUserStore;
  mastercrmSessionSecret?: string;
  playerPhoneStore?: PlayerPhoneStore;
  landingSessionStore?: LandingSessionStore;
  reportRunStore?: ReportRunStore;
  mastercrmRetentionStore?: MastercrmRetentionStore;
  metaConversionsStore?: MetaConversionsStore;
  asnUserExistsChecker?: (input: AssertAsnUserExistsInput) => Promise<void>;
  rdaUserExistsChecker?: (input: AssertRdaUserExistsInput) => Promise<void>;
  metaEnabled?: boolean;
  metaWorkerEnabled?: boolean;
  metaWorkerConcurrency?: number;
  metaWorkerPollMs?: number;
  metaWorkerLeaseSeconds?: number;
  metaWorkerMaxAttempts?: number;
  metaWorkerScanLimit?: number;
  metaWorkerBatchSize?: number;
  metaConversionsDispatcher?: MetaConversionsDispatcher;
  landingMetaConversionsDispatcher?: MetaConversionsDispatcher;
  reportWorkerEnabled?: boolean;
  reportWorkerConcurrency?: number;
  reportWorkerPollMs?: number;
  reportWorkerMaxPollMs?: number;
  reportWorkerLeaseSeconds?: number;
  reportWorkerMaxAttempts?: number;
  reportJobExecutor?: ReportJobExecutor;
  retentionWorkerEnabled?: boolean;
  retentionRunOnStart?: boolean;
  retentionPollMs?: number;
}

interface ValidationIssue {
  path: string;
  message: string;
}

const LANDING_PUBLIC_DIR = join(process.cwd(), 'public', 'landing');
const LANDING_BOT_WHATSAPP_PHONES = ['5493515747477'] as const;
const LANDING_BOT_WHATSAPP_PHONE = LANDING_BOT_WHATSAPP_PHONES[0];
const LANDING_CASHIER_WHATSAPP_PHONE = '5493516549344';
const LANDING_WHATSAPP_MESSAGE = 'Hola quiero mi usuario suertudo del Rey Dorado';
const LANDING_WHATSAPP_URL = `https://wa.me/${LANDING_BOT_WHATSAPP_PHONE}?text=${encodeURIComponent(
  LANDING_WHATSAPP_MESSAGE
)}`;
const LANDING_VARIANT = 'rda-luqui10-v1';
const LANDING_OWNER_CONTEXT: OwnerContext = {
  ownerKey: 'luqui10:luqui10',
  ownerLabel: 'Lucas10',
  actorAlias: 'luqui10',
  actorPhone: `+${LANDING_CASHIER_WHATSAPP_PHONE}`
};
const LANDING_PRIMARY_DESCRIPTOR = 'Rey Dorado';
const LANDING_DESCRIPTOR_BASES = [
  'Mesa',
  'Corona',
  'Suerte',
  'Sala',
  'Jugada',
  'Mano',
  'Ficha',
  'Banca',
  'Entrada',
  'Partida'
];
const LANDING_DESCRIPTOR_QUALIFIERS = ['Verde', 'Real', 'Dorada', 'Premium', 'Mayor', 'Central', 'Ganadora'];
const LANDING_DESCRIPTOR_SUFFIXES = ['del Rey', 'de Ases', 'del Mono', 'de la Corona', 'de la Mesa', 'del Trono', 'de la Sala', 'del Reino'];
const LANDING_DESCRIPTOR_ATTEMPTS =
  1 + LANDING_DESCRIPTOR_BASES.length * LANDING_DESCRIPTOR_QUALIFIERS.length * LANDING_DESCRIPTOR_SUFFIXES.length;
const LANDING_ASSET_VERSION = process.env.LANDING_ASSET_VERSION?.trim() || Date.now().toString(36);
const LANDING_RDAV2_VARIANT = 'rda-luqui10-rdav2';
const LANDING_RDAV2_BOT_WHATSAPP_PHONE = '5493516346253';
const LANDING_RDAV2_MESSAGE_PREFIX = 'Hola quiero un usuario, el codigo de mi bono es:';
const LANDING_RDAV2_BONUS_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LANDING_RDAV2_BONUS_CODE_LENGTH = 5;
const LANDING_RDAV2_BONUS_CODE_ATTEMPTS = 64;

interface LandingPublicConfig {
  pixelId: string | null;
  contactEndpoint: string;
  whatsappUrl: string;
  whatsappPhone: string;
  whatsappPhones: string[];
  whatsappMessage: string;
  landingVariant: string;
  ownerKey: string;
  ownerLabel: string;
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
  fbp: z.string().trim().min(1).nullable().optional(),
  fbc: z.string().trim().min(1).nullable().optional(),
  fbclid: z.string().trim().min(1).nullable().optional(),
  referralSourceId: z.string().trim().min(1).nullable().optional(),
  referralSourceUrl: z.string().trim().min(1).nullable().optional(),
  referralHeadline: z.string().trim().min(1).nullable().optional(),
  referralBody: z.string().trim().min(1).nullable().optional(),
  referralSourceType: z.string().trim().min(1).nullable().optional(),
  eventSourceUrl: z.string().trim().min(1).nullable().optional(),
  referrer: z.string().trim().min(1).nullable().optional(),
  landingSessionId: z.string().trim().min(1).nullable().optional(),
  landingVariant: z.string().trim().min(1).nullable().optional(),
  ctaType: z.string().trim().min(1).nullable().optional(),
  utmSource: z.string().trim().min(1).nullable().optional(),
  utmMedium: z.string().trim().min(1).nullable().optional(),
  utmId: z.string().trim().min(1).nullable().optional(),
  utmCampaign: z.string().trim().min(1).nullable().optional(),
  utmContent: z.string().trim().min(1).nullable().optional(),
  utmTerm: z.string().trim().min(1).nullable().optional(),
  adsetId: z.string().trim().min(1).nullable().optional(),
  adId: z.string().trim().min(1).nullable().optional(),
  placement: z.string().trim().min(1).nullable().optional(),
  consentMarketing: z.boolean().nullable().optional(),
  consentTimestamp: z.string().trim().min(1).nullable().optional(),
  whatsappUrl: z.string().trim().min(1).nullable().optional(),
  waId: z.string().trim().min(1).nullable().optional(),
  messageSid: z.string().trim().min(1).nullable().optional(),
  accountSid: z.string().trim().min(1).nullable().optional(),
  profileName: z.string().trim().min(1).nullable().optional(),
  clientIpAddress: z.string().trim().min(1).nullable().optional(),
  clientUserAgent: z.string().trim().min(1).nullable().optional(),
  receivedAt: z.string().trim().min(1).nullable().optional()
});

const metaCustomerDataSchema = z.object({
  email: z.string().trim().min(1).nullable().optional(),
  firstName: z.string().trim().min(1).nullable().optional(),
  lastName: z.string().trim().min(1).nullable().optional(),
  fullName: z.string().trim().min(1).nullable().optional()
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
    if (value.pagina === 'RdA' && value.newPassword.trim().length < 6) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['newPassword'],
        message: 'RdA newPassword must be at least 6 characters'
      });
    }

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
  sourceContext: sourceContextSchema.optional(),
  customerData: metaCustomerDataSchema.optional()
});

const whatsappPayloadBodySchema = z.record(z.string(), z.unknown());

const whatsappIntakeBodySchema = z.object({
  pagina: paginaCodeSchema,
  telefono: z.string().trim().min(1).nullable().optional(),
  body: whatsappPayloadBodySchema.optional(),
  ownerContext: ownerContextSchema.optional(),
  sourceContext: sourceContextSchema.optional(),
  customerData: metaCustomerDataSchema.optional()
});

const landingContactBodySchema = z
  .object({
    eventId: z.string().trim().min(1),
    landingSessionId: z.string().trim().min(1),
    landingVariant: z.string().trim().min(1).nullable().optional(),
    routingSeed: z.string().trim().min(1),
    fbp: z.string().trim().min(1).nullable().optional(),
    fbc: z.string().trim().min(1).nullable().optional(),
    fbclid: z.string().trim().min(1).nullable().optional(),
    eventSourceUrl: z.string().trim().min(1).nullable().optional(),
    referrer: z.string().trim().min(1).nullable().optional(),
    utmSource: z.string().trim().min(1).nullable().optional(),
    utmMedium: z.string().trim().min(1).nullable().optional(),
    utmId: z.string().trim().min(1).nullable().optional(),
    utmCampaign: z.string().trim().min(1).nullable().optional(),
    utmContent: z.string().trim().min(1).nullable().optional(),
    utmTerm: z.string().trim().min(1).nullable().optional(),
    adsetId: z.string().trim().min(1).nullable().optional(),
    adId: z.string().trim().min(1).nullable().optional(),
    placement: z.string().trim().min(1).nullable().optional(),
    consentMarketing: z.boolean().nullable().optional(),
    consentTimestamp: z.string().trim().min(1).nullable().optional(),
    whatsappUrl: z.string().trim().min(1).nullable().optional(),
    bonusCode: z.string().trim().regex(/^[A-Z0-9]{5}$/).nullable().optional()
  })
  .passthrough();

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
  pagina: paginaCodeSchema,
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
    celular: z.string().optional(),
    staff_password: z.string().optional()
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
    pagina: paginaCodeSchema.optional(),
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

const mastercrmAnalyticsBodySchema = z
  .object({
    id: z.union([z.string(), z.number().int()]).optional(),
    user_id: z.union([z.string(), z.number().int()]).optional(),
    usuario_id: z.union([z.string(), z.number().int()]).optional(),
    date_from: z.string().optional(),
    date_to: z.string().optional(),
    fecha_desde: z.string().optional(),
    fecha_hasta: z.string().optional(),
    channel: z.enum(['all', 'landing', 'meta_ctwa']).optional(),
    canal: z.enum(['all', 'landing', 'meta_ctwa']).optional(),
    campaign_key: z.string().optional(),
    campana_key: z.string().optional(),
    ad_key: z.string().optional(),
    anuncio_key: z.string().optional()
  })
  .passthrough();

const mastercrmMarketingBudgetBodySchema = z
  .object({
    id: z.string().optional(),
    user_id: z.union([z.string(), z.number().int()]).optional(),
    channel: z.enum(['landing', 'meta_ctwa']).optional(),
    canal: z.enum(['landing', 'meta_ctwa']).optional(),
    level: z.enum(['campaign', 'ad']).optional(),
    nivel: z.enum(['campaign', 'ad']).optional(),
    campaign_key: z.string().optional(),
    campaign_name: z.string().optional(),
    campana_key: z.string().optional(),
    campana_nombre: z.string().optional(),
    ad_key: z.string().nullable().optional(),
    ad_name: z.string().nullable().optional(),
    anuncio_key: z.string().nullable().optional(),
    anuncio_nombre: z.string().nullable().optional(),
    link_url: z.string().nullable().optional(),
    daily_budget_ars: z.union([z.string(), z.number()]).optional(),
    presupuesto_diario_ars: z.union([z.string(), z.number()]).optional(),
    active_from: z.string().optional(),
    active_to: z.string().nullable().optional(),
    vigente_desde: z.string().optional(),
    vigente_hasta: z.string().nullable().optional()
  })
  .passthrough();

const mastercrmMarketingBudgetDistributeBodySchema = z
  .object({
    user_id: z.union([z.string(), z.number().int()]).optional(),
    total_daily_budget_ars: z.union([z.string(), z.number()]).optional(),
    presupuesto_diario_total_ars: z.union([z.string(), z.number()]).optional(),
    active_from: z.string().optional(),
    active_to: z.string().nullable().optional(),
    vigente_desde: z.string().optional(),
    vigente_hasta: z.string().nullable().optional(),
    ads: z
      .array(
        z
          .object({
            channel: z.enum(['landing', 'meta_ctwa']).optional(),
            canal: z.enum(['landing', 'meta_ctwa']).optional(),
            campaign_key: z.string().optional(),
            campaign_name: z.string().optional(),
            campana_key: z.string().optional(),
            campana_nombre: z.string().optional(),
            ad_key: z.string().optional(),
            ad_name: z.string().nullable().optional(),
            anuncio_key: z.string().optional(),
            anuncio_nombre: z.string().nullable().optional(),
            link_url: z.string().nullable().optional()
          })
          .passthrough()
      )
      .optional()
  })
  .passthrough();

const mastercrmMarketingBudgetDeleteBodySchema = z
  .object({
    user_id: z.union([z.string(), z.number().int()]).optional(),
    id: z.string().optional(),
    budget_id: z.string().optional()
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

function readOptionalStringField(payload: Record<string, unknown> | undefined, key: string): string | null {
  if (!payload) {
    return null;
  }

  const value = payload[key];
  if (value == null) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeWhatsappPhone(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const digits = value.replace(/\D/g, '');
  if (!digits) {
    return null;
  }

  return normalizePhone(`+${digits}`);
}

function resolveWhatsappIntakePhone(input: {
  telefono?: string | null;
  body?: Record<string, unknown>;
}): string | null {
  return (
    normalizeWhatsappPhone(input.telefono ?? null) ??
    normalizeWhatsappPhone(readOptionalStringField(input.body, 'WaId')) ??
    normalizeWhatsappPhone(readOptionalStringField(input.body, 'From'))
  );
}

function compactMetaSourceContext(input: MetaSourceContext): MetaSourceContext | null {
  const normalized = normalizeMetaSourceContext(input);
  if (!normalized) {
    return null;
  }

  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value != null)) as MetaSourceContext;
}

function buildWhatsappSourceContext(
  body: Record<string, unknown> | undefined,
  explicitSourceContext: MetaSourceContext | undefined
): MetaSourceContext | null {
  if (explicitSourceContext) {
    return compactMetaSourceContext(explicitSourceContext);
  }

  return compactMetaSourceContext({
    ctwaClid: readOptionalStringField(body, 'ReferralCtwaClid'),
    referralSourceId: readOptionalStringField(body, 'ReferralSourceId'),
    referralSourceUrl: readOptionalStringField(body, 'ReferralSourceUrl'),
    referralHeadline: readOptionalStringField(body, 'ReferralHeadline'),
    referralBody: readOptionalStringField(body, 'ReferralBody'),
    referralSourceType: readOptionalStringField(body, 'ReferralSourceType'),
    waId: readOptionalStringField(body, 'WaId'),
    messageSid: readOptionalStringField(body, 'MessageSid'),
    accountSid: readOptionalStringField(body, 'AccountSid'),
    profileName: readOptionalStringField(body, 'ProfileName'),
    clientIpAddress: readOptionalStringField(body, 'ClientIpAddress'),
    clientUserAgent: readOptionalStringField(body, 'ClientUserAgent'),
    receivedAt: readOptionalStringField(body, 'ReceivedAt')
  });
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

function isLandingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBooleanEnv(env.LANDING_ENABLED) ?? true;
}

function computeLandingDescriptorIndex(seed: string, attempt: number): number {
  if (attempt === 0) {
    return 0;
  }

  let hash = attempt * 17;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }

  return 1 + (hash % Math.max(1, LANDING_DESCRIPTOR_ATTEMPTS - 1));
}

function computeLandingBotPhoneIndex(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }

  return hash % LANDING_BOT_WHATSAPP_PHONES.length;
}

function resolveLandingBotWhatsappPhone(landingSessionId: string): string {
  return LANDING_BOT_WHATSAPP_PHONES[computeLandingBotPhoneIndex(landingSessionId)];
}

function buildLandingDescriptor(index: number): string {
  if (index === 0) {
    return LANDING_PRIMARY_DESCRIPTOR;
  }

  const zeroBased = index - 1;
  const suffixIndex = zeroBased % LANDING_DESCRIPTOR_SUFFIXES.length;
  const qualifierIndex =
    Math.floor(zeroBased / LANDING_DESCRIPTOR_SUFFIXES.length) % LANDING_DESCRIPTOR_QUALIFIERS.length;
  const baseIndex =
    Math.floor(zeroBased / (LANDING_DESCRIPTOR_SUFFIXES.length * LANDING_DESCRIPTOR_QUALIFIERS.length)) %
    LANDING_DESCRIPTOR_BASES.length;

  return `${LANDING_PRIMARY_DESCRIPTOR} de la ${LANDING_DESCRIPTOR_BASES[baseIndex]} ${LANDING_DESCRIPTOR_QUALIFIERS[qualifierIndex]} ${LANDING_DESCRIPTOR_SUFFIXES[suffixIndex]}`;
}

function buildLandingWhatsappMessage(landingSessionId: string, attempt: number): string {
  const descriptor = buildLandingDescriptor(computeLandingDescriptorIndex(landingSessionId, attempt));
  return `Hola quiero mi usuario suertudo del ${descriptor}`;
}

function buildLandingRdav2BonusCode(seed: string, attempt: number): string {
  let hash = attempt + 1;
  const input = `${seed}:${attempt}`;
  for (let index = 0; index < input.length; index += 1) {
    hash = Math.imul(hash ^ input.charCodeAt(index), 16777619) >>> 0;
  }

  let code = '';
  for (let index = 0; index < LANDING_RDAV2_BONUS_CODE_LENGTH; index += 1) {
    hash = Math.imul(hash ^ (hash >>> 16), 2246822507) >>> 0;
    code += LANDING_RDAV2_BONUS_CODE_ALPHABET[hash % LANDING_RDAV2_BONUS_CODE_ALPHABET.length];
  }
  return code;
}

function buildLandingRdav2WhatsappMessage(bonusCode: string): string {
  return `${LANDING_RDAV2_MESSAGE_PREFIX} ${bonusCode}`;
}

function buildLandingWhatsappUrl(phone: string, message: string): string {
  return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
}

function isLandingRdav2Variant(landingVariant: string | null | undefined): boolean {
  return landingVariant === LANDING_RDAV2_VARIANT;
}

function resolveLandingAllowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return parseListEnv(env.LANDING_ALLOWED_ORIGINS, resolveMastercrmCorsOrigins(env));
}

function isOriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (!origin) {
    return true;
  }

  return allowedOrigins.includes('*') || allowedOrigins.includes(origin);
}

function getLandingPixelId(env: NodeJS.ProcessEnv = process.env): string | null {
  const pixelId = env.META_PIXEL_ID?.trim();
  return pixelId && /^\d+$/.test(pixelId) ? pixelId : null;
}

function buildLandingPublicConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { landingVariant?: string } = {}
): LandingPublicConfig {
  const landingVariant = options.landingVariant ?? LANDING_VARIANT;
  const isRdav2 = isLandingRdav2Variant(landingVariant);
  const whatsappPhone = isRdav2 ? LANDING_RDAV2_BOT_WHATSAPP_PHONE : LANDING_BOT_WHATSAPP_PHONE;
  const whatsappMessage = isRdav2
    ? buildLandingRdav2WhatsappMessage('XXXXX')
    : LANDING_WHATSAPP_MESSAGE;

  return {
    pixelId: getLandingPixelId(env),
    contactEndpoint: '/landing/contact',
    whatsappUrl: buildLandingWhatsappUrl(whatsappPhone, whatsappMessage),
    whatsappPhone,
    whatsappPhones: isRdav2 ? [LANDING_RDAV2_BOT_WHATSAPP_PHONE] : [...LANDING_BOT_WHATSAPP_PHONES],
    whatsappMessage,
    landingVariant,
    ownerKey: LANDING_OWNER_CONTEXT.ownerKey,
    ownerLabel: LANDING_OWNER_CONTEXT.ownerLabel
  };
}

function escapeScriptJson(input: unknown): string {
  return JSON.stringify(input).replace(/</g, '\\u003c');
}

function buildMetaPixelNoscript(pixelId: string | null): string {
  if (!pixelId) {
    return '';
  }

  return `<noscript><img height="1" width="1" style="display:none" alt="" src="https://www.facebook.com/tr?id=${encodeURIComponent(
    pixelId
  )}&ev=PageView&noscript=1" /></noscript>`;
}

function landingContentType(filePath: string): string {
  if (filePath.endsWith('.css')) {
    return 'text/css; charset=utf-8';
  }
  if (filePath.endsWith('.js')) {
    return 'application/javascript; charset=utf-8';
  }
  if (filePath.endsWith('.svg')) {
    return 'image/svg+xml; charset=utf-8';
  }
  if (filePath.endsWith('.webp')) {
    return 'image/webp';
  }
  if (filePath.endsWith('.html')) {
    return 'text/html; charset=utf-8';
  }

  return 'application/octet-stream';
}

function getRequestIp(input: { headers: Record<string, unknown>; ip?: string }): string | null {
  const forwardedFor = input.headers['x-forwarded-for'];
  const rawForwardedFor = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  if (typeof rawForwardedFor === 'string' && rawForwardedFor.trim()) {
    return rawForwardedFor.split(',')[0]?.trim() || null;
  }

  return input.ip?.trim() || null;
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
  overrides: Partial<Pick<JobExecutionOptions, 'headless' | 'debug' | 'slowMo' | 'timeoutMs'>>
): JobExecutionOptions {
  const requestedTimeout = overrides.timeoutMs ?? appConfig.timeoutMs;
  return {
    headless: true,
    debug: false,
    slowMo: 0,
    timeoutMs: Math.min(requestedTimeout, DEPOSIT_TURBO_TIMEOUT_MS)
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
  data?: { username: string; password: string; nombre: string; telefono?: string; staffPassword: string };
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
  const staffPassword = resolveAliasStringField(
    parsed.data,
    ['staff_password'],
    'staff_password',
    issues,
    { normalize: (value) => value, trim: false }
  );

  if (issues.length > 0 || !username || !password || !nombre || !staffPassword) {
    return { issues };
  }

  return {
    data: {
      username,
      password,
      nombre,
      ...(telefono ? { telefono } : {}),
      staffPassword
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
  data?: { userId: number; ownerKey: string; pagina: 'ASN' | 'RdA'; staffPassword: string };
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

  return { data: { userId, ownerKey, pagina: parsed.data.pagina ?? 'ASN', staffPassword }, issues };
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

function parseMastercrmAnalyticsPayload(body: unknown): {
  data?: {
    userId: number;
    dateFrom: string;
    dateTo: string;
    channel?: 'all' | 'landing' | 'meta_ctwa';
    campaignKey?: string;
    adKey?: string;
  };
  issues: ValidationIssue[];
} {
  const parsed = mastercrmAnalyticsBodySchema.safeParse(body);
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
    };
  }

  const issues: ValidationIssue[] = [];
  const userId = resolveAliasPositiveIntegerField(parsed.data, ['id', 'user_id', 'usuario_id'], 'id', issues);
  const dateFrom = resolveAliasStringField(parsed.data, ['date_from', 'fecha_desde'], 'date_from', issues);
  const dateTo = resolveAliasStringField(parsed.data, ['date_to', 'fecha_hasta'], 'date_to', issues);
  const channel = parsed.data.channel ?? parsed.data.canal;
  const campaignKey = resolveAliasStringField(parsed.data, ['campaign_key', 'campana_key'], 'campaign_key', issues, {
    required: false
  });
  const adKey = resolveAliasStringField(parsed.data, ['ad_key', 'anuncio_key'], 'ad_key', issues, {
    required: false
  });

  if (issues.length > 0 || !userId || !dateFrom || !dateTo) {
    return { issues };
  }

  return {
    data: {
      userId,
      dateFrom,
      dateTo,
      ...(channel ? { channel } : {}),
      ...(campaignKey ? { campaignKey } : {}),
      ...(adKey ? { adKey } : {})
    },
    issues
  };
}

function parseMastercrmMarketingBudgetPayload(body: unknown): {
  data?: {
    id?: string;
    userId: number;
    channel: 'landing' | 'meta_ctwa';
    level: 'ad';
    campaignKey: string;
    campaignName: string;
    adKey?: string | null;
    adName?: string | null;
    linkUrl?: string | null;
    dailyBudgetArs: number;
    activeFrom: string;
    activeTo?: string | null;
  };
  issues: ValidationIssue[];
} {
  const parsed = mastercrmMarketingBudgetBodySchema.safeParse(body);
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
    };
  }

  const issues: ValidationIssue[] = [];
  const userId = resolveAliasPositiveIntegerField(parsed.data, ['user_id'], 'user_id', issues);
  const channel = parsed.data.channel ?? parsed.data.canal;
  const level = parsed.data.level ?? parsed.data.nivel;
  const campaignKey = resolveAliasStringField(parsed.data, ['campaign_key', 'campana_key'], 'campaign_key', issues);
  const campaignName = resolveAliasStringField(parsed.data, ['campaign_name', 'campana_nombre'], 'campaign_name', issues);
  const adKey = resolveAliasStringField(parsed.data, ['ad_key', 'anuncio_key'], 'ad_key', issues, { required: false });
  const adName = resolveAliasStringField(parsed.data, ['ad_name', 'anuncio_nombre'], 'ad_name', issues, { required: false });
  const linkUrl = resolveAliasStringField(parsed.data, ['link_url'], 'link_url', issues, { required: false });
  const activeFrom = resolveAliasStringField(parsed.data, ['active_from', 'vigente_desde'], 'active_from', issues);
  const activeTo = resolveAliasStringField(parsed.data, ['active_to', 'vigente_hasta'], 'active_to', issues, {
    required: false
  });
  const dailyBudgetArs = resolveAliasNumberField(
    parsed.data,
    ['daily_budget_ars', 'presupuesto_diario_ars'],
    'daily_budget_ars',
    issues,
    { min: 0 }
  );

  if (
    issues.length > 0 ||
    !userId ||
    !channel ||
    !level ||
    !campaignKey ||
    !campaignName ||
    !activeFrom ||
    dailyBudgetArs == null
  ) {
    return { issues };
  }
  if (level !== 'ad') {
    return { issues: [{ path: 'level', message: 'level must be ad' }] };
  }

  return {
    data: {
      ...(parsed.data.id ? { id: parsed.data.id } : {}),
      userId,
      channel,
      level,
      campaignKey,
      campaignName,
      ...(adKey ? { adKey } : {}),
      ...(adName ? { adName } : {}),
      ...(linkUrl ? { linkUrl } : {}),
      dailyBudgetArs,
      activeFrom,
      ...(activeTo ? { activeTo } : {})
    },
    issues
  };
}

function parseMastercrmMarketingBudgetDistributePayload(body: unknown): {
  data?: DistributeMastercrmMarketingBudgetsInput;
  issues: ValidationIssue[];
} {
  const parsed = mastercrmMarketingBudgetDistributeBodySchema.safeParse(body);
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
    };
  }

  const issues: ValidationIssue[] = [];
  const userId = resolveAliasPositiveIntegerField(parsed.data, ['user_id'], 'user_id', issues);
  const totalDailyBudgetArs = resolveAliasNumberField(
    parsed.data,
    ['total_daily_budget_ars', 'presupuesto_diario_total_ars'],
    'total_daily_budget_ars',
    issues,
    { min: 0 }
  );
  const activeFrom = resolveAliasStringField(parsed.data, ['active_from', 'vigente_desde'], 'active_from', issues);
  const activeTo = resolveAliasStringField(parsed.data, ['active_to', 'vigente_hasta'], 'active_to', issues, {
    required: false
  });
  const ads = parsed.data.ads ?? [];

  if (!Array.isArray(ads) || ads.length < 2) {
    issues.push({ path: 'ads', message: 'ads must include at least two ads' });
  }

  const parsedAds = ads.map((ad, index) => {
    const channel = ad.channel ?? ad.canal;
    const campaignKey = resolveAliasStringField(ad, ['campaign_key', 'campana_key'], `ads.${index}.campaign_key`, issues);
    const campaignName = resolveAliasStringField(
      ad,
      ['campaign_name', 'campana_nombre'],
      `ads.${index}.campaign_name`,
      issues
    );
    const adKey = resolveAliasStringField(ad, ['ad_key', 'anuncio_key'], `ads.${index}.ad_key`, issues);
    const adName = resolveAliasStringField(ad, ['ad_name', 'anuncio_nombre'], `ads.${index}.ad_name`, issues, {
      required: false
    });
    const linkUrl = resolveAliasStringField(ad, ['link_url'], `ads.${index}.link_url`, issues, { required: false });

    if (!channel) {
      issues.push({ path: `ads.${index}.channel`, message: 'channel is required' });
    }

    return {
      channel,
      campaignKey,
      campaignName,
      adKey,
      ...(adName ? { adName } : {}),
      ...(linkUrl ? { linkUrl } : {})
    };
  });

  if (issues.length > 0 || !userId || totalDailyBudgetArs == null || !activeFrom) {
    return { issues };
  }

  return {
    data: {
      userId,
      totalDailyBudgetArs,
      activeFrom,
      ...(activeTo ? { activeTo } : {}),
      ads: parsedAds as DistributeMastercrmMarketingBudgetsInput['ads']
    },
    issues
  };
}

function parseMastercrmMarketingBudgetDeletePayload(body: unknown): {
  data?: { userId: number; budgetId: string };
  issues: ValidationIssue[];
} {
  const parsed = mastercrmMarketingBudgetDeleteBodySchema.safeParse(body);
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
    };
  }

  const issues: ValidationIssue[] = [];
  const userId = resolveAliasPositiveIntegerField(parsed.data, ['user_id'], 'user_id', issues);
  const budgetId = resolveAliasStringField(parsed.data, ['budget_id', 'id'], 'budget_id', issues);

  if (issues.length > 0 || !userId || !budgetId) {
    return { issues };
  }

  return { data: { userId, budgetId }, issues };
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
  let cachedMastercrmSessionSecret: string | null = dependencies?.mastercrmSessionSecret ?? null;
  let cachedPlayerPhoneStore: PlayerPhoneStore | null = dependencies?.playerPhoneStore ?? null;
  let cachedLandingSessionStore: LandingSessionStore | null = dependencies?.landingSessionStore ?? null;
  let cachedReportRunStore: ReportRunStore | null = dependencies?.reportRunStore ?? null;
  let cachedMastercrmRetentionStore: MastercrmRetentionStore | null = dependencies?.mastercrmRetentionStore ?? null;
  let cachedMetaConversionsStore: MetaConversionsStore | null = dependencies?.metaConversionsStore ?? null;
  let reportWorker: ReportRunWorker | null = null;
  let metaWorker: MetaConversionsWorker | null = null;
  let retentionWorker: MastercrmRetentionWorker | null = null;
  const asnUserExistsChecker = dependencies?.asnUserExistsChecker ?? assertAsnUserExists;
  const rdaUserExistsChecker = dependencies?.rdaUserExistsChecker ?? assertRdaUserExists;
  const hasSupabaseConfig = Boolean(
    process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  );
  const rawMetaEnabled = parseBooleanEnv(process.env.META_ENABLED) ?? false;
  const metaConfiguredFromEnv = Boolean(
    process.env.META_DATASET_ID?.trim() && process.env.META_ACCESS_TOKEN?.trim() && hasSupabaseConfig
  );
  const landingMetaConfiguredFromEnv = Boolean(
    process.env.META_DATASET_ID?.trim() && process.env.META_ACCESS_TOKEN?.trim()
  );
  const metaEnabled = dependencies?.metaEnabled ?? (rawMetaEnabled && metaConfiguredFromEnv);
  const landingMetaEnabled = dependencies?.metaEnabled ?? (rawMetaEnabled && landingMetaConfiguredFromEnv);
  const landingEnabled = isLandingEnabled();
  const landingAllowedOrigins = resolveLandingAllowedOrigins();
  const metaLeadEnabled = parseBooleanEnv(process.env.META_LEAD_ENABLED) ?? true;
  const metaPurchaseEnabled = parseBooleanEnv(process.env.META_PURCHASE_ENABLED) ?? true;
  const metaValueSignalThreshold = parsePositiveNumberEnv(process.env.META_VALUE_SIGNAL_THRESHOLD, 10_000);
  const metaValueSignalWindowMode = process.env.META_VALUE_SIGNAL_WINDOW_MODE?.trim() || 'intake_local_day';
  const metaValueSignalTimezone = 'America/Argentina/Buenos_Aires';
  const metaWorkerEnabled = dependencies?.metaWorkerEnabled ?? metaEnabled;
  const metaWorkerConcurrency =
    dependencies?.metaWorkerConcurrency ?? parsePositiveIntegerEnv(process.env.META_WORKER_CONCURRENCY, 2);
  const metaWorkerPollMs = dependencies?.metaWorkerPollMs ?? parsePositiveIntegerEnv(process.env.META_WORKER_POLL_MS, 5000);
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
  const reportWorkerPollMs = dependencies?.reportWorkerPollMs ?? parsePositiveIntegerEnv(process.env.REPORT_WORKER_POLL_MS, 5000);
  const reportWorkerMaxPollMs =
    dependencies?.reportWorkerMaxPollMs ?? parsePositiveIntegerEnv(process.env.REPORT_WORKER_MAX_POLL_MS, Math.max(reportWorkerPollMs * 6, 30_000));
  const reportWorkerLeaseSeconds =
    dependencies?.reportWorkerLeaseSeconds ?? parsePositiveIntegerEnv(process.env.REPORT_WORKER_LEASE_SECONDS, 60);
  const reportWorkerMaxAttempts =
    dependencies?.reportWorkerMaxAttempts ?? parsePositiveIntegerEnv(process.env.REPORT_WORKER_MAX_ATTEMPTS, 3);
  const retentionWorkerEnabled =
    dependencies?.retentionWorkerEnabled ?? (parseBooleanEnv(process.env.MASTERCRM_RETENTION_ENABLED) ?? false);
  const retentionRunOnStart =
    dependencies?.retentionRunOnStart ?? (parseBooleanEnv(process.env.MASTERCRM_RETENTION_RUN_ON_START) ?? true);
  const retentionPollMs =
    dependencies?.retentionPollMs ?? parsePositiveIntegerEnv(process.env.MASTERCRM_RETENTION_POLL_MS, 86_400_000);

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

  function getMastercrmSessionSecret(): string {
    if (cachedMastercrmSessionSecret) {
      return cachedMastercrmSessionSecret;
    }

    cachedMastercrmSessionSecret = resolveMastercrmSessionSecret();
    return cachedMastercrmSessionSecret;
  }

  async function requireMastercrmSession(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<MastercrmSessionClaims | null> {
    const token = readBearerToken(request.headers.authorization);
    if (!token) {
      reply.code(401).send({ message: 'MasterCRM authentication required' });
      return null;
    }

    try {
      const claims = verifyMastercrmSessionToken(token, getMastercrmSessionSecret());
      const user = await getMastercrmUserStore().getActiveUserById(claims.userId);
      if (user.username !== claims.username) {
        reply.code(401).send({ message: 'Invalid or expired MasterCRM session' });
        return null;
      }

      return claims;
    } catch (error) {
      if (error instanceof MastercrmSessionError && error.code === 'CONFIGURATION') {
        logger.error({ error }, 'MasterCRM session configuration error');
        reply.code(500).send({ message: 'MasterCRM session is not configured' });
        return null;
      }

      reply.code(401).send({ message: 'Invalid or expired MasterCRM session' });
      return null;
    }
  }

  function requireMatchingMastercrmUser(
    claims: MastercrmSessionClaims,
    requestedUserId: number,
    reply: FastifyReply
  ): boolean {
    if (claims.userId === requestedUserId) {
      return true;
    }

    reply.code(403).send({ message: 'MasterCRM session cannot access another user' });
    return false;
  }

  function getLandingSessionStore(): LandingSessionStore | null {
    if (cachedLandingSessionStore) {
      return cachedLandingSessionStore;
    }

    if (!hasSupabaseConfig) {
      return null;
    }

    cachedLandingSessionStore = createLandingSessionStoreFromEnv();
    return cachedLandingSessionStore;
  }

  function getReportRunStore(): ReportRunStore {
    if (cachedReportRunStore) {
      return cachedReportRunStore;
    }

    cachedReportRunStore = createReportRunStoreFromEnv();
    return cachedReportRunStore;
  }

  function getMastercrmRetentionStore(): MastercrmRetentionStore {
    if (cachedMastercrmRetentionStore) {
      return cachedMastercrmRetentionStore;
    }

    cachedMastercrmRetentionStore = createMastercrmRetentionStoreFromEnv();
    return cachedMastercrmRetentionStore;
  }

  function getMetaConversionsStore(): MetaConversionsStore {
    if (cachedMetaConversionsStore) {
      return cachedMetaConversionsStore;
    }

    cachedMetaConversionsStore = createMetaConversionsStoreFromEnv();
    return cachedMetaConversionsStore;
  }

  function getLandingMetaDispatcher(): MetaConversionsDispatcher | null {
    if (dependencies?.landingMetaConversionsDispatcher) {
      return dependencies.landingMetaConversionsDispatcher;
    }

    if (!landingMetaConfiguredFromEnv) {
      return null;
    }

    return new MetaConversionsHttpDispatcher(buildLandingMetaConversionsConfigFromEnv());
  }

  async function createLandingContactSession(input: {
    payload: z.infer<typeof landingContactBodySchema>;
    clientIpAddress: string | null;
    clientUserAgent: string | null;
  }): Promise<LandingSessionRecord | null> {
    const landingSessionStore = getLandingSessionStore();
    if (!landingSessionStore) {
      return null;
    }

    const isRdav2 = isLandingRdav2Variant(input.payload.landingVariant);
    const botPhone = isRdav2
      ? LANDING_RDAV2_BOT_WHATSAPP_PHONE
      : resolveLandingBotWhatsappPhone(input.payload.routingSeed);
    const attempts = isRdav2 ? LANDING_RDAV2_BONUS_CODE_ATTEMPTS : LANDING_DESCRIPTOR_ATTEMPTS;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const messageText = isRdav2
        ? buildLandingRdav2WhatsappMessage(
            attempt === 0 && input.payload.bonusCode
              ? input.payload.bonusCode
              : buildLandingRdav2BonusCode(input.payload.landingSessionId, attempt)
          )
        : buildLandingWhatsappMessage(input.payload.landingSessionId, attempt);
      const messageKey = normalizeLandingMessageKey(messageText);
      if (!messageKey) {
        continue;
      }

      try {
        return await landingSessionStore.createSession({
          landingSessionId: input.payload.landingSessionId,
          contactEventId: input.payload.eventId,
          messageText,
          messageKey,
          pagina: 'RdA',
          ownerContext: LANDING_OWNER_CONTEXT,
          landingVariant: input.payload.landingVariant ?? LANDING_VARIANT,
          botPhoneE164: `+${botPhone}`,
          cashierPhoneE164: `+${LANDING_CASHIER_WHATSAPP_PHONE}`,
          fbp: input.payload.fbp ?? null,
          fbc: input.payload.fbc ?? null,
          fbclid: input.payload.fbclid ?? null,
          eventSourceUrl: input.payload.eventSourceUrl ?? null,
          referrer: input.payload.referrer ?? null,
          utmSource: input.payload.utmSource ?? null,
          utmMedium: input.payload.utmMedium ?? null,
          utmId: input.payload.utmId ?? null,
          utmCampaign: input.payload.utmCampaign ?? null,
          utmContent: input.payload.utmContent ?? null,
          utmTerm: input.payload.utmTerm ?? null,
          adsetId: input.payload.adsetId ?? null,
          adId: input.payload.adId ?? null,
          placement: input.payload.placement ?? null,
          clientIpAddress: input.clientIpAddress,
          clientUserAgent: input.clientUserAgent,
          whatsappUrl: buildLandingWhatsappUrl(botPhone, messageText)
        });
      } catch (error) {
        if (error instanceof LandingSessionStoreError && error.code === 'CONFLICT') {
          continue;
        }
        throw error;
      }
    }

    return null;
  }

  function mergeLandingSourceContext(
    landingSession: LandingSessionRecord,
    whatsappSourceContext: MetaSourceContext | null
  ): MetaSourceContext {
    const landingSourceContext = landingSessionToSourceContext(landingSession);
    return {
      ...landingSourceContext,
      ...(whatsappSourceContext ?? {}),
      fbp: landingSourceContext.fbp ?? whatsappSourceContext?.fbp ?? null,
      fbc: landingSourceContext.fbc ?? whatsappSourceContext?.fbc ?? null,
      fbclid: landingSourceContext.fbclid ?? whatsappSourceContext?.fbclid ?? null,
      eventSourceUrl: landingSourceContext.eventSourceUrl ?? whatsappSourceContext?.eventSourceUrl ?? null,
      referrer: landingSourceContext.referrer ?? whatsappSourceContext?.referrer ?? null,
      landingSessionId: landingSession.landingSessionId,
      landingVariant: landingSourceContext.landingVariant ?? whatsappSourceContext?.landingVariant ?? LANDING_VARIANT,
      ctaType: 'whatsapp_click',
      utmSource: landingSourceContext.utmSource ?? whatsappSourceContext?.utmSource ?? null,
      utmMedium: landingSourceContext.utmMedium ?? whatsappSourceContext?.utmMedium ?? null,
      utmId: landingSourceContext.utmId ?? whatsappSourceContext?.utmId ?? null,
      utmCampaign: landingSourceContext.utmCampaign ?? whatsappSourceContext?.utmCampaign ?? null,
      utmContent: landingSourceContext.utmContent ?? whatsappSourceContext?.utmContent ?? null,
      utmTerm: landingSourceContext.utmTerm ?? whatsappSourceContext?.utmTerm ?? null,
      adsetId: landingSourceContext.adsetId ?? whatsappSourceContext?.adsetId ?? null,
      adId: landingSourceContext.adId ?? whatsappSourceContext?.adId ?? null,
      placement: landingSourceContext.placement ?? whatsappSourceContext?.placement ?? null,
      whatsappUrl: landingSession.whatsappUrl,
      clientIpAddress: landingSourceContext.clientIpAddress ?? whatsappSourceContext?.clientIpAddress ?? null,
      clientUserAgent: landingSourceContext.clientUserAgent ?? whatsappSourceContext?.clientUserAgent ?? null
    };
  }

  async function persistPendingIntake(input: {
    pagina: PaginaCode;
    telefono: string;
    ownerContext: OwnerContext;
    sourceContext?: MetaSourceContext | null;
    customerData?: MetaCustomerData | null;
  }) {
    const intake = await getPlayerPhoneStore().intakePendingCliente({
      pagina: input.pagina,
      telefono: input.telefono,
      ownerContext: input.ownerContext,
      ...(input.sourceContext ? { sourceContext: input.sourceContext } : {})
    });

    if (
      metaEnabled &&
      metaLeadEnabled &&
      intake.ownerId &&
      intake.clientId &&
      input.sourceContext &&
      (isLandingMetaSourceContext(input.sourceContext) || isAttributableMetaSourceContext(input.sourceContext))
    ) {
      try {
        const leadInput = {
          ownerId: intake.ownerId,
          clientId: intake.clientId,
          phoneE164: input.telefono,
          ownerContext: input.ownerContext,
          sourceContext: input.sourceContext,
          ...(input.customerData ? { customerData: input.customerData } : {}),
          ...(input.sourceContext.receivedAt ? { eventTime: input.sourceContext.receivedAt } : {})
        };
        if (isLandingMetaSourceContext(input.sourceContext)) {
          await getMetaConversionsStore().enqueueLandingLead(leadInput);
        } else {
          await getMetaConversionsStore().enqueueLead(leadInput);
        }
      } catch (error) {
        logger.warn(
          {
            error,
            ownerId: intake.ownerId,
            clientId: intake.clientId,
            telefono: input.telefono
          },
          'Meta attributable lead enqueue failed after intake persistence'
        );
      }
    }

    return intake;
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
          if (request.payload.pagina === 'RdA') {
            return runRdaReportJob(request as RdaReportJobRequest, appConfig, logger);
          }
          return runAsnReportJob(request as AsnReportJobRequest, appConfig, logger);
        }

        throw new Error('Unsupported job type');
      }
    });

  if (reportWorkerEnabled) {
    const executor =
      dependencies?.reportJobExecutor ??
      createReportJobExecutor(appConfig, logger, resolveDepositExecutionOptions(appConfig, {}));
    reportWorker = new ReportRunWorker(getReportRunStore(), logger, {
      concurrency: reportWorkerConcurrency,
      pollMs: reportWorkerPollMs,
      maxPollMs: reportWorkerMaxPollMs,
      leaseSeconds: reportWorkerLeaseSeconds,
      maxAttempts: reportWorkerMaxAttempts
    }, executor);
    reportWorker.start();
  }

  if (metaEnabled && metaWorkerEnabled) {
    const defaultDispatcher =
      dependencies?.metaConversionsDispatcher ??
      new MetaConversionsHttpDispatcher(buildMetaConversionsConfigFromEnv());
    const landingDispatcher = getLandingMetaDispatcher();
    const dispatcher = landingDispatcher
      ? new MetaConversionsRoutingDispatcher(defaultDispatcher, landingDispatcher)
      : defaultDispatcher;
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

  if (retentionWorkerEnabled) {
    try {
      retentionWorker = new MastercrmRetentionWorker(getMastercrmRetentionStore(), logger, {
        runOnStart: retentionRunOnStart,
        pollMs: retentionPollMs
      });
      retentionWorker.start();
    } catch (error) {
      logger.error({ error }, 'MasterCRM technical retention worker could not start');
    }
  }

  async function sendLandingHtml(reply: FastifyReply, fileName: string, landingVariant: string = LANDING_VARIANT) {
    const template = await readFile(join(LANDING_PUBLIC_DIR, fileName), 'utf8');
    const config = buildLandingPublicConfig(process.env, { landingVariant });
    const html = template
      .replace('__LANDING_CONFIG_JSON__', escapeScriptJson(config))
      .replace('__META_PIXEL_NOSCRIPT__', buildMetaPixelNoscript(config.pixelId))
      .replaceAll('__LANDING_ASSET_VERSION__', encodeURIComponent(LANDING_ASSET_VERSION));

    return reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .header('content-security-policy', [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' https://connect.facebook.net https://static.cloudflareinsights.com",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https://www.facebook.com https://*.facebook.com",
        "connect-src 'self' https://connect.facebook.net https://www.facebook.com https://*.facebook.com https://cloudflareinsights.com",
        "font-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'"
      ].join('; '))
      .header('permissions-policy', 'camera=(), microphone=(), geolocation=()')
      .header('referrer-policy', 'strict-origin-when-cross-origin')
      .header('strict-transport-security', 'max-age=31536000; includeSubDomains')
      .header('x-content-type-options', 'nosniff')
      .header('x-frame-options', 'DENY')
      .send(html);
  }

  async function sendLandingAsset(reply: FastifyReply, fileName: string, cacheControl: string) {
    const body = await readFile(join(LANDING_PUBLIC_DIR, fileName));
    return reply
      .header('content-type', landingContentType(fileName))
      .header('cache-control', cacheControl)
      .header('referrer-policy', 'strict-origin-when-cross-origin')
      .header('strict-transport-security', 'max-age=31536000; includeSubDomains')
      .header('x-content-type-options', 'nosniff')
      .send(body);
  }

  fastify.get('/landing', async (_request, reply) => {
    if (!landingEnabled) {
      return reply.code(404).send({ message: 'Landing disabled' });
    }

    return sendLandingHtml(reply, 'index.html');
  });

  fastify.get('/landing/', async (_request, reply) => {
    if (!landingEnabled) {
      return reply.code(404).send({ message: 'Landing disabled' });
    }

    return sendLandingHtml(reply, 'index.html');
  });

  fastify.get('/landing/rdav2', async (_request, reply) => {
    if (!landingEnabled) {
      return reply.code(404).send({ message: 'Landing disabled' });
    }

    return sendLandingHtml(reply, 'rdav2.html', LANDING_RDAV2_VARIANT);
  });

  fastify.get('/landing/rdav2/', async (_request, reply) => {
    if (!landingEnabled) {
      return reply.code(404).send({ message: 'Landing disabled' });
    }

    return sendLandingHtml(reply, 'rdav2.html', LANDING_RDAV2_VARIANT);
  });

  fastify.get('/landing/rdav2/privacidad', async (_request, reply) => {
    if (!landingEnabled) {
      return reply.code(404).send({ message: 'Landing disabled' });
    }

    return sendLandingHtml(reply, 'privacidad-rdav2.html', LANDING_RDAV2_VARIANT);
  });

  fastify.get('/landing/rdav2/terminos', async (_request, reply) => {
    if (!landingEnabled) {
      return reply.code(404).send({ message: 'Landing disabled' });
    }

    return sendLandingHtml(reply, 'terminos-rdav2.html', LANDING_RDAV2_VARIANT);
  });

  fastify.get('/landing/privacidad', async (_request, reply) => {
    if (!landingEnabled) {
      return reply.code(404).send({ message: 'Landing disabled' });
    }

    return sendLandingHtml(reply, 'privacidad.html');
  });

  fastify.get('/landing/terminos', async (_request, reply) => {
    if (!landingEnabled) {
      return reply.code(404).send({ message: 'Landing disabled' });
    }

    return sendLandingHtml(reply, 'terminos.html');
  });

  const landingAssetRoutes = [
    { route: '/landing/styles.css', fileName: 'styles.css', cacheControl: 'public, max-age=300' },
    { route: '/landing/styles-rdav2.css', fileName: 'styles-rdav2.css', cacheControl: 'public, max-age=300' },
    { route: '/landing/landing.js', fileName: 'landing.js', cacheControl: 'public, max-age=300' },
    {
      route: '/landing/assets/logo-rey-de-ases.webp',
      fileName: 'assets/logo-rey-de-ases.webp',
      cacheControl: 'public, max-age=31536000, immutable'
    },
    {
      route: '/landing/assets/logo-rey-de-ases.svg',
      fileName: 'assets/logo-rey-de-ases.svg',
      cacheControl: 'public, max-age=31536000, immutable'
    },
    {
      route: '/landing/assets/whatsapp.svg',
      fileName: 'assets/whatsapp.svg',
      cacheControl: 'public, max-age=31536000, immutable'
    },
    {
      route: '/landing/assets/hero-monkey-king.webp',
      fileName: 'assets/hero-monkey-king.webp',
      cacheControl: 'public, max-age=31536000, immutable'
    },
    {
      route: '/landing/assets/rdav2-roulette.webp',
      fileName: 'assets/rdav2-roulette.webp',
      cacheControl: 'public, max-age=31536000, immutable'
    },
    {
      route: '/landing/assets/rdav2-slots.webp',
      fileName: 'assets/rdav2-slots.webp',
      cacheControl: 'public, max-age=31536000, immutable'
    },
    {
      route: '/landing/assets/rdav2-blackjack.webp',
      fileName: 'assets/rdav2-blackjack.webp',
      cacheControl: 'public, max-age=31536000, immutable'
    },
    {
      route: '/landing/assets/rdav2-dice.webp',
      fileName: 'assets/rdav2-dice.webp',
      cacheControl: 'public, max-age=31536000, immutable'
    },
    {
      route: '/landing/assets/rdav2-jackpot.webp',
      fileName: 'assets/rdav2-jackpot.webp',
      cacheControl: 'public, max-age=31536000, immutable'
    },
    {
      route: '/landing/assets/rdav2-baccarat.webp',
      fileName: 'assets/rdav2-baccarat.webp',
      cacheControl: 'public, max-age=31536000, immutable'
    }
  ];

  for (const asset of landingAssetRoutes) {
    fastify.get(asset.route, async (_request, reply) => {
      if (!landingEnabled) {
        return reply.code(404).send({ message: 'Landing disabled' });
      }

      return sendLandingAsset(reply, asset.fileName, asset.cacheControl);
    });
  }

  fastify.post('/landing/contact', async (request, reply) => {
    if (!landingEnabled) {
      return reply.code(404).send({ message: 'Landing disabled' });
    }

    const origin = Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin;
    if (!isOriginAllowed(origin, landingAllowedOrigins)) {
      return reply.code(403).send({ message: 'Origin not allowed' });
    }

    const parsed = landingContactBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: 'Invalid payload',
        code: 'INVALID_PAYLOAD',
        details: {
          issues: toValidationIssues(parsed.error)
        },
        whatsappUrl: LANDING_WHATSAPP_URL,
        attributionStatus: 'incomplete',
        attributionError: 'invalid_payload'
      });
    }

    const payload = parsed.data;
    const receivedAt = new Date().toISOString();
    const clientIpAddress = getRequestIp({ headers: request.headers, ip: request.ip });
    const userAgentHeader = request.headers['user-agent'];
    const clientUserAgent = Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader ?? null;
    const referrerHeader = request.headers.referer;
    const referrer = payload.referrer ?? (Array.isArray(referrerHeader) ? referrerHeader[0] : referrerHeader) ?? null;
    const isRdav2 = isLandingRdav2Variant(payload.landingVariant);
    const fallbackBotPhone = isRdav2
      ? LANDING_RDAV2_BOT_WHATSAPP_PHONE
      : resolveLandingBotWhatsappPhone(payload.routingSeed);
    const fallbackBonusCode =
      payload.bonusCode ?? buildLandingRdav2BonusCode(payload.landingSessionId, 0);
    const fallbackWhatsappMessage = isRdav2
      ? buildLandingRdav2WhatsappMessage(fallbackBonusCode)
      : LANDING_WHATSAPP_MESSAGE;
    const fallbackWhatsappUrl = isRdav2
      ? buildLandingWhatsappUrl(fallbackBotPhone, fallbackWhatsappMessage)
      : payload.whatsappUrl ?? buildLandingWhatsappUrl(fallbackBotPhone, fallbackWhatsappMessage);
    let landingSession: LandingSessionRecord | null = null;
    let attributionError: string | null = null;
    try {
      landingSession = await createLandingContactSession({
        payload,
        clientIpAddress,
        clientUserAgent
      });
    } catch (error) {
      attributionError = error instanceof Error ? error.message : 'landing session persistence failed';
      logger.warn(
        {
          error,
          eventId: payload.eventId,
          landingSessionId: payload.landingSessionId
        },
        'Landing session persistence failed; returning marked WhatsApp redirect'
      );
    }
    const whatsappUrl = landingSession?.whatsappUrl ?? fallbackWhatsappUrl;
    const whatsappMessage = landingSession?.messageText ?? fallbackWhatsappMessage;
    const sourceContext: MetaSourceContext = {
      fbp: payload.fbp ?? null,
      fbc: payload.fbc ?? null,
      fbclid: payload.fbclid ?? null,
      eventSourceUrl: payload.eventSourceUrl ?? null,
      referrer,
      landingSessionId: payload.landingSessionId,
      landingVariant: payload.landingVariant ?? LANDING_VARIANT,
      ctaType: 'whatsapp_click',
      utmSource: payload.utmSource ?? null,
      utmMedium: payload.utmMedium ?? null,
      utmId: payload.utmId ?? null,
      utmCampaign: payload.utmCampaign ?? null,
      utmContent: payload.utmContent ?? null,
      utmTerm: payload.utmTerm ?? null,
      adsetId: payload.adsetId ?? null,
      adId: payload.adId ?? null,
      placement: payload.placement ?? null,
      consentMarketing: payload.consentMarketing ?? null,
      consentTimestamp: payload.consentTimestamp ?? null,
      whatsappUrl,
      clientIpAddress,
      clientUserAgent,
      receivedAt
    };

    let tracked = false;
    let trackingStatus: 'sent' | 'disabled' | 'not_configured' | 'failed' = 'disabled';

    if (landingMetaEnabled) {
      const dispatcher = getLandingMetaDispatcher();
      if (!dispatcher) {
        trackingStatus = 'not_configured';
      } else {
        try {
          await dispatcher.dispatch({
            id: randomUUID(),
            ownerId: LANDING_OWNER_CONTEXT.ownerKey,
            clientId: payload.landingSessionId,
            eventStage: 'landing_contact',
            metaEventName: 'Contact',
            eventId: payload.eventId,
            eventTime: receivedAt,
            phoneE164: null,
            username: null,
            sourcePayload: buildStoredMetaSourcePayload({
              ownerContext: LANDING_OWNER_CONTEXT,
              sourceContext
            }),
            attempts: 1,
            maxAttempts: 1
          });
          tracked = true;
          trackingStatus = 'sent';
        } catch (error) {
          trackingStatus = 'failed';
          logger.warn(
            {
              error,
              eventId: payload.eventId,
              landingSessionId: payload.landingSessionId,
              ownerKey: LANDING_OWNER_CONTEXT.ownerKey
            },
            'Landing Contact CAPI dispatch failed'
          );
        }
      }
    }

    return reply.send({
      status: 'ok',
      tracked,
      trackingStatus,
      eventId: payload.eventId,
      whatsappUrl,
      whatsappMessage,
      ...(isRdav2 ? { bonusCode: whatsappMessage.slice(-LANDING_RDAV2_BONUS_CODE_LENGTH) } : {}),
      attributionStatus: landingSession ? 'persisted' : 'incomplete',
      ...(attributionError ? { attributionError } : {}),
      ownerContext: {
        ownerKey: LANDING_OWNER_CONTEXT.ownerKey,
        ownerLabel: LANDING_OWNER_CONTEXT.ownerLabel
      }
    });
  });

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
      const configuredStaffPassword = resolveMastercrmStaffLinkPassword();
      if (!secretsEqual(parsed.data.staffPassword, configuredStaffPassword)) {
        return reply.code(403).send({ message: 'Clave tecnica invalida' });
      }

      const createdUser = await getMastercrmUserStore().createUser({
        username: normalizeMastercrmUsername(parsed.data.username),
        password: parsed.data.password,
        nombre: normalizeMastercrmNombre(parsed.data.nombre),
        ...(parsed.data.telefono ? { telefono: normalizeMastercrmTelefono(parsed.data.telefono) ?? undefined } : {})
      });

      return reply.code(201).send(mastercrmUserToResponse(createdUser));
    } catch (error) {
      if (error instanceof Error && error.message === 'MASTERCRM_STAFF_LINK_PASSWORD is not configured') {
        return reply.code(500).send({ message: 'Clave tecnica no configurada en backend' });
      }

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
      const session = issueMastercrmSessionToken(user, getMastercrmSessionSecret());

      return reply.code(200).send({
        ...mastercrmUserToResponse(user),
        access_token: session.token,
        token_type: 'Bearer',
        expires_in: session.expiresIn
      });
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
      const session = await requireMastercrmSession(request, reply);
      if (!session || !requireMatchingMastercrmUser(session, parsed.data.userId, reply)) {
        return;
      }

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
          source: client.source,
          origen: client.origen,
          Campana: client.Campana,
          lastCampaign: client.lastCampaign,
          attribution: client.attribution,
          ownerKey: client.ownerKey,
          ownerLabel: client.ownerLabel,
          firstSeenAt: client.firstSeenAt,
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
      const session = await requireMastercrmSession(request, reply);
      if (!session || !requireMatchingMastercrmUser(session, parsed.data.userId, reply)) {
        return;
      }

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

  fastify.post('/mastercrm-analytics', async (request, reply) => {
    const parsed = parseMastercrmAnalyticsPayload(request.body);
    if (!parsed.data) {
      return reply.code(400).send({
        message: 'Invalid payload',
        issues: parsed.issues
      });
    }

    try {
      const session = await requireMastercrmSession(request, reply);
      if (!session || !requireMatchingMastercrmUser(session, parsed.data.userId, reply)) {
        return;
      }

      const analytics = await getMastercrmUserStore().getMarketingAnalytics(parsed.data);
      return reply.code(200).send(analytics);
    } catch (error) {
      const mappedError = toMastercrmHttpError(error);
      if (mappedError) {
        return reply.code(mappedError.statusCode).send({ message: mappedError.message });
      }

      logger.error({ error }, 'Unexpected /mastercrm-analytics error');
      return reply.code(500).send({ message: 'Unexpected mastercrm auth error' });
    }
  });

  fastify.post('/mastercrm-marketing-budgets', async (request, reply) => {
    const parsed = parseMastercrmMarketingBudgetPayload(request.body);
    if (!parsed.data) {
      return reply.code(400).send({
        message: 'Invalid payload',
        issues: parsed.issues
      });
    }

    try {
      const session = await requireMastercrmSession(request, reply);
      if (!session || !requireMatchingMastercrmUser(session, parsed.data.userId, reply)) {
        return;
      }

      const budget = await getMastercrmUserStore().upsertMarketingBudget(parsed.data);
      return reply.code(200).send(budget);
    } catch (error) {
      const mappedError = toMastercrmHttpError(error);
      if (mappedError) {
        return reply.code(mappedError.statusCode).send({ message: mappedError.message });
      }

      logger.error({ error }, 'Unexpected /mastercrm-marketing-budgets error');
      return reply.code(500).send({ message: 'Unexpected mastercrm auth error' });
    }
  });

  fastify.post('/mastercrm-marketing-budgets/distribute', async (request, reply) => {
    const parsed = parseMastercrmMarketingBudgetDistributePayload(request.body);
    if (!parsed.data) {
      return reply.code(400).send({
        message: 'Invalid payload',
        issues: parsed.issues
      });
    }

    try {
      const session = await requireMastercrmSession(request, reply);
      if (!session || !requireMatchingMastercrmUser(session, parsed.data.userId, reply)) {
        return;
      }

      const budgets = await getMastercrmUserStore().distributeMarketingBudgets(parsed.data);
      return reply.code(200).send({ budgets });
    } catch (error) {
      const mappedError = toMastercrmHttpError(error);
      if (mappedError) {
        return reply.code(mappedError.statusCode).send({ message: mappedError.message });
      }

      logger.error({ error }, 'Unexpected /mastercrm-marketing-budgets/distribute error');
      return reply.code(500).send({ message: 'Unexpected mastercrm auth error' });
    }
  });

  fastify.post('/mastercrm-marketing-budgets/delete', async (request, reply) => {
    const parsed = parseMastercrmMarketingBudgetDeletePayload(request.body);
    if (!parsed.data) {
      return reply.code(400).send({
        message: 'Invalid payload',
        issues: parsed.issues
      });
    }

    try {
      const session = await requireMastercrmSession(request, reply);
      if (!session || !requireMatchingMastercrmUser(session, parsed.data.userId, reply)) {
        return;
      }

      const result = await getMastercrmUserStore().deleteMarketingBudget(parsed.data);
      return reply.code(200).send(result);
    } catch (error) {
      const mappedError = toMastercrmHttpError(error);
      if (mappedError) {
        return reply.code(mappedError.statusCode).send({ message: mappedError.message });
      }

      logger.error({ error }, 'Unexpected /mastercrm-marketing-budgets/delete error');
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
      const session = await requireMastercrmSession(request, reply);
      if (!session || !requireMatchingMastercrmUser(session, parsed.data.userId, reply)) {
        return;
      }

      const configuredStaffPassword = resolveMastercrmStaffLinkPassword();
      if (!secretsEqual(parsed.data.staffPassword, configuredStaffPassword)) {
        return reply.code(403).send({
          success: false,
          message: 'Clave tecnica invalida'
        });
      }

      const link = await getMastercrmUserStore().linkCashierToUser({
        userId: parsed.data.userId,
        ownerKey: normalizeMastercrmOwnerKey(parsed.data.ownerKey),
        pagina: parsed.data.pagina
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
      const intake = await persistPendingIntake({
        pagina: payload.pagina,
        telefono: payload.telefono,
        ownerContext: payload.ownerContext,
        ...(payload.sourceContext ? { sourceContext: payload.sourceContext } : {}),
        ...(payload.customerData ? { customerData: payload.customerData } : {})
      });

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

  fastify.post('/whatsapp/intake', async (request, reply) => {
    const parsed = whatsappIntakeBodySchema.safeParse(request.body);
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
      const telefono = resolveWhatsappIntakePhone({
        telefono: payload.telefono ?? null,
        body: payload.body
      });

      if (!telefono) {
        return reply.code(400).send({
          message: 'Invalid payload',
          code: 'INVALID_PAYLOAD',
          details: {
            issues: [{ path: 'telefono', message: 'telefono, body.WaId or body.From is required' }]
          }
        });
      }

      const whatsappSourceContext = buildWhatsappSourceContext(payload.body, payload.sourceContext);
      let landingSession: LandingSessionRecord | null = null;
      const landingSessionStore = getLandingSessionStore();
      if (landingSessionStore) {
        try {
          landingSession = await landingSessionStore.claimPendingSession({
            messageText: readOptionalStringField(payload.body, 'Body'),
            phoneE164: telefono,
            messageSid: readOptionalStringField(payload.body, 'MessageSid'),
            claimedAt: whatsappSourceContext?.receivedAt ?? new Date().toISOString()
          });
        } catch (error) {
          logger.warn(
            {
              error,
              telefono,
              messageSid: readOptionalStringField(payload.body, 'MessageSid')
            },
            'Landing session claim failed during WhatsApp intake'
          );
        }
      }

      const pagina = landingSession?.pagina ?? payload.pagina;
      const sourceContext = landingSession
        ? mergeLandingSourceContext(landingSession, whatsappSourceContext)
        : whatsappSourceContext;
      const landingOwnerContext = landingSession
        ? {
            ownerKey: landingSession.ownerKey,
            ownerLabel: landingSession.ownerLabel,
            actorAlias: landingSession.ownerLabel,
            actorPhone: landingSession.cashierPhoneE164
          }
        : null;
      const ownerContext =
        payload.ownerContext ??
        landingOwnerContext ??
        (await getPlayerPhoneStore().resolveOwnerContextByPhone({
          pagina,
          telefono
        }));

      if (!ownerContext) {
        return reply.code(400).send({
          message: 'Invalid payload',
          code: 'OWNER_CONTEXT_REQUIRED',
          details: {
            issues: [
              {
                path: 'ownerContext',
                message: 'ownerContext is required unless the phone already has a persisted owner link'
              }
            ]
          }
        });
      }

      const intake = await persistPendingIntake({
        pagina,
        telefono,
        ownerContext,
        ...(sourceContext ? { sourceContext } : {}),
        ...(payload.customerData ? { customerData: payload.customerData } : {})
      });

      return reply.code(200).send({
        status: 'ok',
        pagina,
        telefono,
        ownerContext,
        ...(landingSession ? { landingSessionId: landingSession.landingSessionId } : {}),
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

      logger.error({ error }, 'Unexpected /whatsapp/intake error');
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

    try {
      if (parsed.data.pagina === 'ASN') {
        await asnUserExistsChecker({
          usuario: parsed.data.usuario,
          agente: parsed.data.agente,
          contrasenaAgente: parsed.data.contrasena_agente,
          appConfig,
          logger
        });
      } else {
        await rdaUserExistsChecker({
          usuario: parsed.data.usuario,
          agente: parsed.data.agente,
          contrasenaAgente: parsed.data.contrasena_agente,
          appConfig,
          logger
        });
      }

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

      if (error instanceof RdaUserCheckError) {
        if (error.code === 'NOT_FOUND') {
          return reply.code(404).send({
            message: error.message,
            code: 'RDA_USER_NOT_FOUND',
            details: { usuario: parsed.data.usuario }
          });
        }
        if (error.code === 'AMBIGUOUS') {
          return reply.code(409).send({
            message: error.message,
            code: 'RDA_USER_AMBIGUOUS',
            details: { usuario: parsed.data.usuario }
          });
        }
        if (error.code === 'UNAVAILABLE') {
          return reply.code(503).send({
            message: error.message,
            code: 'RDA_UNAVAILABLE',
            details: { usuario: parsed.data.usuario }
          });
        }
        logger.error({ error }, 'Unexpected RdA user existence checker error');
        return reply.code(500).send({
          message: 'No se pudo verificar el usuario en RdA',
          code: 'RDA_USER_CHECK_FAILED',
          details: { usuario: parsed.data.usuario }
        });
      }

      const mappedError = toHttpError(error);
      if (mappedError) {
        if (mappedError.code === 'USERNAME_ALREADY_EXISTS_IN_PAGINA') {
          return reply.code(409).send({
            message: `Ese usuario ya esta vinculado a otro numero dentro de ${parsed.data.pagina}`,
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
      const createdAt = new Date().toISOString();
      const id = randomUUID();
      const reportRequest: ReportJobRequest =
        payload.pagina === 'RdA'
          ? {
              id,
              jobType: 'report',
              createdAt,
              payload: {
                pagina: 'RdA',
                operacion: 'reporte',
                usuario: payload.usuario,
                agente: payload.agente,
                contrasena_agente: payload.contrasena_agente,
                ...(typeof payload.cantidad === 'number' ? { cantidad: payload.cantidad } : {})
              },
              options: resolveDepositExecutionOptions(appConfig, payload)
            }
          : {
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
              options: resolveDepositExecutionOptions(appConfig, payload)
            };

      internalQueue.enqueue(reportRequest);

      return reply.code(202).send({
        jobId: id,
        status: 'queued',
        statusUrl: `/jobs/${id}`
      });
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
            options: resolveDepositExecutionOptions(appConfig, payload)
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
            options: resolveDepositExecutionOptions(appConfig, payload)
          };

    internalQueue.enqueue(jobRequest);

    return reply.code(202).send({
      jobId: id,
      status: 'queued',
      statusUrl: `/jobs/${id}`
    });
  });

  fastify.post('/reports/run', async (request, reply) => {
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
        pagina: payload.pagina,
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
        statusUrl: `/reports/run/${run.id}`
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

      logger.error({ error }, 'Unexpected /reports/run error');
      return reply.code(500).send({ message: 'Unexpected report persistence error' });
    }
  });

  fastify.post('/reports/asn/run', async (request, reply) => {
    const body = typeof request.body === 'object' && request.body !== null ? request.body : {};
    const parsed = reportRunBodySchema.safeParse({ ...body, pagina: 'ASN' });
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

  fastify.post('/reports/rda/run', async (request, reply) => {
    const body = typeof request.body === 'object' && request.body !== null ? request.body : {};
    const parsed = reportRunBodySchema.safeParse({ ...body, pagina: 'RdA' });
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
        pagina: 'RdA',
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
        statusUrl: `/reports/rda/run/${run.id}`
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

      logger.error({ error }, 'Unexpected /reports/rda/run error');
      return reply.code(500).send({ message: 'Unexpected report persistence error' });
    }
  });

  async function handleGetReportRun(runId: string, reply: FastifyReply, logLabel: string) {
    try {
      const run = await getReportRunStore().getRunById(runId);
      return reply.send(run);
    } catch (error) {
      const mappedError = toReportHttpError(error);
      if (mappedError) {
        return reply.code(mappedError.statusCode).send({ message: mappedError.message });
      }

      logger.error({ error }, logLabel);
      return reply.code(500).send({ message: 'Unexpected report persistence error' });
    }
  }

  fastify.get('/reports/run/:runId', async (request, reply) => {
    const parsed = reportRunParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ message: 'Invalid run id' });
    }

    return handleGetReportRun(parsed.data.runId, reply, 'Unexpected /reports/run/:runId error');
  });

  fastify.get('/reports/asn/run/:runId', async (request, reply) => {
    const parsed = reportRunParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ message: 'Invalid run id' });
    }

    return handleGetReportRun(parsed.data.runId, reply, 'Unexpected /reports/asn/run/:runId error');
  });

  fastify.get('/reports/rda/run/:runId', async (request, reply) => {
    const parsed = reportRunParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ message: 'Invalid run id' });
    }

    return handleGetReportRun(parsed.data.runId, reply, 'Unexpected /reports/rda/run/:runId error');
  });

  async function handleListReportRunItems(
    runId: string,
    query: unknown,
    reply: FastifyReply,
    logLabel: string
  ) {
    const parsedQuery = reportRunItemsQuerySchema.safeParse(query);
    if (!parsedQuery.success) {
      return reply.code(400).send({
        message: 'Invalid query',
        issues: parsedQuery.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
      });
    }

    try {
      const page = await getReportRunStore().listRunItems(
        runId,
        parsedQuery.data.limit ?? 100,
        parsedQuery.data.offset ?? 0
      );
      return reply.send(page);
    } catch (error) {
      const mappedError = toReportHttpError(error);
      if (mappedError) {
        return reply.code(mappedError.statusCode).send({ message: mappedError.message });
      }

      logger.error({ error }, logLabel);
      return reply.code(500).send({ message: 'Unexpected report persistence error' });
    }
  }

  fastify.get('/reports/run/:runId/items', async (request, reply) => {
    const parsedParams = reportRunParamsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ message: 'Invalid run id' });
    }

    return handleListReportRunItems(parsedParams.data.runId, request.query, reply, 'Unexpected /reports/run/:runId/items error');
  });

  fastify.get('/reports/asn/run/:runId/items', async (request, reply) => {
    const parsedParams = reportRunParamsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ message: 'Invalid run id' });
    }

    return handleListReportRunItems(parsedParams.data.runId, request.query, reply, 'Unexpected /reports/asn/run/:runId/items error');
  });

  fastify.get('/reports/rda/run/:runId/items', async (request, reply) => {
    const parsedParams = reportRunParamsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ message: 'Invalid run id' });
    }

    return handleListReportRunItems(parsedParams.data.runId, request.query, reply, 'Unexpected /reports/rda/run/:runId/items error');
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
    if (retentionWorker) {
      await retentionWorker.stop();
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
