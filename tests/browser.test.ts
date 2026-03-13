import { describe, expect, it } from 'vitest';
import { buildChromiumLaunchOptions, shouldRetryChromiumLaunchWithoutChannel } from '../src/browser';

describe('browser launch helpers', () => {
  it('prefers the chromium channel in headless mode before falling back to the bundled shell', () => {
    const attempts = buildChromiumLaunchOptions({ headless: true, slowMo: 0 });

    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ headless: true, slowMo: 0, channel: 'chromium' });
    expect(attempts[1]).toMatchObject({ headless: true, slowMo: 0 });
    expect(attempts[1]).not.toHaveProperty('channel');
  });

  it('keeps a single headed launch attempt with the existing maximized window arg', () => {
    const attempts = buildChromiumLaunchOptions({ headless: false, slowMo: 250 });

    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      headless: false,
      slowMo: 250,
      args: ['--start-maximized']
    });
  });

  it('retries without channel when the preferred chromium executable is missing', () => {
    const error = new Error(
      "browserType.launch: Executable doesn't exist at /ms-playwright/chromium-1208/chrome-linux/chrome"
    );

    expect(shouldRetryChromiumLaunchWithoutChannel(error)).toBe(true);
  });

  it('does not classify unrelated browser startup failures as install problems', () => {
    const error = new Error('browserType.launch: Target page, context or browser has been closed');

    expect(shouldRetryChromiumLaunchWithoutChannel(error)).toBe(false);
  });
});
