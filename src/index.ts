import { Command } from 'commander';
import {
  buildAppConfig,
  buildRunConfig,
  buildServerConfig,
  parseBooleanFlag,
  parseLogLevel,
  parseNumberFlag
} from './config';
import { createLogger } from './logging';
import { runScraper } from './run';
import { startServer } from './server';
import type { CliOptions } from './types';

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

program.parseAsync(process.argv);
