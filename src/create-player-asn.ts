import path from 'node:path';
import { promises as fs } from 'node:fs';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import type { Logger } from 'pino';
import { ensureAuthenticated } from './auth';
import { configureContext } from './browser';
import { resolveSiteAppConfig } from './site-profile';
import type { AppConfig, CreatePlayerJobRequest, JobExecutionResult, JobStepResult } from './types';

type AsnCreateDefaults = {
  nombre: string;
  apellido: string;
  email: string;
};

function sanitizeFileName(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
}

export function buildAsnCreateDefaults(username: string): AsnCreateDefaults {
  return {
    nombre: 'Alta',
    apellido: 'Bot',
    email: `${username}@example.com`
  };
}

async function captureStepScreenshot(page: Page, artifactDir: string, name: string): Promise<string> {
  const filePath = path.join(artifactDir, `${sanitizeFileName(name)}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
}

async function waitBeforeCloseIfHeaded(page: Page, headless: boolean, debug: boolean): Promise<void> {
  if (headless || !debug) {
    return;
  }
  await page.waitForTimeout(15_000);
}

async function findFirstVisibleInLocator(locator: Locator, timeoutMs: number, pollingMs = 100): Promise<Locator> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const candidate = locator.nth(i);
      if (await candidate.isVisible().catch(() => false)) {
        return candidate;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollingMs));
  }
  throw new Error('No visible candidate found');
}

async function findFirstVisibleLocator(page: Page, selector: string, timeoutMs: number): Promise<Locator> {
  return findFirstVisibleInLocator(page.locator(selector), timeoutMs);
}

async function clickLocator(locator: Locator, timeoutMs: number): Promise<void> {
  await locator.scrollIntoViewIfNeeded({ timeout: timeoutMs }).catch(() => undefined);
  try {
    await locator.click({ timeout: timeoutMs });
  } catch {
    await locator.click({ timeout: timeoutMs, force: true });
  }
}

async function executeActionStep(
  page: Page,
  artifactDir: string,
  stepName: string,
  action: () => Promise<void>,
  captureOnSuccess: boolean
): Promise<JobStepResult> {
  const startedAt = new Date().toISOString();

  try {
    await action();
    const artifactPath = captureOnSuccess ? await captureStepScreenshot(page, artifactDir, stepName) : undefined;
    return {
      name: stepName,
      status: 'ok',
      startedAt,
      finishedAt: new Date().toISOString(),
      ...(artifactPath ? { artifactPath } : {})
    };
  } catch (error) {
    return {
      name: stepName,
      status: 'failed',
      startedAt,
      finishedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function labelXpath(label: string, tag: 'input' | 'select' | 'textarea' = 'input'): string {
  const lower = label.toLowerCase();
  return `xpath=//*[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZÁÉÍÓÚÑ", "abcdefghijklmnopqrstuvwxyzáéíóúñ"), "${lower}")]/following::*[self::${tag}][1]`;
}

async function findVisibleBySelectors(page: Page, selectors: string[], timeoutMs: number): Promise<Locator> {
  const startedAt = Date.now();
  let lastError = 'No visible selector matched';

  while (Date.now() - startedAt < timeoutMs) {
    for (const selector of selectors) {
      try {
        return await findFirstVisibleLocator(page, selector, 150);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    await page.waitForTimeout(100);
  }

  throw new Error(lastError);
}

async function tryHandleAsnContinue(page: Page, timeoutMs: number): Promise<'ok' | 'skipped'> {
  const selector = [
    'button:has-text("Continuar")',
    'a:has-text("Continuar")',
    'input[type="button"][value*="Continuar" i]',
    'input[type="submit"][value*="Continuar" i]',
    'button:has-text("Continue")',
    'a:has-text("Continue")'
  ].join(', ');
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const candidates = page.locator(selector);
    const count = await candidates.count().catch(() => 0);

    for (let i = 0; i < count; i += 1) {
      const candidate = candidates.nth(i);
      if (!(await candidate.isVisible().catch(() => false))) {
        continue;
      }

      await clickLocator(candidate, timeoutMs);
      await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => undefined);
      return 'ok';
    }

    await page.waitForTimeout(100);
  }

  return 'skipped';
}

async function openAsnNewPlayerDialog(page: Page, timeoutMs: number): Promise<void> {
  try {
    await page.goto('/NewAdmin/RegistroJugador.php', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    return;
  } catch {
    // Fallback to the Jugadores screen button if direct navigation fails.
  }

  const newPlayerButton = await findVisibleBySelectors(
    page,
    [
      'button:has-text("Nuevo Jugador")',
      'a:has-text("Nuevo Jugador")',
      'input[type="button"][value*="Nuevo" i]',
      'input[type="submit"][value*="Nuevo" i]',
      'img[alt*="Nuevo" i]',
      'img[title*="Nuevo" i]',
      '[title*="Nuevo Jugador" i]',
      '[alt*="Nuevo Jugador" i]',
      'button:has-text("Nuevo Usuario")',
      'a:has-text("Nuevo Usuario")',
      'a[href*="RegistroJugador.php"]',
      'img[name="nuevojugador"]',
      '[onclick*="Nuevo" i]',
      '[href*="Nuevo" i]'
    ],
    timeoutMs
  );

  await clickLocator(newPlayerButton, timeoutMs);
}

async function waitForAsnCreateForm(page: Page, timeoutMs: number): Promise<void> {
  const formSignals = [
    'text=/login\\s*\\/\\s*nick de usuario/i',
    'text=/verificar contraseñ?a/i',
    'text=/correo electr[oó]nico/i'
  ];

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    for (const selector of formSignals) {
      const visible = await page.locator(selector).first().isVisible().catch(() => false);
      if (visible) {
        return;
      }
    }

    const visible = await page.locator('input[type="password"]').count().catch(() => 0);
    if (visible >= 2) {
      return;
    }
    await page.waitForTimeout(100);
  }

  throw new Error('ASN create-player form did not appear');
}

async function fillByLabelInput(page: Page, labels: string[], value: string, timeoutMs: number): Promise<void> {
  const locator = await findVisibleBySelectors(page, labels.map((label) => labelXpath(label, 'input')), timeoutMs);
  await locator.fill('', { timeout: timeoutMs });
  await locator.fill(value, { timeout: timeoutMs });
}

async function fillAsnInputBySelectors(
  page: Page,
  selectors: string[],
  value: string,
  timeoutMs: number
): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (!(await locator.isVisible().catch(() => false))) {
      continue;
    }

    await locator.fill('', { timeout: timeoutMs });
    await locator.fill(value, { timeout: timeoutMs });
    return true;
  }

  return false;
}

