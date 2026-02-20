import { describe, expect, it } from 'vitest';
import {
  buildAppConfig,
  buildRunConfig,
  buildServerConfig,
  resolveCliOrEnvCredentials
} from '../src/config';

describe('config', () => {
  it('uses CLI flags over env values', () => {
    const cfg = buildRunConfig(
      {
        username: 'cli-user',
        password: 'cli-pass',
        headless: true,
        timeoutMs: 10_000,
        retries: 5
      },
      {
        AGENT_BASE_URL: 'https://agents.reydeases.com',
        AGENT_USERNAME: 'user',
        AGENT_PASSWORD: 'pass',
        SCRAPER_DEFAULT_HEADLESS: 'false',
        SCRAPER_TIMEOUT_MS: '20000',
        SCRAPER_RETRIES: '1'
      }
    );

    expect(cfg.headless).toBe(true);
    expect(cfg.timeoutMs).toBe(10_000);
    expect(cfg.retries).toBe(5);
    expect(cfg.username).toBe('cli-user');
    expect(cfg.password).toBe('cli-pass');
  });

  it('defaults to headed mode locally when env not set (app config)', () => {
    const cfg = buildAppConfig(
      {},
      {
        AGENT_BASE_URL: 'https://agents.reydeases.com'
      }
    );

    expect(cfg.headless).toBe(false);
  });

  it('throws when fromDate is greater than toDate', () => {
    expect(() =>
      buildAppConfig(
        { fromDate: '2026-02-20', toDate: '2026-02-19' },
        {
          AGENT_BASE_URL: 'https://agents.reydeases.com'
        }
      )
    ).toThrow(/fromDate/);
  });

  it('resolves credentials with CLI over env', () => {
    const creds = resolveCliOrEnvCredentials({
      cliUsername: 'cli-user',
      cliPassword: 'cli-pass',
      envUsername: 'env-user',
      envPassword: 'env-pass'
    });

    expect(creds).toEqual({ username: 'cli-user', password: 'cli-pass' });
  });

  it('throws when credentials are missing in CLI and env', () => {
    expect(() =>
      resolveCliOrEnvCredentials({
        envUsername: '',
        envPassword: ''
      })
    ).toThrow(/Username is required/);
  });

  it('builds server config with env defaults', () => {
    const server = buildServerConfig(
      {},
      {
        API_HOST: '127.0.0.1',
        API_PORT: '3000',
        API_LOGIN_CONCURRENCY: '3',
        API_JOB_TTL_MINUTES: '60'
      }
    );

    expect(server.host).toBe('127.0.0.1');
    expect(server.port).toBe(3000);
    expect(server.loginConcurrency).toBe(3);
    expect(server.jobTtlMinutes).toBe(60);
  });
});
