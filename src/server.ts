import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Logger } from 'pino';
import { runAsnReportJob } from './asn-report-job';
import { runBalanceJob } from './balance-job';
import { runCreatePlayerJob } from './create-player-job';
import { runDepositJob } from './deposit-job';
import { fundsOperationSchema } from './funds-operation';
import { JobManager } from './jobs';
import { runLoginJob } from './login-job';
import {
  createPlayerPhoneStoreFromEnv,
  toHttpError,
  type PlayerPhoneStore
} from './player-phone-store';
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
  JobStoreEntry,
  LoginJobRequest,
  ServerConfig
} from './types';

interface JobQueue {
  enqueue(request: JobRequest): string;
  getById(id: string): JobStoreEntry | undefined;
  shutdown(): Promise<void>;
}

interface ServerDependencies {
  playerPhoneStore?: PlayerPhoneStore;
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
    stepsOverride: z.array(stepActionSchema).optional()
  })
  .merge(executionOverridesSchema);

const assignPhoneBodySchema = z.object({
  pagina: paginaCodeSchema,
  usuario: z.string().trim().min(1),
  agente: z.string().trim().min(1),
  telefono: z.string().trim().min(1)
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

const DEPOSIT_TURBO_TIMEOUT_MS = 15_000;
const DEPOSIT_AMOUNT_REQUIRED_OPERATIONS: FundsOperation[] = ['carga', 'descarga'];

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
  const turboTimeout = Math.min(appConfig.timeoutMs, DEPOSIT_TURBO_TIMEOUT_MS);
  return {
    headless: overrides.headless ?? appConfig.headless,
    debug: overrides.debug ?? false,
    slowMo: overrides.slowMo ?? 0,
    timeoutMs: overrides.timeoutMs ?? turboTimeout
  };
}

export function createServer(
  appConfig: AppConfig,
  serverConfig: ServerConfig,
  logger: Logger,
  queue?: JobQueue,
  dependencies?: ServerDependencies
): FastifyInstance {
  const fastify = Fastify({ logger: false });
  let cachedPlayerPhoneStore: PlayerPhoneStore | null = dependencies?.playerPhoneStore ?? null;

  function getPlayerPhoneStore(): PlayerPhoneStore {
    if (cachedPlayerPhoneStore) {
      return cachedPlayerPhoneStore;
    }

    cachedPlayerPhoneStore = createPlayerPhoneStoreFromEnv();
    return cachedPlayerPhoneStore;
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
          if (result?.kind === 'create-player') {
            await getPlayerPhoneStore().syncCreatePlayerLink({
              pagina: request.payload.pagina,
              cajeroUsername: request.payload.loginUsername,
              jugadorUsername: result.createdUsername,
              telefono: request.payload.telefono
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

  fastify.post('/users/create-player', async (request, reply) => {
    const parsed = createPlayerBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: 'Invalid payload',
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
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

  fastify.post('/users/assign-phone', async (request, reply) => {
    const parsed = assignPhoneBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: 'Invalid payload',
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
      });
    }

    try {
      await getPlayerPhoneStore().assignPhone({
        pagina: parsed.data.pagina,
        cajeroUsername: parsed.data.agente,
        jugadorUsername: parsed.data.usuario,
        telefono: parsed.data.telefono
      });

      return reply.code(200).send({ status: 'ok' });
    } catch (error) {
      const mappedError = toHttpError(error);
      if (mappedError) {
        return reply.code(mappedError.statusCode).send({ message: mappedError.message });
      }

      logger.error({ error }, 'Unexpected /users/assign-phone error');
      return reply.code(500).send({ message: 'Unexpected persistence error' });
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

  fastify.get('/jobs/:id', async (request, reply) => {
    const parsed = jobParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ message: 'Invalid job id' });
    }

    const entry = internalQueue.getById(parsed.data.id);
    if (!entry) {
      return reply.code(404).send({ message: 'Job not found' });
    }

    return reply.send(entry);
  });

  fastify.addHook('onClose', async () => {
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
