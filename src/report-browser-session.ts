import type { Browser, BrowserContext } from 'playwright';
import type { Logger } from 'pino';
import { handleAsnPostLoginContinue } from './asn-post-login';
import { ensureAuthenticated } from './auth';
import { configureContext, launchChromiumBrowser } from './browser';
import type { ReportRunLease } from './report-run-store';
import { resolveSiteAppConfig } from './site-profile';
import type { AppConfig, JobExecutionOptions, PaginaCode } from './types';

export interface ReportBrowserSession {
  runId: string;
  ownerId: string;
  pagina: PaginaCode;
  browser: Browser;
  context: BrowserContext;
}

export interface PlatformReportSessionManager {
  withSession<T>(lease: ReportRunLease, action: (session: ReportBrowserSession) => Promise<T>): Promise<T>;
  closeRun(runId: string): Promise<void>;
}

export class RunAuthenticatedReportSessionManager implements PlatformReportSessionManager {
  private readonly sessions = new Map<string, Promise<ReportBrowserSession>>();

  constructor(
    private readonly appConfig: AppConfig,
    private readonly logger: Logger,
    private readonly options: JobExecutionOptions
  ) {}

  async withSession<T>(lease: ReportRunLease, action: (session: ReportBrowserSession) => Promise<T>): Promise<T> {
    const sessionKey = this.sessionKey(lease);
    let sessionPromise = this.sessions.get(sessionKey);
    if (!sessionPromise) {
      sessionPromise = this.createSession(lease);
      this.sessions.set(sessionKey, sessionPromise);
      sessionPromise.catch(() => this.sessions.delete(sessionKey));
    }

    const session = await sessionPromise;
    if (session.pagina !== lease.pagina) {
      throw new Error(`Report run ${lease.runId} cannot mix ${session.pagina} and ${lease.pagina}`);
    }
    if (session.ownerId !== lease.ownerId) {
      throw new Error(`Report session owner mismatch for run ${lease.runId}`);
    }
    return action(session);
  }

  async closeRun(runId: string): Promise<void> {
    const runPrefix = `${runId}:`;
    const sessionPromises: Promise<ReportBrowserSession>[] = [];
    for (const [key, sessionPromise] of this.sessions) {
      if (key.startsWith(runPrefix)) {
        this.sessions.delete(key);
        sessionPromises.push(sessionPromise);
      }
    }
    await Promise.all(
      sessionPromises.map(async (sessionPromise) => {
        try {
          const session = await sessionPromise;
          await session.context.close().catch(() => undefined);
          await session.browser.close().catch(() => undefined);
        } catch {
          // Session creation already performs its own cleanup.
        }
      })
    );
  }

  private sessionKey(lease: ReportRunLease): string {
    return `${lease.runId}:${lease.ownerId}`;
  }

  private async createSession(lease: ReportRunLease): Promise<ReportBrowserSession> {
    const siteConfig = resolveSiteAppConfig(this.appConfig, lease.pagina);
    const runtimeConfig: AppConfig = {
      ...siteConfig,
      headless: this.options.headless,
      debug: this.options.debug,
      slowMo: this.options.slowMo,
      timeoutMs: this.options.timeoutMs,
      blockResources: false
    };
    const runLogger = this.logger.child({ runId: lease.runId, pagina: lease.pagina, component: 'report-session' });
    const browser = await launchChromiumBrowser(runtimeConfig, runLogger);
    const context = await browser.newContext({
      baseURL: runtimeConfig.baseUrl,
      viewport: runtimeConfig.headless ? { width: 1920, height: 1080 } : null
    });

    try {
      await configureContext(context, runtimeConfig, runLogger);
      const page = await context.newPage();
      try {
        await ensureAuthenticated(
          context,
          page,
          runtimeConfig,
          { username: lease.agente, password: lease.contrasenaAgente },
          runLogger,
          { persistSession: false }
        );
        if (lease.pagina === 'ASN') {
          await handleAsnPostLoginContinue(page, Math.min(runtimeConfig.timeoutMs, 3_000));
        }
      } finally {
        await page.close().catch(() => undefined);
      }
      return { runId: lease.runId, ownerId: lease.ownerId, pagina: lease.pagina, browser, context };
    } catch (error) {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
      throw error;
    }
  }
}
