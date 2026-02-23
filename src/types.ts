export interface CliOptions {
  headless?: boolean;
  debug?: boolean;
  slowMo?: number;
  timeoutMs?: number;
  retries?: number;
  concurrency?: number;
  outputDir?: string;
  artifactsDir?: string;
  fromDate?: string;
  toDate?: string;
  maxPages?: number;
  logLevel?: LogLevel;
  noBlockResources?: boolean;
  reuseSession?: boolean;
  username?: string;
  password?: string;
  host?: string;
  port?: number;
}

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface SelectorsConfig {
  username: string[];
  password: string[];
  submit: string[];
  success?: string;
  error?: string;
}

export interface AppConfig {
  baseUrl: string;
  headless: boolean;
  debug: boolean;
  slowMo: number;
  timeoutMs: number;
  retries: number;
  concurrency: number;
  outputDir: string;
  artifactsDir: string;
  fromDate?: string;
  toDate?: string;
  maxPages: number;
  logLevel: LogLevel;
  blockResources: boolean;
  reuseSession: boolean;
  storageStatePath: string;
  apiEndpoints: string[];
  loginPath: string;
  selectors: SelectorsConfig;
}

export interface RunConfig extends AppConfig {
  username: string;
  password: string;
}

export type ScraperConfig = AppConfig;

export interface ServerConfig {
  host: string;
  port: number;
  loginConcurrency: number;
  jobTtlMinutes: number;
}

export interface CredentialsInput {
  cliUsername?: string;
  cliPassword?: string;
  envUsername?: string;
  envPassword?: string;
}

export interface ResolvedCredentials {
  username: string;
  password: string;
}

export interface ApiFetchResult {
  endpoint: string;
  status: number;
  ok: boolean;
  body: unknown;
  fetchedAt: string;
}

export interface NormalizedRecord {
  source: 'api';
  endpoint: string;
  recordIndex: number;
  extractedAt: string;
  payloadJson: string;
}

export interface RunMetadata {
  startedAt: string;
  endedAt: string;
  durationMs: number;
  records: number;
  apiCalls: number;
  retries: number;
  errors: string[];
  outputJson: string;
  outputCsv: string;
}

export type JobType = 'login' | 'create-player' | 'deposit';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'expired';
export type JobStepStatus = 'ok' | 'failed' | 'skipped';

export interface JobExecutionOptions {
  headless: boolean;
  debug: boolean;
  slowMo: number;
  timeoutMs: number;
}

export type StepActionType = 'goto' | 'click' | 'fill' | 'waitFor';

export interface StepAction {
  type: StepActionType;
  selector?: string;
  value?: string;
  url?: string;
  timeoutMs?: number;
  screenshotName?: string;
}

export interface JobStepResult {
  name: string;
  status: JobStepStatus;
  startedAt: string;
  finishedAt: string;
  artifactPath?: string;
  error?: string;
}

export interface LoginJobPayload {
  username: string;
  password: string;
}

export interface CreatePlayerJobPayload {
  loginUsername: string;
  loginPassword: string;
  newUsername: string;
  newPassword: string;
  stepsOverride?: StepAction[];
}

export type FundsOperation = 'carga' | 'descarga' | 'descarga_total';

interface DepositJobPayloadBase {
  operacion: FundsOperation;
  usuario: string;
  agente: string;
  contrasena_agente: string;
}

export interface DepositJobPayloadWithAmount extends DepositJobPayloadBase {
  operacion: 'carga' | 'descarga';
  cantidad: number;
}

export interface DepositJobPayloadTotal extends DepositJobPayloadBase {
  operacion: 'descarga_total';
  cantidad?: number;
}

export type DepositJobPayload = DepositJobPayloadWithAmount | DepositJobPayloadTotal;

export interface LoginJobRequest {
  id: string;
  jobType: 'login';
  payload: LoginJobPayload;
  options: JobExecutionOptions;
  createdAt: string;
}

export interface CreatePlayerJobRequest {
  id: string;
  jobType: 'create-player';
  payload: CreatePlayerJobPayload;
  options: JobExecutionOptions;
  createdAt: string;
}

export interface DepositJobRequest {
  id: string;
  jobType: 'deposit';
  payload: DepositJobPayload;
  options: JobExecutionOptions;
  createdAt: string;
}

export type JobRequest = LoginJobRequest | CreatePlayerJobRequest | DepositJobRequest;

export interface JobExecutionResult {
  artifactPaths: string[];
  steps: JobStepResult[];
}

export interface JobStoreEntry {
  id: string;
  jobType: JobType;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  artifactPaths: string[];
  steps: JobStepResult[];
}
