import type { Logger } from 'pino';
import { runAsnReportJob } from './asn-report-job';
import { runRdaReportJob } from './rda-report-job';
import type { ReportRunLease } from './report-run-store';
import type { PlatformReportSessionManager, ReportBrowserSession } from './report-browser-session';
import type {
  AppConfig,
  AsnReportJobRequest,
  JobExecutionOptions,
  PaginaCode,
  RdaReportJobRequest,
  ReportJobResult
} from './types';

export interface PlatformReportAdapter {
  readonly pagina: PaginaCode;
  execute(lease: ReportRunLease): Promise<ReportJobResult>;
}

export class PlatformAuthenticationError extends Error {
  constructor(public readonly pagina: PaginaCode, message: string, options?: ErrorOptions) {
    super(`PLATFORM_AUTH_FAILED:${pagina}:${message}`, options);
    this.name = 'PlatformAuthenticationError';
  }
}

export function isPlatformAuthenticationFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /login_form_still_visible|authentication did not complete|authentication failed|login failed|invalid credentials|credenciales.*inv[aá]lidas|no se pudo iniciar sesi[oó]n/i.test(
    message
  );
}

/**
 * Only an explicit credential rejection is safe to treat as definitive. A
 * visible login form or a timeout can also be produced by a slow panel,
 * expired browser state, or a transient network failure.
 */
export function isInvalidPlatformCredentialFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /invalid credentials|credenciales.*inv[aá]lidas/i.test(message);
}

function resultFromExecution(pagina: PaginaCode, result: ReportJobResult | undefined): ReportJobResult {
  const expectedKind = pagina === 'ASN' ? 'asn-reporte-cargado-mes' : 'rda-reporte-deposito-total';
  if (!result || result.kind !== expectedKind || result.pagina !== pagina) {
    throw new Error(`Report job did not return a supported report result for pagina=${pagina}`);
  }
  return result;
}

export function createPlatformReportAdapters(
  appConfig: AppConfig,
  logger: Logger,
  options: JobExecutionOptions,
  sessionManager?: PlatformReportSessionManager
): Record<PaginaCode, PlatformReportAdapter> {
  const withSession = <T>(
    lease: ReportRunLease,
    action: (session?: ReportBrowserSession) => Promise<T>
  ): Promise<T> =>
    sessionManager ? sessionManager.withSession(lease, (session) => action(session)) : action(undefined);

  return {
    RdA: {
      pagina: 'RdA',
      async execute(lease) {
        const request: RdaReportJobRequest = {
          id: `report-run-${lease.runId}-${lease.itemId}`,
          jobType: 'report',
          createdAt: new Date().toISOString(),
          options,
          payload: {
            pagina: 'RdA',
            operacion: 'reporte',
            usuario: lease.username,
            agente: lease.loginUsername,
            contrasena_agente: lease.loginPassword,
            reportDate: lease.reportDate
          }
        };
        const execution = await withSession(lease, (session) => runRdaReportJob(request, appConfig, logger, session));
        return resultFromExecution('RdA', execution.result as ReportJobResult | undefined);
      }
    },
    ASN: {
      pagina: 'ASN',
      async execute(lease) {
        const request: AsnReportJobRequest = {
          id: `report-run-${lease.runId}-${lease.itemId}`,
          jobType: 'report',
          createdAt: new Date().toISOString(),
          options,
          payload: {
            pagina: 'ASN',
            operacion: 'reporte',
            usuario: lease.username,
            agente: lease.loginUsername,
            contrasena_agente: lease.loginPassword,
            reportDate: lease.reportDate
          }
        };
        const execution = await withSession(lease, (session) => runAsnReportJob(request, appConfig, logger, session));
        return resultFromExecution('ASN', execution.result as ReportJobResult | undefined);
      }
    }
  };
}
