import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleAsnPostLoginContinue } from '../src/asn-post-login';

class FakeLocator {
  constructor(private readonly page: FakePage, private readonly kind: 'continue' | 'auth' | 'empty') {}

  async count(): Promise<number> {
    if (this.kind === 'continue') {
      return this.page.continueVisible ? 1 : 0;
    }

    if (this.kind === 'auth') {
      return this.page.authVisible ? 1 : 0;
    }

    return 0;
  }

  nth(): FakeLocator {
    return this;
  }

  async isVisible(): Promise<boolean> {
    if (this.kind === 'continue') {
      return this.page.continueVisible;
    }

    if (this.kind === 'auth') {
      return this.page.authVisible;
    }

    return false;
  }

  async scrollIntoViewIfNeeded(): Promise<void> {
    return;
  }

  async click(): Promise<void> {
    if (this.kind !== 'continue' || !this.page.continueVisible) {
      throw new Error('locator is not clickable');
    }

    this.page.clickAttempts += 1;
    if (this.page.clickFailuresRemaining > 0) {
      this.page.clickFailuresRemaining -= 1;
      this.page.onFailedClick?.();
      throw new Error('Timeout 900ms exceeded');
    }

    this.page.continueVisible = false;
    this.page.onSuccessfulClick?.();
  }
}

class FakePage {
  authVisible = false;
  continueVisible = false;
  clickFailuresRemaining = 0;
  clickAttempts = 0;
  urlValue = 'https://losasesdelnorte.com/NewAdmin/login.php';
  onFailedClick?: () => void;
  onSuccessfulClick?: () => void;

  url(): string {
    return this.urlValue;
  }

  locator(selector: string): FakeLocator {
    if (/Continuar|Continue/.test(selector)) {
      return new FakeLocator(this, 'continue');
    }

    if (/Bienvenido|Administraci|Usuarios|Mis estad|Reportes financieros|Informes de jugadores|Finanzas|Jugadores/.test(selector)) {
      return new FakeLocator(this, 'auth');
    }

    return new FakeLocator(this, 'empty');
  }

  async waitForTimeout(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
  }

  async waitForLoadState(): Promise<void> {
    return;
  }
}

describe('asn-post-login', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('clicks Continue when it is visible and the shell becomes authenticated', async () => {
    vi.useFakeTimers();

    const page = new FakePage();
    page.continueVisible = true;
    page.onSuccessfulClick = () => {
      page.authVisible = true;
      page.urlValue = 'https://losasesdelnorte.com/NewAdmin/index.php';
    };

    await expect(handleAsnPostLoginContinue(page as unknown as never, 900)).resolves.toBe('ok');
    expect(page.clickAttempts).toBeGreaterThan(0);
  });

  it('skips fast when ASN is already inside the authenticated dashboard', async () => {
    vi.useFakeTimers();

    const page = new FakePage();
    page.authVisible = true;
    page.urlValue = 'https://losasesdelnorte.com/NewAdmin/index.php';

    await expect(handleAsnPostLoginContinue(page as unknown as never, 900)).resolves.toBe('skipped');
    expect(page.clickAttempts).toBe(0);
  });

  it('does not fail when the Continue click throws but the shell is already authenticated', async () => {
    vi.useFakeTimers();

    const page = new FakePage();
    page.continueVisible = true;
    page.clickFailuresRemaining = 2;
    page.onFailedClick = () => {
      page.authVisible = true;
      page.continueVisible = false;
      page.urlValue = 'https://losasesdelnorte.com/NewAdmin/index.php';
    };

    await expect(handleAsnPostLoginContinue(page as unknown as never, 900)).resolves.toBe('ok');
    expect(page.clickAttempts).toBe(1);
  });

  it('stays non-fatal when no Continue control appears', async () => {
    vi.useFakeTimers();

    const page = new FakePage();

    await expect(handleAsnPostLoginContinue(page as unknown as never, 300)).resolves.toBe('skipped');
    expect(page.clickAttempts).toBe(0);
  });
});
