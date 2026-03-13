import { chromium, type Browser, type BrowserContext, type LaunchOptions } from 'playwright';
import type { Logger } from 'pino';
import type { AppConfig } from './types';

const CHROMIUM_HEADLESS_CHANNEL = 'chromium';
const CHANNEL_INSTALL_ERROR_REGEX =
  /Executable doesn't exist|Please run the following command|browser(?:\s+distribution)? .* not found|Failed to launch .* because executable doesn't exist/i;

function buildBaseLaunchOptions(cfg: Pick<AppConfig, 'headless' | 'slowMo'>): LaunchOptions {
  return {
    headless: cfg.headless,
    slowMo: cfg.slowMo,
    args: cfg.headless ? undefined : ['--start-maximized']
  };
}

export function buildChromiumLaunchOptions(cfg: Pick<AppConfig, 'headless' | 'slowMo'>): LaunchOptions[] {
  const base = buildBaseLaunchOptions(cfg);
  if (!cfg.headless) {
    return [base];
  }

  return [{ ...base, channel: CHROMIUM_HEADLESS_CHANNEL }, base];
}

export function shouldRetryChromiumLaunchWithoutChannel(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return CHANNEL_INSTALL_ERROR_REGEX.test(message);
}

export async function launchChromiumBrowser(
  cfg: Pick<AppConfig, 'headless' | 'slowMo'>,
  logger: Logger
): Promise<Browser> {
  const attempts = buildChromiumLaunchOptions(cfg);
  let lastError: unknown;

  for (const [index, launchOptions] of attempts.entries()) {
    try {
      const browser = await chromium.launch(launchOptions);
      if (index > 0) {
        logger.warn(
          {
            fallbackAttempt: index + 1,
            headless: cfg.headless
          },
          'Chromium browser launched using compatibility fallback'
        );
      }
      return browser;
    } catch (error) {
      lastError = error;
      const canRetry = index < attempts.length - 1;
      if (!canRetry) {
        break;
      }

      const retryReason = shouldRetryChromiumLaunchWithoutChannel(error)
        ? 'preferred chromium channel is not installed'
        : 'preferred chromium channel failed to launch';

      logger.warn(
        {
          error,
          retryAttempt: index + 2,
          retryReason
        },
        'Chromium browser launch failed, retrying with compatibility fallback'
      );
    }
  }

  const finalError = lastError instanceof Error ? lastError : new Error(String(lastError));
  throw new Error(`Could not launch Playwright Chromium browser: ${finalError.message}`, {
    cause: finalError
  });
}

export async function configureContext(context: BrowserContext, cfg: AppConfig, logger: Logger): Promise<void> {
  context.setDefaultTimeout(cfg.timeoutMs);
  context.setDefaultNavigationTimeout(cfg.timeoutMs);

  if (!cfg.blockResources) {
    return;
  }

  if (!cfg.headless) {
    logger.debug('Skipping resource blocking in headed mode to preserve full visual fidelity');
    return;
  }

  await context.route('**/*', async (route) => {
    const request = route.request();
    const type = request.resourceType();

    if (type === 'image' || type === 'font' || type === 'media') {
      await route.abort();
      return;
    }

    await route.continue();
  });

  logger.debug('Resource blocking enabled for image/font/media');
}
