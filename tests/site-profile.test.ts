import { describe, expect, it } from 'vitest';
import { buildAppConfig } from '../src/config';
import { normalizePaginaCode, paginaCodeSchema, resolveSiteAppConfig } from '../src/site-profile';

describe('site-profile helpers', () => {
  it('normalizes pagina aliases and case', () => {
    expect(normalizePaginaCode('RdA')).toBe('RdA');
    expect(normalizePaginaCode('rda')).toBe('RdA');
    expect(normalizePaginaCode(' RDA ')).toBe('RdA');
    expect(normalizePaginaCode('ASN')).toBe('ASN');
    expect(normalizePaginaCode('asn')).toBe('ASN');
    expect(normalizePaginaCode(' AsN ')).toBe('ASN');
  });

  it('returns null for unsupported pagina values', () => {
    expect(normalizePaginaCode('otro')).toBeNull();
    expect(normalizePaginaCode('')).toBeNull();
  });

  it('schema parses supported values and rejects invalid ones', () => {
    expect(paginaCodeSchema.parse('RdA')).toBe('RdA');
    expect(paginaCodeSchema.parse('rda')).toBe('RdA');
    expect(paginaCodeSchema.parse('ASN')).toBe('ASN');
    expect(paginaCodeSchema.parse('asn')).toBe('ASN');
    expect(paginaCodeSchema.safeParse('x').success).toBe(false);
  });

  it('keeps RdA app config unchanged (including warmup path)', () => {
    const base = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });

    const resolved = resolveSiteAppConfig(base, 'RdA');

    expect(resolved).toBe(base);
    expect(resolved.postLoginWarmupPath).toBe('/users/all');
  });

  it('applies ASN app config overrides and disables RdA warmup path', () => {
    const base = buildAppConfig({}, { AGENT_BASE_URL: 'https://agents.reydeases.com' });

    const resolved = resolveSiteAppConfig(base, 'ASN');

    expect(resolved).not.toBe(base);
    expect(resolved.baseUrl).toBe('https://losasesdelnorte.com');
    expect(resolved.loginPath).toBe('/NewAdmin/login.php');
    expect(resolved.postLoginWarmupPath).toBeUndefined();
    expect(resolved.selectors.username.length).toBeGreaterThan(0);
    expect(resolved.selectors.password.length).toBeGreaterThan(0);
    expect(resolved.selectors.submit.length).toBeGreaterThan(0);
  });
});