async function selectByLabel(page: Page, labels: string[], optionText: string, timeoutMs: number): Promise<void> {
  const locator = await findVisibleBySelectors(page, labels.map((label) => labelXpath(label, 'select')), timeoutMs);
  try {
    await locator.selectOption({ label: optionText }, { timeout: timeoutMs });
    return;
  } catch {
    // fallback by matching visible text manually
  }

  const options = await locator.locator('option').allTextContents().catch(() => []);
  const match = options.find((item) => item.trim().toLowerCase().includes(optionText.toLowerCase()));
  if (!match) {
    return;
  }
  await locator.selectOption({ label: match.trim() }, { timeout: timeoutMs }).catch(() => undefined);
}

async function ensureCheckboxByNearbyText(
  page: Page,
  textRegex: RegExp,
  timeoutMs: number
): Promise<void> {
  const checkbox = page.locator('input[type="checkbox"]').filter({
    has: page.locator('xpath=following-sibling::*[1] | xpath=preceding-sibling::*[1]')
  });
  const count = await checkbox.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const candidate = checkbox.nth(i);
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) continue;
    const containerText = await candidate.locator('xpath=ancestor::*[1]').innerText().catch(() => '');
    if (!textRegex.test(containerText)) continue;
    const checked = await candidate.isChecked().catch(() => false);
    if (!checked) {
      await candidate.check({ timeout: timeoutMs }).catch(async () => clickLocator(candidate, timeoutMs));
    }
    return;
  }
}

async function chooseMasculinoIfVisible(page: Page, timeoutMs: number): Promise<void> {
  const candidates = page.locator('input[type="radio"]');
  const count = await candidates.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const candidate = candidates.nth(i);
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) continue;
    const contextText = await candidate.locator('xpath=ancestor::*[1]').innerText().catch(() => '');
    if (!/masculino/i.test(contextText)) continue;
    const checked = await candidate.isChecked().catch(() => false);
    if (!checked) {
      await candidate.check({ timeout: timeoutMs }).catch(async () => clickLocator(candidate, timeoutMs));
    }
    return;
  }
}

