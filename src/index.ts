import { existsSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import dotenv from 'dotenv';
import {
  buildAppConfig,
  buildRunConfig,
  buildServerConfig,
  parseBooleanFlag,
  parseLogLevel,
  parseNumberFlag
} from './config';
import { createLogger } from './logging';
import { readN8nRdaCredentialRowsFromSqlite, runN8nRdaCredentialSync } from './n8n-rda-credential-sync';
import { runScraper } from './run';
import { startServer } from './server';
import type { CliOptions } from './types';
import { runWhatsappQrMonthBackfill } from './whatsapp-qr-backfill';
import { createWhatsappQrStoreFromEnv } from './whatsapp-qr-store';

const localEnvPath = path.resolve(process.cwd(), '.env');
if (existsSync(localEnvPath)) {
  dotenv.config({ path: localEnvPath });
}

const program = new Command();
program.name('scraper').description('Scraper for agents.reydeases.com');

program
  .command('run')
  .description('Run scraping job')
  .option('--username <string>', 'Agent username (fallback: AGENT_USERNAME)')
  .option('--password <string>', 'Agent password (fallback: AGENT_PASSWORD)')
  .option('--headless <boolean>', 'Run browser in headless mode', parseBooleanFlag)
  .option('--debug <boolean>', 'Enable trace/video/screenshot instrumentation', parseBooleanFlag)
  .option('--slow-mo <ms>', 'Slow motion per action in milliseconds', (value) => parseNumberFlag('slow-mo', value))
  .option('--timeout-ms <ms>', 'Global timeout for browser actions', (value) => parseNumberFlag('timeout-ms', value))
  .option('--retries <n>', 'Retries per endpoint fetch', (value) => parseNumberFlag('retries', value))
  .option('--concurrency <n>', 'Concurrent API fetches', (value) => parseNumberFlag('concurrency', value))
  .option('--output-dir <path>', 'Output directory for JSON/CSV')
  .option('--artifacts-dir <path>', 'Directory for traces/screenshots/state')
  .option('--from-date <YYYY-MM-DD>', 'Start date filter')
  .option('--to-date <YYYY-MM-DD>', 'End date filter')
  .option('--max-pages <n>', 'Maximum pages if UI pagination fallback is added', (value) => parseNumberFlag('max-pages', value))
  .option('--log-level <level>', 'fatal|error|warn|info|debug|trace|silent', parseLogLevel)
  .option('--no-block-resources', 'Do not block image/font/media requests')
  .option('--reuse-session <boolean>', 'Reuse persisted storageState if available', parseBooleanFlag)
  .action(async (options: CliOptions) => {
    const cfg = buildRunConfig(options);
    const logger = createLogger(cfg.logLevel, true);

    logger.info(
      {
        baseUrl: cfg.baseUrl,
        headless: cfg.headless,
        debug: cfg.debug,
        timeoutMs: cfg.timeoutMs,
        retries: cfg.retries,
        concurrency: cfg.concurrency,
        outputDir: cfg.outputDir,
        artifactsDir: cfg.artifactsDir
      },
      'Starting scraper'
    );

    try {
      const metadata = await runScraper(cfg, logger);
      logger.info({ metadata }, 'Run completed');
    } catch (error) {
      logger.error({ error }, 'Run failed');
      process.exitCode = 1;
    }
  });

program
  .command('server')
  .description('Start async login API server')
  .option('--host <host>', 'Server host (fallback: API_HOST)')
  .option('--port <port>', 'Server port (fallback: API_PORT)', (value) => parseNumberFlag('port', value))
  .option('--headless <boolean>', 'Default headless mode for login jobs', parseBooleanFlag)
  .option('--debug <boolean>', 'Default debug mode for login jobs', parseBooleanFlag)
  .option('--slow-mo <ms>', 'Default slow motion for login jobs', (value) => parseNumberFlag('slow-mo', value))
  .option('--timeout-ms <ms>', 'Default timeout for login jobs', (value) => parseNumberFlag('timeout-ms', value))
  .option('--artifacts-dir <path>', 'Directory for job artifacts')
  .option('--log-level <level>', 'fatal|error|warn|info|debug|trace|silent', parseLogLevel)
  .option('--no-block-resources', 'Do not block image/font/media requests')
  .action(async (options: CliOptions) => {
    const appConfig = buildAppConfig(options);
    const serverConfig = buildServerConfig(options);
    const logger = createLogger(appConfig.logLevel, true);

    try {
      await startServer(appConfig, serverConfig, logger);
    } catch (error) {
      logger.error({ error }, 'Server failed to start');
      process.exitCode = 1;
    }
  });

program
  .command('sync-n8n-rda-cashiers')
  .description('Sync RdA cashier login credentials from an n8n SQLite data table into MasterCRM QR storage')
  .option('--sqlite <path>', 'n8n SQLite database path (fallback: N8N_SQLITE_PATH)')
  .option('--python-bin <path>', 'Python executable used to read SQLite (fallback: PYTHON_BIN or python)')
  .option('--write', 'Write credentials to backend storage. Omit for dry-run.')
  .action(async (options: { sqlite?: string; pythonBin?: string; write?: boolean }) => {
    const sqlitePath = options.sqlite || process.env.N8N_SQLITE_PATH?.trim();
    if (!sqlitePath) {
      console.error('Missing --sqlite or N8N_SQLITE_PATH');
      process.exitCode = 1;
      return;
    }

    try {
      const rows = await readN8nRdaCredentialRowsFromSqlite(sqlitePath, options.pythonBin || undefined);
      const result = await runN8nRdaCredentialSync({
        store: createWhatsappQrStoreFromEnv(),
        rows,
        dryRun: !options.write
      });

      console.log(
        JSON.stringify(
          {
            dryRun: result.dryRun,
            scanned: result.scanned,
            eligible: result.eligible,
            synced: result.synced,
            skippedMissingOwner: result.skippedMissingOwner,
            skippedInvalid: result.skippedInvalid
          },
          null,
          2
        )
      );

      if (result.skippedMissingOwner.length > 0) {
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

program
  .command('backfill-whatsapp-qr-month')
  .description('Run a one-off WhatsApp QR month backfill for a linked owner using the persisted QR auth session')
  .requiredOption('--owner-key <ownerKey>', 'Cashier owner key, for example luqui10:luqui10')
  .requiredOption('--month-start <YYYY-MM-DD>', 'Month start to validate, for example 2026-06-01')
  .option('--auth-root-dir <path>', 'WhatsApp QR auth root dir (fallback: WHATSAPP_QR_AUTH_DIR or ./artifacts/whatsapp-qr-auth)')
  .option('--history-log <path>', 'Replay the latest WhatsApp bootstrap from a docker log instead of reconnecting the QR session')
  .option('--output <path>', 'Optional JSON output file path')
  .option('--history-timeout-ms <ms>', 'Hard timeout waiting for history/contact sync', (value) =>
    parseNumberFlag('history-timeout-ms', value)
  )
  .option('--idle-window-ms <ms>', 'Idle window that ends the backfill after the last sync event', (value) =>
    parseNumberFlag('idle-window-ms', value)
  )
  .option('--log-level <level>', 'fatal|error|warn|info|debug|trace|silent', parseLogLevel)
  .action(
    async (options: {
      ownerKey: string;
      monthStart: string;
      authRootDir?: string;
      historyLog?: string;
      output?: string;
      historyTimeoutMs?: number;
      idleWindowMs?: number;
      logLevel?: ReturnType<typeof parseLogLevel>;
    }) => {
      const logger = createLogger(options.logLevel ?? 'info', true);
      try {
        const result = await runWhatsappQrMonthBackfill({
          ownerKey: options.ownerKey,
          monthStart: options.monthStart,
          authRootDir: options.authRootDir,
          historyLogPath: options.historyLog,
          outputPath: options.output,
          historyTimeoutMs: options.historyTimeoutMs,
          idleWindowMs: options.idleWindowMs,
          logger
        });

        console.log(
          JSON.stringify(
            {
              outputPath: result.outputPath,
              summary: result.summary
            },
            null,
            2
          )
        );
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    }
  );

program.parseAsync(process.argv);
