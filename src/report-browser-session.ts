import { createHash } from 'node:crypto';
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

interface CachedReportSession {
  key: string;
  runId: string;
  promise: Promise<ReportBrowserSession>;
}

export class RunAuthenticatedReportSessionManager implements PlatformReportSessionManager {
  private currentSession: CachedReportSession | null = null;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly appConfig: AppConfig,
    private readonly logger: Logger,
    private readonly options: JobExecutionOptions
  ) {}

  async withSession<T>(lease: ReportRunLease, action: (session: ReportBrowserSession) => Promise<T>): Promise<T> {
    const previousOperation = this.operationQueue;
    let releaseOperation!: () => void;
    this.operationQueue = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });

    await previousOperation;
    try {
      const session = await this.getOrCreateSession(lease);
      if (session.pagina !== lease.pagina) {
        throw new Error(`Report run ${lease.runId} cannot mix ${session.pagina} and ${lease.pagina}`);
      }
      return await action(session);
    } finally {
      releaseOperation();
    }
  }

  async closeRun(runId: string): Promise<void> {
    const cachedSession = this.currentSession;
    if (!cachedSession || cachedSession.runId !== runId) {
      return;
    }
    this.currentSession = null;
    await this.closeSession(cachedSession.promise);
  }

  private sessionKey(lease: ReportRunLease): string {
    const credentialFingerprint = createHash('sha256')
      .update(lease.loginUsername)
      .update('\0')
      .update(lease.loginPassword)
      .digest('hex');
    return `${lease.runId}:${lease.pagina}:${credentialFingerprint}`;
  }

  private async getOrCreateSession(lease: ReportRunLease): Promise<ReportBrowserSession> {
    const key = this.sessionKey(lease);
    if (this.currentSession?.key === key) {
      return this.currentSession.promise;
    }

    if (this.currentSession) {
      const staleSession = this.currentSession;
      this.currentSession = null;
      await this.closeSession(staleSession.promise);
    }

    const promise = this.createSession(lease);
    const cachedSession: CachedReportSession = { key, runId: lease.runId, promise };
    this.currentSession = cachedSession;
    promise.catch(() => {
      if (this.currentSession === cachedSession) {
        this.currentSession = null;
      }
    });
    return promise;
  }

  private async closeSession(sessionPromise: Promise<ReportBrowserSession>): Promise<void> {
    try {
      const session = await sessionPromise;
      await session.context.close().catch(() => undefined);
      await session.browser.close().catch(() => undefined);
    } catch {
      // Session creation already performs its own cleanup.
    }
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
          { username: lease.loginUsername, password: lease.loginPassword },
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