async function fillAsnCreateForm(
  page: Page,
  request: CreatePlayerJobRequest,
  timeoutMs: number
): Promise<void> {
  const defaults = buildAsnCreateDefaults(request.payload.newUsername);

  const monedaSelect = page.locator('select[name="moneda"], #moneda').first();
  if (await monedaSelect.isVisible().catch(() => false)) {
    await monedaSelect.selectOption({ label: 'ARS' }, { timeout: timeoutMs }).catch(() => undefined);
  } else {
    await selectByLabel(page, ['Moneda de Juego'], 'ARS', timeoutMs);
  }

  const nivelSelect = page.locator('select[name="niveljugador"], #niveljugador').first();
  if (await nivelSelect.isVisible().catch(() => false)) {
    await nivelSelect.selectOption({ label: 'Nivel 1' }, { timeout: timeoutMs }).catch(() => undefined);
  } else {
    await selectByLabel(page, ['Nivel de Apuestas', 'PlayerLevel'], 'Nivel 1', timeoutMs);
  }

  await ensureCheckboxByNearbyText(page, /billetera\s+unica/i, timeoutMs).catch(() => undefined);

  if (!(await fillAsnInputBySelectors(page, ['input[name="nombre"]', '#nombre'], defaults.nombre, timeoutMs))) {
    await fillByLabelInput(page, ['Nombre'], defaults.nombre, timeoutMs);
  }
  if (!(await fillAsnInputBySelectors(page, ['input[name="apellido"]', '#apellido'], defaults.apellido, timeoutMs))) {
    await fillByLabelInput(page, ['Apellido'], defaults.apellido, timeoutMs);
  }
  if (!(await fillAsnInputBySelectors(page, ['input[name="idusuario"]', '#idusuario'], request.payload.newUsername, timeoutMs))) {
    await fillByLabelInput(page, ['Login / Nick de usuario', 'Nick de usuario'], request.payload.newUsername, timeoutMs);
  }
  if (!(await fillAsnInputBySelectors(page, ['input[name="contrasenia"]', '#contrasenia'], request.payload.newPassword, timeoutMs))) {
    await fillByLabelInput(page, ['Contraseña'], request.payload.newPassword, timeoutMs);
  }
  if (!(await fillAsnInputBySelectors(page, ['input[name="contrasenia2"]', '#contrasenia2'], request.payload.newPassword, timeoutMs))) {
    await fillByLabelInput(page, ['Verificar contraseña'], request.payload.newPassword, timeoutMs);
  }
  if (!(await fillAsnInputBySelectors(page, ['input[name="email"]', '#email'], defaults.email, timeoutMs))) {
    await fillByLabelInput(page, ['Correo electrónico'], defaults.email, timeoutMs);
  }

  await chooseMasculinoIfVisible(page, timeoutMs).catch(() => undefined);

  const paisSelect = page.locator('select[name="pais"], #pais').first();
  if (await paisSelect.isVisible().catch(() => false)) {
    await paisSelect.selectOption({ label: 'Argentina' }, { timeout: timeoutMs }).catch(() => undefined);
  } else {
    await selectByLabel(page, ['País'], 'Argentina', timeoutMs).catch(() => undefined);
  }
}

async function clickAsnCreateUser(page: Page, timeoutMs: number): Promise<void> {
  const submit = await findVisibleBySelectors(
    page,
    [
      'a[href*="validarFormReg"]',
      'img[name="crearcuenta"]',
      'button:has-text("Crear usuario")',
      'input[type="submit"][value*="Crear" i]',
      'button:has-text("Crear")'
    ],
    timeoutMs
  );
  await submit.scrollIntoViewIfNeeded({ timeout: timeoutMs }).catch(() => undefined);
  await clickLocator(submit, timeoutMs);
}

async function waitAsnCreateUiOutcome(page: Page, timeoutMs: number): Promise<{ state: 'success' | 'error' | 'unknown'; reason: string }> {
  const startedAt = Date.now();
  const success = page.locator('text=/cread[oa]|registrad[oa]|exito|éxito|correctamente/i').first();
  const error = page.locator('text=/ya existe|error|fall[oó]|incorrect|inv[aá]lido/i').first();

  while (Date.now() - startedAt < timeoutMs) {
    if (await error.isVisible().catch(() => false)) {
      return {
        state: 'error',
        reason: (await error.innerText().catch(() => '')).trim() || 'ASN create error message detected'
      };
    }
    if (await success.isVisible().catch(() => false)) {
      return {
        state: 'success',
        reason: (await success.innerText().catch(() => '')).trim() || 'ASN create success message detected'
      };
    }
    await page.waitForTimeout(100);
  }

  return { state: 'unknown', reason: 'No clear ASN create UI signal detected' };
}

