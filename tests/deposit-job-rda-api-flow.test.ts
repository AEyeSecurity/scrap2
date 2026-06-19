import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/logging';
import type { AppConfig, DepositJobRequest } from '../src/types';

const mocks = vi.hoisted(() => ({
  ensureAuthenticated: vi.fn(),
  acquireFundsSessionLease: vi.fn(),
  resolveRdaUserByApi: vi.fn(),
  fetchRdaPaymentAgents: vi.fn(),
  submitRdaPayment: vi.fn()
}));

vi.mock('../src/auth', () => ({
  ensureAuthenticated: mocks.ensureAuthenticated
}));

vi.mock('../src/funds-session-pool', () => ({
  acquireFundsSessionLease: mocks.acquireFundsSessionLease
}));

vi.mock('../src/rda-user-api', async () => {
  const actual = await vi.importActual<typeof import('../src/rda-user-api')>('../src/rda-user-api');
  return {
    ...actual,
    resolveRdaUserByApi: mocks.resolveRdaUserByApi,
    fetchRdaPaymentAgents: mocks.fetchRdaPaymentAgents,
    submitRdaPayment: mocks.submitRdaPayment
  };
});

class FakeLocator {
  public readonly clicks: string[] = [];
  public readonly fills: string[] = [];

  constructor(
    public readonly name: string,
    private readonly inputValueText = '1'
  ) {}

  filter(): FakeLocator {
    return this;
  }

  first(): FakeLocator {
    return this;
  }

  nth(): FakeLocator {
    return this;
  }

  async count(): Promise<number> {
    return 1;
  }

  async isVisible(): Promise<boolean> {
    return true;
  }

  async isDisabled(): Promise<boolean> {
    return false;
  }

  async boundingBox(): Promise<{ y: number }> {
    return { y: this.name === 'submit' ? 100 : 1 };
  }

  async evaluate(): Promise<string> {
    return 'button';
  }

  async scrollIntoViewIfNeeded(): Promise<void> {}

  async click(): Promise<void> {
    this.clicks.push(this.name);
  }

  async fill(value: string): Promise<void> {
    this.fills.push(value);
  }

  async press(): Promise<void> {}

  async inputValue(): Promise<string> {
    return this.inputValueText;
  }
}

class FakePage {
  public readonly urls: string[] = [];
  public readonly amountInput: FakeLocator;
  public readonly submitButton = new FakeLocator('submit');
  public readonly totalButton: FakeLocator;
  private currentUrl = 'https://agents.reydeases.com';

  constructor(totalAmountValue = '1') {
    this.amountInput = new FakeLocator('amount-input', totalAmountValue);
    this.totalButton = new FakeLocator('total-button');
  }

  async goto(url: string): Promise<void> {
    this.urls.push(url);
    this.currentUrl = `https://agents.reydeases.com${url}`;
  }

  url(): string {
    return this.currentUrl;
  }

  locator(selector: string): FakeLocator {
    if (selector.includes('withdrawal__all-button')) {
      return this.totalButton;
    }
    if (selector.includes('amount') || selector.includes('number') || selector.includes('cantidad')) {
      return this.amountInput;
    }
    return this.submitButton;
  }

  getByRole(): FakeLocator {
    return new FakeLocator('heading');
  }

  async waitForTimeout(): Promise<void> {}

  async screenshot(): Promise<void> {}
}

function makeConfig(): AppConfig {
  return {
    baseUrl: 'https://agents.reydeases.com',
    headless: true,
    debug: false,
    slowMo: 0,
    timeoutMs: 5_000,
    retries: 0,
    concurrency: 1,
    outputDir: path.join(os.tmpdir(), 'megascrap-test-out'),
    artifactsDir: path.join(os.tmpdir(), `megascrap-test-artifacts-${randomUUID()}`),
    maxPages: 1,
    logLevel: 'silent',
    blockResources: true,
    reuseSession: false,
    apiEndpoints: [],
    loginPath: '/login',
    postLoginWarmupPath: '/users/all',
    selectors: {
      username: ['input[name="username"]'],
      password: ['input[name="password"]'],
      submit: ['button[type="submit"]']
    }
  };
}

