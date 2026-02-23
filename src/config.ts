import path from 'node:path';
import { z } from 'zod';
import type {
  AppConfig,
  CliOptions,
  CredentialsInput,
  LogLevel,
  ResolvedCredentials,
  RunConfig,
  ServerConfig
} from './types';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseBool(input: string | undefined): boolean | undefined {
  if (input == null) {
    return undefined;
  }

  const normalized = input.toLowerCase().trim();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }

  return undefined;
}

function parseList(input: string | undefined): string[] {
  if (!input) {
    return [];
  }

  return input
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function optionalString(input: string | undefined): string | undefined {
  if (!input) {
    return undefined;
  }

  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseSelectors(input: string | undefined, fallback: string[]): string[] {
  const list = parseList(input);
  return list.length > 0 ? list : fallback;
}

function removeTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function buildAppConfig(cli: CliOptions, env = process.env): AppConfig {
  const envHeadless = parseBool(env.SCRAPER_DEFAULT_HEADLESS);
  const envDebug = parseBool(env.SCRAPER_DEBUG);
  const envBlockResources = parseBool(env.SCRAPER_BLOCK_RESOURCES);
  const envReuseSession = parseBool(env.SCRAPER_REUSE_SESSION);

  const raw = {
    baseUrl: env.AGENT_BASE_URL ?? 'https://agents.reydeases.com',
    headless: cli.headless ?? envHeadless ?? false,
    debug: cli.debug ?? envDebug ?? false,
    slowMo: cli.slowMo ?? Number(env.SCRAPER_SLOW_MO ?? 0),
    timeoutMs: cli.timeoutMs ?? Number(env.SCRAPER_TIMEOUT_MS ?? 30_000),
    retries: cli.retries ?? Number(env.SCRAPER_RETRIES ?? 2),
    concurrency: cli.concurrency ?? Number(env.SCRAPER_CONCURRENCY ?? 4),
    outputDir: cli.outputDir ?? env.SCRAPER_OUTPUT_DIR ?? './out',
    artifactsDir: cli.artifactsDir ?? env.SCRAPER_ARTIFACTS_DIR ?? './artifacts',
    fromDate: optionalString(cli.fromDate ?? env.SCRAPER_FROM_DATE),
    toDate: optionalString(cli.toDate ?? env.SCRAPER_TO_DATE),
    maxPages: cli.maxPages ?? Number(env.SCRAPER_MAX_PAGES ?? 100),
    logLevel: (cli.logLevel ?? (env.SCRAPER_LOG_LEVEL as LogLevel) ?? 'info') as LogLevel,
    blockResources: cli.noBlockResources ? false : envBlockResources ?? true,
    reuseSession: cli.reuseSession ?? envReuseSession ?? true,
    apiEndpoints: parseList(env.AGENT_API_ENDPOINTS),
    loginPath: optionalString(env.AGENT_LOGIN_PATH) ?? '/login',
    selectors: {
      username: parseSelectors(env.AGENT_USERNAME_SELECTORS, [
        'input[name="username"]',
        'input[name="login"]',
        'input[autocomplete="username"]',
        'input[type="text"]'
      ]),
      password: parseSelectors(env.AGENT_PASSWORD_SELECTORS, [
        'input[name="password"]',
        'input[type="password"]'
      ]),
      submit: parseSelectors(env.AGENT_SUBMIT_SELECTORS, [
        'button[type="submit"]',
        'button:has-text("Log in")',
        'button:has-text("Login")'
      ]),
      success: optionalString(env.AGENT_SUCCESS_SELECTOR),
      error: optionalString(env.AGENT_ERROR_SELECTOR)
    }
  };

  const schema = z
    .object({
      baseUrl: z.string().url(),
      headless: z.boolean(),
      debug: z.boolean(),
      slowMo: z.number().min(0),
      timeoutMs: z.number().min(1),
      retries: z.number().min(0),
      concurrency: z.number().min(1),
      outputDir: z.string().min(1),
      artifactsDir: z.string().min(1),
      fromDate: z.string().regex(DATE_RE).optional(),
      toDate: z.string().regex(DATE_RE).optional(),
      maxPages: z.number().int().min(1),
      logLevel: z.enum(LOG_LEVELS),
      blockResources: z.boolean(),
      reuseSession: z.boolean(),
      apiEndpoints: z.array(z.string().min(1)),
      loginPath: z.string().min(1),
      selectors: z.object({
        username: z.array(z.string().min(1)).min(1),
        password: z.array(z.string().min(1)).min(1),
        submit: z.array(z.string().min(1)).min(1),
        success: z.string().min(1).optional(),
        error: z.string().min(1).optional()
      })
    })
    .refine((value) => !(value.fromDate && value.toDate) || value.fromDate <= value.toDate, {
      message: 'fromDate must be <= toDate',
      path: ['fromDate']
    });

  const parsed = schema.parse(raw);

  return {
    ...parsed,
    baseUrl: removeTrailingSlash(parsed.baseUrl),
    storageStatePath: path.join(parsed.artifactsDir, 'storage-state.json')
  };
}

export function resolveCliOrEnvCredentials(input: CredentialsInput): ResolvedCredentials {
  const username = optionalString(input.cliUsername) ?? optionalString(input.envUsername);
  const password = optionalString(input.cliPassword) ?? optionalString(input.envPassword);

  if (!username) {
    throw new Error('Username is required via --username or AGENT_USERNAME');
  }
  if (!password) {
    throw new Error('Password is required via --password or AGENT_PASSWORD');
  }

  return { username, password };
}

export function buildRunConfig(cli: CliOptions, env = process.env): RunConfig {
  const app = buildAppConfig(cli, env);
  const credentials = resolveCliOrEnvCredentials({
    cliUsername: cli.username,
    cliPassword: cli.password,
    envUsername: env.AGENT_USERNAME,
    envPassword: env.AGENT_PASSWORD
  });

  return {
    ...app,
    ...credentials
  };
}

export function buildServerConfig(cli: CliOptions, env = process.env): ServerConfig {
  const raw = {
    host: optionalString(cli.host) ?? optionalString(env.API_HOST) ?? '127.0.0.1',
    port: cli.port ?? Number(env.API_PORT ?? 3000),
    loginConcurrency: Number(env.API_LOGIN_CONCURRENCY ?? 3),
    jobTtlMinutes: Number(env.API_JOB_TTL_MINUTES ?? 60)
  };

  return z
    .object({
      host: z.string().min(1),
      port: z.number().int().min(1).max(65535),
      loginConcurrency: z.number().int().min(1),
      jobTtlMinutes: z.number().int().min(1)
    })
    .parse(raw);
}

export function parseBooleanFlag(value: string): boolean {
  const parsed = parseBool(value);
  if (parsed === undefined) {
    throw new Error(`Invalid boolean value: ${value}`);
  }

  return parsed;
}

export function parseNumberFlag(name: string, value: string): number {
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`${name} must be a valid number`);
  }

  return parsed;
}

export function parseLogLevel(value: string): LogLevel {
  const lower = value.toLowerCase() as LogLevel;
  if (!LOG_LEVELS.includes(lower)) {
    throw new Error(`Invalid log level: ${value}`);
  }

  return lower;
}

// Backward-compatible alias used in the previous implementation/tests.
export const buildConfig = buildRunConfig;
