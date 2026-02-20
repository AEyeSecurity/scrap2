import type { BrowserContext } from 'playwright';
import type { Logger } from 'pino';
import type { AppConfig } from './types';

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