function makeDepositRequest(
  payload: DepositJobRequest['payload'],
  timeoutMs = 5_000
): DepositJobRequest {
  return {
    id: randomUUID(),
    jobType: 'deposit',
    createdAt: new Date().toISOString(),
    payload,
    options: {
      headless: true,
      debug: false,
      slowMo: 0,
      timeoutMs
    }
  };
}

describe('runDepositJob RdA API flow', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.ensureAuthenticated.mockReset();
    mocks.acquireFundsSessionLease.mockReset();
    mocks.resolveRdaUserByApi.mockReset();
    mocks.fetchRdaPaymentAgents.mockReset();
    mocks.submitRdaPayment.mockReset();
    mocks.fetchRdaPaymentAgents.mockResolvedValue({ defaultAgentId: 21991 });
  });

  it('opens carga by API user id and verifies final balance by API without /users/all', async () => {
    const page = new FakePage();
    const release = vi.fn();
    const invalidate = vi.fn();
    mocks.acquireFundsSessionLease.mockResolvedValue({
      context: { tracing: { start: vi.fn(), stop: vi.fn() } },
      page,
      release,
      invalidate
    });
    mocks.resolveRdaUserByApi
      .mockResolvedValueOnce({ agentId: '21991', user: { id: '42775', username: '3nico395', balance: 100 } })
      .mockResolvedValueOnce({ agentId: '21991', user: { id: '42775', username: '3nico395', balance: 125 } });

    const { runDepositJob } = await import('../src/deposit-job');
    const result = await runDepositJob(
      makeDepositRequest({
        pagina: 'RdA',
        operacion: 'carga',
        usuario: '3nico395',
        agente: 'luqui10',
        contrasena_agente: 'secret',
        cantidad: 25
      }),
      makeConfig(),
      createLogger('silent', false)
    );

    expect(page.urls).toEqual(['/users/deposit/42775']);
    expect(page.urls).not.toContain('/users/all');
    expect(mocks.ensureAuthenticated).toHaveBeenCalledTimes(1);
    expect(mocks.resolveRdaUserByApi).toHaveBeenNthCalledWith(1, page, '3nico395', 5_000);
    expect(mocks.resolveRdaUserByApi).toHaveBeenNthCalledWith(2, page, '3nico395', expect.any(Number), '21991');
    expect(mocks.fetchRdaPaymentAgents).toHaveBeenCalledWith(page, '42775', 5_000);
    expect(mocks.submitRdaPayment).toHaveBeenCalledWith(
      page,
      {
        userId: '42775',
        amount: 25,
        operation: 0,
        paymentAgentId: 21991
      },
      5_000
    );
    expect(result.result).toMatchObject({
      kind: 'rda-funds-operation',
      operacion: 'carga',
      usuario: '3nico395',
      montoSolicitado: 25,
      montoAplicado: 25,
      saldoAntesNumero: 100,
      saldoDespuesNumero: 125
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('uses API balance for descarga_total amount and verifies zero final balance', async () => {
    const page = new FakePage('80');
    mocks.acquireFundsSessionLease.mockResolvedValue({
      context: { tracing: { start: vi.fn(), stop: vi.fn() } },
      page,
      release: vi.fn(),
      invalidate: vi.fn()
    });
    mocks.resolveRdaUserByApi
      .mockResolvedValueOnce({ agentId: '21991', user: { id: '42775', username: '3nico395', balance: 80 } })
      .mockResolvedValueOnce({ agentId: '21991', user: { id: '42775', username: '3nico395', balance: 0 } });

    const { runDepositJob } = await import('../src/deposit-job');
    const result = await runDepositJob(
      makeDepositRequest({
        pagina: 'RdA',
        operacion: 'descarga_total',
        usuario: '3nico395',
        agente: 'luqui10',
        contrasena_agente: 'secret'
      }),
      makeConfig(),
      createLogger('silent', false)
    );

    expect(page.urls).toEqual(['/users/withdrawal/42775']);
    expect(page.amountInput.fills).toEqual(['', '80']);
    expect(mocks.submitRdaPayment).toHaveBeenCalledWith(
      page,
      {
        userId: '42775',
        amount: 80,
        operation: 1,
        paymentAgentId: 21991
      },
      5_000
    );
    expect(result.result).toMatchObject({
      kind: 'rda-funds-operation',
      operacion: 'descarga_total',
      montoSolicitado: 80,
      montoAplicado: 80,
      saldoAntesNumero: 80,
      saldoDespuesNumero: 0
    });
  });
});