async function tryFilterAsnPlayersList(page: Page, username: string, timeoutMs: number): Promise<void> {
  const input = page.locator('input#ABuscar, input[name="ABuscar"]').first();
  if (!(await input.isVisible().catch(() => false))) {
    return;
  }

  await input.click({ timeout: timeoutMs }).catch(() => undefined);
  await input.fill('', { timeout: timeoutMs }).catch(() => undefined);
  await input.pressSequentially(username, { delay: 0 }).catch(async () => {
    await input.type(username, { delay: 0, timeout: timeoutMs }).catch(() => undefined);
  });

  // Legacy ASN search filters on keyup; give it a short settle window.
  await page.waitForTimeout(250);

  const searchTrigger = page
    .locator(
      [
        'a:has(img[src*="buscar" i])',
        'img[src*="buscar" i]',
        'a[onmouseover*="buscarOn" i]',
        'a[onclick*="filtroBusqueda" i]'
      ].join(', ')
    )
    .first();

  if (await searchTrigger.isVisible().catch(() => false)) {
    await clickLocator(searchTrigger, timeoutMs);
    await page.waitForTimeout(250);
  }
}

async function verifyAsnUserInPlayersList(page: Page, username: string, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  const normalizedUser = username.trim().toLowerCase();
  let filterAttempted = false;

  while (Date.now() - startedAt < timeoutMs) {
    if (!filterAttempted) {
      filterAttempted = true;
      await tryFilterAsnPlayersList(page, username, timeoutMs).catch(() => undefined);
    }

    const playerLinks = await page
      .locator('a[href*="Jugadores.php?usr="]')
      .evaluateAll((els) => els.map((el) => (el.textContent || '').trim()))
      .catch(() => [] as string[]);
    if (playerLinks.some((value) => value === username)) {
      return true;
    }
    if (playerLinks.some((value) => value.trim().toLowerCase() === normalizedUser)) {
      return true;
    }

    const options = await page
      .locator('select option')
      .evaluateAll((els) => els.map((el) => (el.textContent || '').trim()))
      .catch(() => []);
    if (options.some((value) => value.trim().toLowerCase() === normalizedUser)) {
      return true;
    }

    const bodyVisible = await page.getByText(new RegExp(username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')).isVisible().catch(
      () => false
    );
    if (bodyVisible) {
      return true;
    }

    await page.waitForTimeout(150);
  }

  return false;
}

export async function runCreatePlayerAsnJob(
  request: CreatePlayerJobRequest,
  appConfig: AppConfig,
  logger: Logger
): Promise<JobExecutionResult> {
  if (request.payload.newUsername.trim().length > 12) {
    throw new Error(
      `ASN newUsername must be 12 characters or fewer for exact verification (received ${request.payload.newUsername.length})`
    );
  }

  const jobLogger = logger.child({ jobId: request.id, jobType: request.jobType, pagina: request.payload.pagina });
  const artifactDir = path.join(appConfig.artifactsDir, 'jobs', request.id);
  const siteConfig = resolveSiteAppConfig(appConfig, 'ASN');
  const runtimeConfig: AppConfig = {
    ...siteConfig,
    headless: request.options.headless,
    debug: request.options.debug,
    slowMo: request.options.slowMo,
    timeoutMs: request.options.timeoutMs,
    // ASN players screens are image-heavy but can render inconsistently if images are aborted.
    // For create-player turbo, prioritize end-to-end reliability over image blocking.
    blockResources: false
  };
  const isTurbo = !runtimeConfig.debug && runtimeConfig.slowMo === 0;
  const captureSuccessArtifacts = false;

  await fs.mkdir(artifactDir, { recursive: true });

  const browser = await chromium.launch({
    headless: runtimeConfig.headless,
    slowMo: runtimeConfig.slowMo,
    args: runtimeConfig.headless ? undefined : ['--start-maximized']
  });

  const context = await browser.newContext({
    baseURL: runtimeConfig.baseUrl,
    viewport: runtimeConfig.headless ? { width: 1920, height: 1080 } : null,
    recordVideo: runtimeConfig.debug ? { dir: path.join(artifactDir, 'video') } : undefined
  });
  await configureContext(context, runtimeConfig, jobLogger);

  const page = await context.newPage();
  const artifactPaths: string[] = [];
  const steps: JobStepResult[] = [];
  const tracePath = path.join(artifactDir, 'trace.zip');
  const traceFailurePath = path.join(artifactDir, 'trace-failure.zip');
  const screenshotFailurePath = path.join(artifactDir, 'error.png');
  let tracingStarted = false;

  try {
    if (runtimeConfig.debug) {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      tracingStarted = true;
    }

    const loginStartedAt = new Date().toISOString();
    await ensureAuthenticated(
      context,
      page,
      runtimeConfig,
      { username: request.payload.loginUsername, password: request.payload.loginPassword },
      jobLogger,
      { persistSession: false }
    );
    const loginArtifact = captureSuccessArtifacts ? await captureStepScreenshot(page, artifactDir, '00-login') : undefined;
    if (loginArtifact) artifactPaths.push(loginArtifact);
    steps.push({
      name: '00-login',
      status: 'ok',
      startedAt: loginStartedAt,
      finishedAt: new Date().toISOString(),
      ...(loginArtifact ? { artifactPath: loginArtifact } : {})
    });

    const continueStartedAt = new Date().toISOString();
    try {
      const continueState = await tryHandleAsnContinue(
        page,
        isTurbo ? 800 : Math.min(runtimeConfig.timeoutMs, 2_000)
      );
      steps.push({
        name: '01b-continue-intermediate',
        status: continueState === 'ok' ? 'ok' : 'skipped',
        startedAt: continueStartedAt,
        finishedAt: new Date().toISOString()
      });
    } catch (error) {
      const continueError = error instanceof Error ? error.message : String(error);
      steps.push({
        name: '01b-continue-intermediate',
        status: 'failed',
        startedAt: continueStartedAt,
        finishedAt: new Date().toISOString(),
        error: continueError
      });
      throw new Error(`Step failed: 01b-continue-intermediate (${continueError})`);
    }

    const gotoJugadoresStep = await executeActionStep(
      page,
      artifactDir,
      '02-goto-jugadores',
      async () => {
        await page.goto('/NewAdmin/Jugadores.php', { waitUntil: 'domcontentloaded', timeout: runtimeConfig.timeoutMs });
      },
      captureSuccessArtifacts
    );
    steps.push(gotoJugadoresStep);
    if (gotoJugadoresStep.status === 'failed') {
      throw new Error(`Step failed: ${gotoJugadoresStep.name} (${gotoJugadoresStep.error ?? 'unknown error'})`);
    }

    const openNewStep = await executeActionStep(
      page,
      artifactDir,
      '03-open-new-player',
      async () => {
        await openAsnNewPlayerDialog(page, runtimeConfig.timeoutMs);
      },
      captureSuccessArtifacts
    );
    steps.push(openNewStep);
    if (openNewStep.status === 'failed') {
      throw new Error(`Step failed: ${openNewStep.name} (${openNewStep.error ?? 'unknown error'})`);
    }

    const waitFormStep = await executeActionStep(
      page,
      artifactDir,
      '04-wait-create-form',
      async () => {
        await waitForAsnCreateForm(page, isTurbo ? Math.min(runtimeConfig.timeoutMs, 2_000) : runtimeConfig.timeoutMs);
      },
      captureSuccessArtifacts
    );
    steps.push(waitFormStep);
    if (waitFormStep.status === 'failed') {
      throw new Error(`Step failed: ${waitFormStep.name} (${waitFormStep.error ?? 'unknown error'})`);
    }

    const fillFormStep = await executeActionStep(
      page,
      artifactDir,
      '05-fill-create-form',
      async () => {
        await fillAsnCreateForm(page, request, runtimeConfig.timeoutMs);
      },
      captureSuccessArtifacts
    );
    steps.push(fillFormStep);
    if (fillFormStep.status === 'failed') {
      throw new Error(`Step failed: ${fillFormStep.name} (${fillFormStep.error ?? 'unknown error'})`);
    }

    const clickCreateStep = await executeActionStep(
      page,
      artifactDir,
      '06-click-create-user',
      async () => {
        if (isTurbo) {
          // The ASN form uses legacy JS validation on an image/link submit.
          // A tiny settle delay after fills avoids intermittent no-op submits.
          await page.waitForTimeout(250);
        }
        await clickAsnCreateUser(page, runtimeConfig.timeoutMs);
      },
      captureSuccessArtifacts
    );
    steps.push(clickCreateStep);
    if (clickCreateStep.status === 'failed') {
      throw new Error(`Step failed: ${clickCreateStep.name} (${clickCreateStep.error ?? 'unknown error'})`);
    }

    const verifyUiStepStarted = new Date().toISOString();
    const uiOutcome = await waitAsnCreateUiOutcome(
      page,
      isTurbo ? Math.min(runtimeConfig.timeoutMs, 3_000) : Math.min(runtimeConfig.timeoutMs, 5_000)
    );
    steps.push({
      name: '07-verify-create-ui',
      status: uiOutcome.state === 'error' ? 'failed' : uiOutcome.state === 'success' ? 'ok' : 'skipped',
      startedAt: verifyUiStepStarted,
      finishedAt: new Date().toISOString(),
      ...(uiOutcome.state === 'error' ? { error: uiOutcome.reason } : {})
    });
    if (uiOutcome.state === 'error') {
      throw new Error(`Step failed: 07-verify-create-ui (${uiOutcome.reason})`);
    }

    const verifyListStep = await executeActionStep(
      page,
      artifactDir,
      '08-verify-user-listed',
      async () => {
        await page.waitForTimeout(isTurbo ? 600 : 0);
        await page.goto('/NewAdmin/Jugadores.php', {
          waitUntil: 'domcontentloaded',
          timeout: runtimeConfig.timeoutMs
        });
        const found = await verifyAsnUserInPlayersList(
          page,
          request.payload.newUsername,
          isTurbo ? Math.min(runtimeConfig.timeoutMs, 6_000) : Math.min(runtimeConfig.timeoutMs, 8_000)
        );
        if (!found) {
          await page.goto('/NewAdmin/Jugadores.php', { waitUntil: 'domcontentloaded', timeout: runtimeConfig.timeoutMs });
        }
        const foundAfterFallback = found
          ? true
          : await verifyAsnUserInPlayersList(
              page,
              request.payload.newUsername,
              isTurbo ? Math.min(runtimeConfig.timeoutMs, 4_000) : Math.min(runtimeConfig.timeoutMs, 8_000)
            );
        if (!foundAfterFallback) {
          throw new Error(`User "${request.payload.newUsername}" not found in ASN players list after creation`);
        }
      },
      captureSuccessArtifacts
    );
    steps.push(verifyListStep);
    if (verifyListStep.status === 'failed') {
      throw new Error(`Step failed: ${verifyListStep.name} (${verifyListStep.error ?? 'unknown error'})`);
    }

    steps.push({
      name: '99-final',
      status: 'ok',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString()
    });

    if (tracingStarted) {
      await context.tracing.stop({ path: tracePath });
      artifactPaths.push(tracePath);
      tracingStarted = false;
    }

    await waitBeforeCloseIfHeaded(page, runtimeConfig.headless, runtimeConfig.debug);
    await context.close();
    await browser.close();
    return { artifactPaths, steps };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    jobLogger.error({ error }, 'ASN create-player job failed');

    try {
      await page.screenshot({ path: screenshotFailurePath, fullPage: true });
      artifactPaths.push(screenshotFailurePath);
    } catch {
      jobLogger.warn('Could not capture ASN create-player failure screenshot');
    }

    if (tracingStarted) {
      try {
        await context.tracing.stop({ path: traceFailurePath });
        artifactPaths.push(traceFailurePath);
      } catch {
        jobLogger.warn('Could not persist ASN create-player failure trace');
      }
    }

    await waitBeforeCloseIfHeaded(page, runtimeConfig.headless, runtimeConfig.debug).catch(() => undefined);
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);

    const wrapped = new Error(message);
    (wrapped as Error & { steps?: JobStepResult[]; artifactPaths?: string[] }).steps = steps;
    (wrapped as Error & { steps?: JobStepResult[]; artifactPaths?: string[] }).artifactPaths = artifactPaths;
    throw wrapped;
  }
}
