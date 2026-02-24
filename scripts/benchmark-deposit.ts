import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';

type Mode = 'turbo' | 'visual';
type Status = 'succeeded' | 'failed';

interface RunResult {
  mode: Mode;
  runIndex: number;
  jobId: string;
  status: Status;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  error?: string;
  artifactPaths: string[];
  stepDurationsMs: Record<string, number>;
}

interface StatsSummary {
  count: number;
  succeeded: number;
  failed: number;
  minMs: number;
  maxMs: number;
  medianMs: number;
  p90Ms: number;
}

interface CliArgs {
  agent: string;
  password: string;
  user: string;
  amount: number;
  turboRuns: number;
  visualRuns: number;
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const direct = process.argv.find((value) => value.startsWith(prefix));
  if (direct) {
    return direct.slice(prefix.length);
  }

  const index = process.argv.findIndex((value) => value === `--${name}`);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }

  return undefined;
}

function parseArgs(): CliArgs {
  const positional = process.argv.slice(2).filter((value) => !value.startsWith('--'));
  const agent = readArg('agent') ?? positional[0] ?? process.env.BENCH_AGENT ?? process.env.AGENT_USERNAME ?? '';
  const password = readArg('password') ?? positional[1] ?? process.env.BENCH_PASSWORD ?? process.env.AGENT_PASSWORD ?? '';
  const user = readArg('user') ?? positional[2] ?? process.env.BENCH_USER ?? 'pruebita';
  const amount = Number(readArg('amount') ?? positional[3] ?? process.env.BENCH_AMOUNT ?? 1);
  const turboRuns = Number(readArg('turbo-runs') ?? positional[4] ?? process.env.BENCH_TURBO_RUNS ?? 5);
  const visualRuns = Number(readArg('visual-runs') ?? positional[5] ?? process.env.BENCH_VISUAL_RUNS ?? 3);

  if (!agent) {
    throw new Error('Missing agent username. Use --agent or BENCH_AGENT/AGENT_USERNAME.');
  }
  if (!password) {
    throw new Error('Missing agent password. Use --password or BENCH_PASSWORD/AGENT_PASSWORD.');
  }
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount)) {
    throw new Error('amount must be a positive integer');
  }
  if (!Number.isFinite(turboRuns) || turboRuns <= 0 || !Number.isInteger(turboRuns)) {
    throw new Error('turbo-runs must be a positive integer');
  }
  if (!Number.isFinite(visualRuns) || visualRuns <= 0 || !Number.isInteger(visualRuns)) {
    throw new Error('visual-runs must be a positive integer');
  }

  return { agent, password, user, amount, turboRuns, visualRuns };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] as number;
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[half] as number;
  }

  return ((sorted[half - 1] as number) + (sorted[half] as number)) / 2;
}

function buildStats(results: RunResult[]): StatsSummary {
  const durations = results.filter((item) => item.status === 'succeeded').map((item) => item.durationMs);
  const succeeded = durations.length;
  const failed = results.length - succeeded;
  return {
    count: results.length,
    succeeded,
    failed,
    minMs: succeeded > 0 ? Math.min(...durations) : 0,
    maxMs: succeeded > 0 ? Math.max(...durations) : 0,
    medianMs: median(durations),
    p90Ms: percentile(durations, 90)
  };
}

function stepDurations(steps: Array<{ name: string; startedAt: string; finishedAt: string }>): Record<string, number> {
  const map: Record<string, number> = {};
  for (const step of steps) {
    const start = Date.parse(step.startedAt);
    const end = Date.parse(step.finishedAt);
    if (Number.isNaN(start) || Number.isNaN(end)) {
      continue;
    }
    map[step.name] = Math.max(0, end - start);
  }

  return map;
}

function modeOptions(mode: Mode): { headless: boolean; debug: boolean; slowMo: number; timeoutMs: number } {
  if (mode === 'turbo') {
    return { headless: false, debug: false, slowMo: 0, timeoutMs: 15_000 };
  }

  return { headless: false, debug: true, slowMo: 100, timeoutMs: 120_000 };
}

