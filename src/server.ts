import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Logger } from 'pino';
import { runCreatePlayerJob } from './create-player-job';
import { runDepositJob } from './deposit-job';
import { fundsOperationSchema } from './funds-operation';
import { JobManager } from './jobs';
import { runLoginJob } from './login-job';
import type {
  AppConfig,
  CreatePlayerJobRequest,
  DepositJobRequest,
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
    loginUsername: z.string().min(1),
    loginPassword: z.string().min(1),
    newUsername: z.string().min(1),
    newPassword: z.string().min(1),
    stepsOverride: z.array(stepActionSchema).optional()
  })
  .merge(executionOverridesSchema);

const depositBodySchema = z
  .object({
    operacion: fundsOperationSchema,
    usuario: z.string().trim().min(1),
    agente: z.string().trim().min(1),
    contrasena_agente: z.string().trim().min(1),
    cantidad: z.number().int().positive()
  })
  .merge(executionOverridesSchema);

const jobParamsSchema = z.object({
  id: z.string().min(1)
});

const DEPOSIT_TURBO_TIMEOUT_MS = 15_000;

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
    headless: overrides.headless ?? false,
    debug: overrides.debug ?? false,
    slowMo: overrides.slowMo ?? 0,
    timeoutMs: overrides.timeoutMs ?? turboTimeout
  };
}

export function createServer(
  appConfig: AppConfig,
  serverConfig: ServerConfig,
  logger: Logger,
  queue?: JobQueue
): FastifyInstance {
  const fastify = Fastify({ logger: false });

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
          return runCreatePlayerJob(request, appConfig, logger);
        }

        if (request.jobType === 'deposit') {
          return runDepositJob(request, appConfig, logger);
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
        loginUsername: payload.loginUsername,
        loginPassword: payload.loginPassword,
        newUsername: payload.newUsername,
        newPassword: payload.newPassword,
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

  fastify.post('/users/deposit', async (request, reply) => {
    const parsed = depositBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: 'Invalid payload',
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
      });
    }

    const payload = parsed.data;
    const createdAt = new Date().toISOString();
    const id = randomUUID();
    const jobRequest: DepositJobRequest = {
      id,
      jobType: 'deposit',
      createdAt,
      payload: {
        operacion: payload.operacion,
        usuario: payload.usuario,
        agente: payload.agente,
        contrasena_agente: payload.contrasena_agente,
        cantidad: payload.cantidad
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