async function runBenchMode(
  mode: Mode,
  runs: number,
  args: CliArgs,
  modules: {
    buildAppConfig: (options: object) => any;
    createLogger: (level: string, pretty: boolean) => any;
    runDepositJob: (request: any, appConfig: any, logger: any) => Promise<any>;
  }
): Promise<RunResult[]> {
  const output: RunResult[] = [];
  for (let i = 0; i < runs; i += 1) {
    const jobId = randomUUID();
    const opts = modeOptions(mode);
    const appConfig = modules.buildAppConfig({
      headless: opts.headless,
      debug: opts.debug,
      slowMo: opts.slowMo,
      timeoutMs: opts.timeoutMs,
      logLevel: 'info'
    });
    const logger = modules.createLogger('info', true);
    const request = {
      id: jobId,
      jobType: 'deposit',
      createdAt: new Date().toISOString(),
      payload: {
        pagina: 'RdA',
        operacion: 'carga',
        usuario: args.user,
        agente: args.agent,
        contrasena_agente: args.password,
        cantidad: args.amount
      },
      options: opts
    };

    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    process.stdout.write(`[${mode} ${i + 1}/${runs}] start job=${jobId}\n`);

    try {
      const result = await modules.runDepositJob(request, appConfig, logger);
      const finishedMs = Date.now();
      const finishedAt = new Date().toISOString();
      const durationMs = finishedMs - startedMs;
      process.stdout.write(`[${mode} ${i + 1}/${runs}] succeeded duration_ms=${durationMs}\n`);
      output.push({
        mode,
        runIndex: i + 1,
        jobId,
        status: 'succeeded',
        durationMs,
        startedAt,
        finishedAt,
        artifactPaths: Array.isArray(result.artifactPaths) ? [...result.artifactPaths] : [],
        stepDurationsMs: stepDurations(Array.isArray(result.steps) ? result.steps : [])
      });
    } catch (error) {
      const finishedMs = Date.now();
      const finishedAt = new Date().toISOString();
      const durationMs = finishedMs - startedMs;
      const err = error as Error & {
        steps?: Array<{ name: string; startedAt: string; finishedAt: string }>;
        artifactPaths?: string[];
      };
      process.stdout.write(`[${mode} ${i + 1}/${runs}] failed duration_ms=${durationMs} error=${err.message}\n`);
      output.push({
        mode,
        runIndex: i + 1,
        jobId,
        status: 'failed',
        durationMs,
        startedAt,
        finishedAt,
        error: err.message,
        artifactPaths: Array.isArray(err.artifactPaths) ? [...err.artifactPaths] : [],
        stepDurationsMs: stepDurations(Array.isArray(err.steps) ? err.steps : [])
      });
    }
  }

  return output;
}

async function main(): Promise<void> {
  const args = parseArgs();

  const configModule = await import('../src/config.ts');
  const loggingModule = await import('../src/logging.ts');
  const depositModule = await import('../src/deposit-job.ts');
  const buildAppConfig =
    (configModule as { buildAppConfig?: (options: object) => any }).buildAppConfig ??
    ((configModule as { default?: { buildAppConfig?: (options: object) => any } }).default?.buildAppConfig as
      | ((options: object) => any)
      | undefined);
  const createLogger =
    (loggingModule as { createLogger?: (level: string, pretty: boolean) => any }).createLogger ??
    ((loggingModule as { default?: { createLogger?: (level: string, pretty: boolean) => any } }).default
      ?.createLogger as ((level: string, pretty: boolean) => any) | undefined);
  const runDepositJob =
    (depositModule as { runDepositJob?: (request: any, appConfig: any, logger: any) => Promise<any> }).runDepositJob ??
    ((depositModule as { default?: { runDepositJob?: (request: any, appConfig: any, logger: any) => Promise<any> } })
      .default?.runDepositJob as ((request: any, appConfig: any, logger: any) => Promise<any>) | undefined);

  if (!buildAppConfig || !createLogger || !runDepositJob) {
    throw new Error('Could not resolve runtime modules for benchmark');
  }

  const turboResults = await runBenchMode('turbo', args.turboRuns, args, { buildAppConfig, createLogger, runDepositJob });
  const visualResults = await runBenchMode('visual', args.visualRuns, args, { buildAppConfig, createLogger, runDepositJob });

  const turboStats = buildStats(turboResults);
  const visualStats = buildStats(visualResults);
  const speedupPct =
    turboStats.medianMs > 0 && visualStats.medianMs > 0
      ? ((visualStats.medianMs - turboStats.medianMs) / visualStats.medianMs) * 100
      : 0;
  const turboPerfect = turboStats.succeeded === args.turboRuns;
  const meetsGoal = speedupPct >= 30;

  const summary = {
    generatedAt: new Date().toISOString(),
    params: args,
    turboStats,
    visualStats,
    speedupPct,
    turboPerfect,
    meetsGoal,
    turboResults,
    visualResults
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(process.cwd(), 'out', 'benchmarks');
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `deposit-benchmark.${stamp}.json`);
  await fs.writeFile(outPath, JSON.stringify(summary, null, 2), 'utf8');

  process.stdout.write(`summary_path=${outPath}\n`);
  process.stdout.write(`turbo_success=${turboStats.succeeded}/${args.turboRuns}\n`);
  process.stdout.write(`visual_success=${visualStats.succeeded}/${args.visualRuns}\n`);
  process.stdout.write(`median_turbo_ms=${turboStats.medianMs}\n`);
  process.stdout.write(`median_visual_ms=${visualStats.medianMs}\n`);
  process.stdout.write(`speedup_pct=${speedupPct.toFixed(2)}\n`);
  process.stdout.write(`turbo_perfect=${turboPerfect}\n`);
  process.stdout.write(`meets_goal_30pct=${meetsGoal}\n`);

  if (!turboPerfect) {
    process.exitCode = 2;
    return;
  }

  if (!meetsGoal) {
    process.exitCode = 3;
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
