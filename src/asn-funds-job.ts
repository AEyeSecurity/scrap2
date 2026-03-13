
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { chromium, type Locator, type Page } from 'playwright';
import type { Logger } from 'pino';
import { toFriendlyAsnUserError } from './asn-user-error';
import { ensureAuthenticated } from './auth';
import { configureContext } from './browser';
import { resolveSiteAppConfig } from './site-profile';
import type {
  AppConfig,
  AsnBalanceJobResult,
  AsnFundsOperationResult,
  BalanceJobRequest,
  DepositJobRequest,
  FundsTransactionOperation,
  JobExecutionResult,
  JobStepResult
} from './types';

interface AsnBalanceSnapshot {
  saldoTexto: string;
  saldoNumero: number;
}

interface AsnActionOutcome {
  promptDialogsHandled: number;
  usedDomAmountFallback: boolean;
}

const ASN_MONEY_TOKEN_REGEX = /-?\d{1,3}(?:\.\d{3})*,\d{2}|-?\d+,\d{2}|-?\d+(?:\.\d+)?/;
const ASN_UI_ERROR_REGEX = /saldo insuficiente|error|fall[oó]|invalido|inv[aá]lido|no se pudo|rechazad|denegad/i;

function sanitizeFileName(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
}

function parseEnvBoolean(input: string | undefined): boolean | undefined {
  if (input == null) {
    return undefined;
  }

  const normalized = input.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }

  return undefined;
}

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function roundToTwoDecimals(value: number): number {
  return Math.round(value * 100) / 100;
}

export function parseAsnMoney(rawValue: string): number {
  const compact = rawValue.trim().replace(/\s+/g, '').replace(/[^0-9,.-]/g, '');
  if (!/[0-9]/.test(compact)) {
    throw new Error(`Could not parse ASN money value "${rawValue}"`);
  }

  const sign = compact.startsWith('-') ? '-' : '';
  const unsigned = compact.replace(/-/g, '');
  let normalized: string;

  if (unsigned.includes(',') && unsigned.includes('.')) {
    if (unsigned.lastIndexOf(',') > unsigned.lastIndexOf('.')) {
      normalized = unsigned.replace(/\./g, '').replace(/,/g, '.');
    } else {
      normalized = unsigned.replace(/,/g, '');
    }
  } else if (unsigned.includes(',')) {
    const parts = unsigned.split(',');
    const decimalPart = parts.pop() ?? '';
    const integerPart = parts.join('') || '0';
    normalized = `${integerPart}.${decimalPart}`;
  } else {
    normalized = unsigned;
  }

  const parsed = Number(`${sign}${normalized}`);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Could not parse ASN money value "${rawValue}"`);
  }

  return parsed;
}

function formatAsnMoney(value: number): string {
  return new Intl.NumberFormat('es-AR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(roundToTwoDecimals(value));
}

function extractFirstMoneyToken(text: string): string | null {
  const normalized = normalizeSpaces(text);
  const match = normalized.match(ASN_MONEY_TOKEN_REGEX);
  return match?.[0] ?? null;
}

function extractBalanceTokenNearLabel(text: string): string | null {
  const normalized = normalizeSpaces(text);
  const labelMatch = normalized.match(
    /saldo disponible actual[^0-9-]*(-?\d{1,3}(?:\.\d{3})*,\d{2}|-?\d+,\d{2}|-?\d+(?:\.\d+)?)/i
  );
  if (labelMatch?.[1]) {
    return labelMatch[1];
  }

  const withdrawViewMatch = normalized.match(
    /\bjugador\b.{0,140}?\bdisponible\b[^0-9-]*(-?\d{1,3}(?:\.\d{3})*,\d{2}|-?\d+,\d{2}|-?\d+(?:\.\d+)?)/i
  );
  if (withdrawViewMatch?.[1]) {
    return withdrawViewMatch[1];
  }

  const directDisponibleMatch = normalized.match(
    /\bdisponible\s*:[^0-9-]*(-?\d{1,3}(?:\.\d{3})*,\d{2}|-?\d+,\d{2}|-?\d+(?:\.\d+)?)/i
  );
  if (directDisponibleMatch?.[1]) {
    return directDisponibleMatch[1];
  }

  if (/saldo disponible actual/i.test(normalized)) {
    return extractFirstMoneyToken(normalized);
  }

  return null;
}

function extractTransferBalanceTokenNearLabel(text: string): string | null {
  const normalized = normalizeSpaces(text);
  const transferLabelMatch = normalized.match(
    /saldo disponible para transferir.{0,120}?fichas\s*:\s*(-?\d{1,3}(?:\.\d{3})*,\d{2}|-?\d+,\d{2}|-?\d+(?:\.\d+)?)/i
  );
  if (transferLabelMatch?.[1]) {
    return transferLabelMatch[1];
  }

  const directFichasMatch = normalized.match(
    /(?:^|\b)fichas\s*:\s*(-?\d{1,3}(?:\.\d{3})*,\d{2}|-?\d+,\d{2}|-?\d+(?:\.\d+)?)/i
  );
  if (directFichasMatch?.[1]) {
    return directFichasMatch[1];
  }

  return null;
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

async function findFirstVisibleLocator(page: Page, selector: string, timeoutMs: number): Promise<Locator> {
  const startedAt = Date.now();
  const locator = page.locator(selector);

  while (Date.now() - startedAt < timeoutMs) {
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const candidate = locator.nth(i);
      if (await candidate.isVisible().catch(() => false)) {
        return candidate;
      }
    }

    await page.waitForTimeout(100);
  }

  throw new Error(`No visible element found for selector: ${selector}`);
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

async function handleAsnContinueIfPresent(page: Page, timeoutMs: number): Promise<'ok' | 'skipped'> {
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

async function tryReadAsnAvailableBalance(page: Page): Promise<AsnBalanceSnapshot | null> {
  const selectors = [
    'xpath=//*[contains(translate(normalize-space(.), "SALDO DISPONIBLE ACTUAL", "saldo disponible actual"), "saldo disponible actual")]/ancestor::*[self::div or self::table or self::td][1]',
    'xpath=//*[contains(translate(normalize-space(.), "SALDO DISPONIBLE ACTUAL", "saldo disponible actual"), "saldo disponible actual")]/following::*[self::div or self::span or self::strong][1]',
    'body'
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const visible = selector === 'body' ? true : await locator.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }

    const text = normalizeSpaces(await locator.innerText().catch(() => ''));
    if (!text) {
      continue;
    }

    const token = extractBalanceTokenNearLabel(text);
    if (!token) {
      continue;
    }

    return {
      saldoTexto: token,
      saldoNumero: parseAsnMoney(token)
    };
  }

  return null;
}

async function readAsnAvailableBalance(page: Page, timeoutMs: number): Promise<AsnBalanceSnapshot> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const balance = await tryReadAsnAvailableBalance(page);
    if (balance) {
      return balance;
    }

    await page.waitForTimeout(120);
  }

  throw new Error('Could not read ASN "Saldo disponible actual"');
}

async function tryReadAsnTransferBalance(page: Page): Promise<AsnBalanceSnapshot | null> {
  const locator = page.locator('body').first();
  const text = normalizeSpaces(await locator.innerText().catch(() => ''));
  if (!text) {
    return null;
  }

  const token = extractTransferBalanceTokenNearLabel(text);
  if (!token) {
    return null;
  }

  return {
    saldoTexto: token,
    saldoNumero: parseAsnMoney(token)
  };
}

async function readAsnTransferBalance(page: Page, timeoutMs: number): Promise<AsnBalanceSnapshot> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const balance = await tryReadAsnTransferBalance(page);
    if (balance) {
      return balance;
    }

    await page.waitForTimeout(120);
  }

  throw new Error('Could not read ASN transfer balance ("Fichas")');
}
function getAsnActionSelectors(operation: FundsTransactionOperation): string[] {
  if (operation === 'carga') {
    return [
      'button:has-text("Cargar saldo")',
      'a:has-text("Cargar saldo")',
      'input[type="button"][value*="Cargar" i]',
      'input[type="submit"][value*="Cargar" i]',
      'img[alt*="Cargar" i]',
      'img[title*="Cargar" i]',
      'img[src*="cargar" i]',
      '[onclick*="cargar" i]'
    ];
  }

  return [
    'button:has-text("Descargar saldo")',
    'a:has-text("Descargar saldo")',
    'input[type="button"][value*="Descargar" i]',
    'input[type="submit"][value*="Descargar" i]',
    'img[alt*="Descargar" i]',
    'img[title*="Descargar" i]',
    'img[src*="descargar" i]',
    '[onclick*="descargar" i]',
    '[onclick*="retirar" i]'
  ];
}

function buildAmountForSubmit(monto: number): string {
  const rounded = roundToTwoDecimals(monto);
  if (Math.abs(rounded % 1) < 0.00001) {
    return String(Math.trunc(rounded));
  }

  return rounded.toFixed(2);
}

function isSearchField(nameOrId: string): boolean {
  return /buscar/i.test(nameOrId);
}

async function trySubmitAsnAmountInDom(
  page: Page,
  operation: FundsTransactionOperation,
  monto: number,
  timeoutMs: number
): Promise<boolean> {
  const amountValue = buildAmountForSubmit(monto);
  const inputSelectors = [
    '.swal2-input',
    '[role="dialog"] input[type="text"]',
    '[role="dialog"] input[type="number"]',
    '.modal input[type="text"]',
    '.modal input[type="number"]',
    'input[name*="monto" i]',
    'input[id*="monto" i]',
    'input[name*="cantidad" i]',
    'input[id*="cantidad" i]',
    'input[type="number"]',
    'input[type="text"]'
  ];

  for (const selector of inputSelectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const candidate = locator.nth(i);
      if (!(await candidate.isVisible().catch(() => false))) {
        continue;
      }
      if (await candidate.isDisabled().catch(() => false)) {
        continue;
      }

      const name = (await candidate.getAttribute('name').catch(() => '')) ?? '';
      const id = (await candidate.getAttribute('id').catch(() => '')) ?? '';
      if (isSearchField(name) || isSearchField(id)) {
        continue;
      }

      await candidate.fill('', { timeout: timeoutMs }).catch(() => undefined);
      await candidate.fill(amountValue, { timeout: timeoutMs });

      const confirmSelectors =
        operation === 'carga'
          ? [
              'button:has-text("Cargar")',
              'a:has-text("Cargar")',
              'input[type="button"][value*="Cargar" i]',
              'input[type="submit"][value*="Cargar" i]'
            ]
          : [
              'button:has-text("Descargar")',
              'a:has-text("Descargar")',
              'button:has-text("Retirar")',
              'a:has-text("Retirar")',
              'input[type="button"][value*="Descargar" i]',
              'input[type="submit"][value*="Descargar" i]'
            ];

      const genericConfirmSelectors = [
        '.swal2-confirm',
        'button:has-text("Aceptar")',
        'button:has-text("Confirmar")',
        'input[type="button"][value*="Aceptar" i]',
        'input[type="submit"][value*="Aceptar" i]'
      ];

      const confirm = await findVisibleBySelectors(
        page,
        [...confirmSelectors, ...genericConfirmSelectors],
        Math.min(timeoutMs, 1_000)
      ).catch(() => undefined);

      if (confirm) {
        await clickLocator(confirm, timeoutMs);
      } else {
        await candidate.press('Enter', { timeout: timeoutMs }).catch(() => undefined);
      }

      await page.waitForTimeout(200);
      return true;
    }
  }

  return false;
}

async function readVisibleAsnUiError(page: Page): Promise<string | null> {
  const locator = page.locator('body').getByText(ASN_UI_ERROR_REGEX).first();
  if (await locator.isVisible().catch(() => false)) {
    const text = normalizeSpaces((await locator.innerText().catch(() => '')).trim());
    if (text) {
      return text;
    }
  }

  return null;
}

async function triggerAsnFundsAction(
  page: Page,
  operation: FundsTransactionOperation,
  monto: number,
  timeoutMs: number
): Promise<AsnActionOutcome> {
  const actionButton = await findVisibleBySelectors(page, getAsnActionSelectors(operation), timeoutMs);
  const amountForSubmit = buildAmountForSubmit(monto);

  let promptDialogsHandled = 0;
  const dialogHandler = async (dialog: { type: () => string; accept: (value?: string) => Promise<void> }): Promise<void> => {
    if (dialog.type() === 'prompt') {
      promptDialogsHandled += 1;
      await dialog.accept(amountForSubmit);
      return;
    }

    await dialog.accept();
  };

  page.on('dialog', dialogHandler);
  try {
    await clickLocator(actionButton, timeoutMs);
    await page.waitForTimeout(250);
  } finally {
    page.off('dialog', dialogHandler);
  }

  const usedDomAmountFallback =
    promptDialogsHandled === 0 ? await trySubmitAsnAmountInDom(page, operation, monto, timeoutMs) : false;

  const uiError = await readVisibleAsnUiError(page);
  if (uiError) {
    throw new Error(`ASN funds operation error: ${uiError}`);
  }

  return {
    promptDialogsHandled,
    usedDomAmountFallback
  };
}

function getAsnFundsFormPath(operation: FundsTransactionOperation, usuario: string): string {
  if (operation === 'carga') {
    return `/NewAdmin/carga-jugador.php?usr=${encodeURIComponent(usuario)}`;
  }

  return `/NewAdmin/descarga-jugador.php?usr=${encodeURIComponent(usuario)}`;
}

export function resolveAsnDepositEntryPath(
  operation: FundsTransactionOperation,
  usuario: string,
  isTurbo: boolean
): string {
  const userPath = `/NewAdmin/JugadoresCD.php?usr=${encodeURIComponent(usuario)}`;
  const fundsPath = getAsnFundsFormPath(operation, usuario);

  if (operation === 'carga' && isTurbo) {
    return fundsPath;
  }

  if (operation === 'descarga' || operation === 'descarga_total') {
    return fundsPath;
  }

  return userPath;
}

function amountToAsnInputString(monto: number): string {
  const rounded = roundToTwoDecimals(monto);
  if (Math.abs(rounded % 1) < 0.00001) {
    return String(Math.trunc(rounded));
  }
  return rounded.toFixed(2).replace('.', ',');
}

async function submitAsnFundsForm(
  page: Page,
  operation: FundsTransactionOperation,
  usuario: string,
  monto: number,
  timeoutMs: number
): Promise<void> {
  const formPath = getAsnFundsFormPath(operation, usuario);
  await page.goto(formPath, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

  const amountAsText = amountToAsnInputString(monto);
  const amountInput = await findVisibleBySelectors(page, ['input#importe', 'input[name="importe"]'], timeoutMs);
  await amountInput.click({ timeout: timeoutMs });
  await amountInput.press('Control+A', { timeout: timeoutMs }).catch(() => undefined);
  await amountInput.press('Backspace', { timeout: timeoutMs }).catch(() => undefined);
  await amountInput.pressSequentially(amountAsText, { timeout: timeoutMs, delay: 40 });
  await amountInput.press('Tab', { timeout: timeoutMs }).catch(() => undefined);

  const submitButton = await findVisibleBySelectors(
    page,
    ['input[type="image"]', 'input[type="submit"]', 'button[type="submit"]', 'button:has-text("Aceptar")'],
    timeoutMs
  );

  await Promise.all([
    page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => undefined),
    clickLocator(submitButton, timeoutMs)
  ]);

  const uiError = await readVisibleAsnUiError(page);
  if (uiError) {
    throw new Error(`ASN funds operation error: ${uiError}`);
  }
}

export function resolveAsnRequestedAmount(
  operation: FundsTransactionOperation,
  saldoAntesNumero: number,
  cantidad?: number
): number {
  if (operation === 'descarga_total') {
    return roundToTwoDecimals(Math.max(saldoAntesNumero, 0));
  }

  if (typeof cantidad !== 'number' || !Number.isFinite(cantidad) || cantidad <= 0) {
    throw new Error(`cantidad is required for "${operation}" operation`);
  }

  return roundToTwoDecimals(cantidad);
}

export function computeExpectedAsnBalance(
  operation: FundsTransactionOperation,
  saldoAntesNumero: number,
  montoAplicado: number
): number {
  if (operation === 'carga') {
    return roundToTwoDecimals(saldoAntesNumero + montoAplicado);
  }

  if (operation === 'descarga') {
    return roundToTwoDecimals(saldoAntesNumero - montoAplicado);
  }

  return 0;
}

function computeExpectedAsnTransferBalance(saldoAntesNumero: number, montoAplicado: number): number {
  return roundToTwoDecimals(saldoAntesNumero - montoAplicado);
}

export function computeAsnAppliedAmount(
  operation: FundsTransactionOperation,
  saldoAntesNumero: number,
  saldoDespuesNumero: number
): number {
  if (operation === 'carga') {
    return roundToTwoDecimals(saldoDespuesNumero - saldoAntesNumero);
  }

  return roundToTwoDecimals(saldoAntesNumero - saldoDespuesNumero);
}

function computeAsnTransferAppliedAmount(saldoAntesNumero: number, saldoDespuesNumero: number): number {
  return roundToTwoDecimals(saldoAntesNumero - saldoDespuesNumero);
}

export function isExpectedAsnTransferDelta(
  saldoAntesNumero: number,
  saldoDespuesNumero: number,
  montoEsperado: number,
  tolerance = 0.01
): boolean {
  const appliedAmount = computeAsnTransferAppliedAmount(saldoAntesNumero, saldoDespuesNumero);
  if (appliedAmount < -tolerance) {
    return false;
  }

  return appliedAmount + tolerance >= montoEsperado;
}

export function isExpectedAsnDelta(
  operation: FundsTransactionOperation,
  saldoAntesNumero: number,
  saldoDespuesNumero: number,
  montoEsperado: number,
  tolerance = 0.01
): boolean {
  const expectedBalance = computeExpectedAsnBalance(operation, saldoAntesNumero, montoEsperado);
  if (Math.abs(saldoDespuesNumero - expectedBalance) <= tolerance) {
    return true;
  }

  if (operation === 'descarga_total' && Math.abs(saldoDespuesNumero) <= tolerance) {
    return true;
  }

  return false;
}

async function waitForExpectedAsnBalance(
  page: Page,
  targetBalance: number,
  timeoutMs: number,
  refreshPath: string
): Promise<AsnBalanceSnapshot> {
  const startedAt = Date.now();
  let lastSnapshot: AsnBalanceSnapshot | null = null;
  let refreshed = false;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const snapshot = await readAsnAvailableBalance(page, Math.min(timeoutMs, 1_200));
      lastSnapshot = snapshot;
      if (Math.abs(snapshot.saldoNumero - targetBalance) <= 0.01) {
        return snapshot;
      }
    } catch {
      // Keep polling.
    }

    if (!refreshed && Date.now() - startedAt > timeoutMs / 2) {
      await page.goto(refreshPath, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => undefined);
      refreshed = true;
    }

    await page.waitForTimeout(150);
  }

  if (lastSnapshot) {
    throw new Error(
      `ASN balance did not reach expected value ${formatAsnMoney(targetBalance)} (last=${lastSnapshot.saldoTexto})`
    );
  }

  throw new Error(`ASN balance did not reach expected value ${formatAsnMoney(targetBalance)}`);
}

async function waitForExpectedAsnTransferBalance(
  page: Page,
  targetBalance: number,
  timeoutMs: number,
  refreshPath: string
): Promise<AsnBalanceSnapshot> {
  const startedAt = Date.now();
  let lastSnapshot: AsnBalanceSnapshot | null = null;
  let refreshed = false;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const snapshot = await readAsnTransferBalance(page, Math.min(timeoutMs, 1_200));
      lastSnapshot = snapshot;
      if (snapshot.saldoNumero <= targetBalance + 0.01) {
        return snapshot;
      }
    } catch {
      // Keep polling.
    }

    if (!refreshed && Date.now() - startedAt > timeoutMs / 2) {
      await page.goto(refreshPath, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => undefined);
      refreshed = true;
    }

    await page.waitForTimeout(150);
  }

  if (lastSnapshot) {
    throw new Error(
      `ASN transfer balance did not reach expected value ${formatAsnMoney(targetBalance)} (last=${lastSnapshot.saldoTexto})`
    );
  }

  throw new Error(`ASN transfer balance did not reach expected value ${formatAsnMoney(targetBalance)}`);
}

function isNavigationAbortedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ERR_ABORTED/i.test(message);
}

async function gotoWithRetry(page: Page, path: string, timeoutMs: number): Promise<void> {
  const attempts = 2;
  let lastError: unknown = null;

  for (let i = 0; i < attempts; i += 1) {
    try {
      await page.goto(path, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      return;
    } catch (error) {
      lastError = error;
      if (!isNavigationAbortedError(error) || i === attempts - 1) {
        throw error;
      }

      await page.waitForLoadState('domcontentloaded', { timeout: Math.min(timeoutMs, 1_500) }).catch(() => undefined);
      await page.waitForTimeout(200);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function buildRuntimeConfig(
  baseConfig: AppConfig,
  requestOptions: DepositJobRequest['options'] | BalanceJobRequest['options']
): AppConfig {
  return {
    ...baseConfig,
    headless: requestOptions.headless,
    debug: requestOptions.debug,
    slowMo: requestOptions.slowMo,
    timeoutMs: requestOptions.timeoutMs,
    blockResources: false
  };
}
async function runAsnSessionSteps<T>(params: {
  appConfig: AppConfig;
  requestId: string;
  logger: Logger;
  credentials: { username: string; password: string };
  captureSuccessArtifacts: boolean;
  onRun: (context: {
    page: Page;
    runtimeConfig: AppConfig;
    artifactDir: string;
    artifactPaths: string[];
    steps: JobStepResult[];
    isTurbo: boolean;
  }) => Promise<T>;
}): Promise<JobExecutionResult & { payload: T }> {
  const { appConfig, requestId, logger, credentials, captureSuccessArtifacts, onRun } = params;
  const artifactDir = path.join(appConfig.artifactsDir, 'jobs', requestId);
  const artifactPaths: string[] = [];
  const steps: JobStepResult[] = [];
  const tracePath = path.join(artifactDir, 'trace.zip');
  const traceFailurePath = path.join(artifactDir, 'trace-failure.zip');
  const screenshotFailurePath = path.join(artifactDir, 'error.png');

  await fs.mkdir(artifactDir, { recursive: true });

  const browser = await chromium.launch({
    headless: appConfig.headless,
    slowMo: appConfig.slowMo,
    args: appConfig.headless ? undefined : ['--start-maximized']
  });
  const context = await browser.newContext({
    baseURL: appConfig.baseUrl,
    viewport: appConfig.headless ? { width: 1920, height: 1080 } : null,
    recordVideo: appConfig.debug ? { dir: path.join(artifactDir, 'video') } : undefined
  });
  await configureContext(context, appConfig, logger);

  const page = await context.newPage();
  let tracingStarted = false;

  try {
    if (appConfig.debug) {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      tracingStarted = true;
    }

    const loginStartedAt = new Date().toISOString();
    await ensureAuthenticated(context, page, appConfig, credentials, logger, { persistSession: false });
    const loginArtifact = captureSuccessArtifacts ? await captureStepScreenshot(page, artifactDir, '00-login') : undefined;
    if (loginArtifact) {
      artifactPaths.push(loginArtifact);
    }
    steps.push({
      name: '00-login',
      status: 'ok',
      startedAt: loginStartedAt,
      finishedAt: new Date().toISOString(),
      ...(loginArtifact ? { artifactPath: loginArtifact } : {})
    });

    const continueStartedAt = new Date().toISOString();
    try {
      const continueResult = await handleAsnContinueIfPresent(
        page,
        !appConfig.debug && appConfig.slowMo === 0 ? 900 : Math.min(appConfig.timeoutMs, 3_000)
      );
      steps.push({
        name: '01b-continue-intermediate',
        status: continueResult === 'ok' ? 'ok' : 'skipped',
        startedAt: continueStartedAt,
        finishedAt: new Date().toISOString()
      });
    } catch (error) {
      steps.push({
        name: '01b-continue-intermediate',
        status: 'failed',
        startedAt: continueStartedAt,
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }

    const payload = await onRun({
      page,
      runtimeConfig: appConfig,
      artifactDir,
      artifactPaths,
      steps,
      isTurbo: !appConfig.debug && appConfig.slowMo === 0
    });

    if (tracingStarted) {
      await context.tracing.stop({ path: tracePath });
      artifactPaths.push(tracePath);
      tracingStarted = false;
    }

    await waitBeforeCloseIfHeaded(page, appConfig.headless, appConfig.debug);
    await context.close();
    await browser.close();

    return {
      artifactPaths,
      steps,
      payload
    };
  } catch (error) {
    logger.error({ error }, 'ASN funds flow failed');

    try {
      await page.screenshot({ path: screenshotFailurePath, fullPage: true });
      artifactPaths.push(screenshotFailurePath);
    } catch {
      logger.warn('Could not capture ASN funds failure screenshot');
    }

    if (tracingStarted) {
      try {
        await context.tracing.stop({ path: traceFailurePath });
        artifactPaths.push(traceFailurePath);
      } catch {
        logger.warn('Could not persist ASN funds failure trace');
      }
    }

    await waitBeforeCloseIfHeaded(page, appConfig.headless, appConfig.debug).catch(() => undefined);
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);

    const wrapped = new Error(error instanceof Error ? error.message : String(error));
    (wrapped as Error & { steps?: JobStepResult[]; artifactPaths?: string[] }).steps = steps;
    (wrapped as Error & { steps?: JobStepResult[]; artifactPaths?: string[] }).artifactPaths = artifactPaths;
    throw wrapped;
  }
}

export async function runAsnDepositJob(
  request: DepositJobRequest,
  appConfig: AppConfig,
  logger: Logger
): Promise<JobExecutionResult> {
  if (request.payload.pagina !== 'ASN') {
    throw new Error('runAsnDepositJob only supports pagina=ASN');
  }

  const siteConfig = resolveSiteAppConfig(appConfig, 'ASN');
  const runtimeConfig = buildRuntimeConfig(siteConfig, request.options);
  const jobLogger = logger.child({
    jobId: request.id,
    jobType: request.jobType,
    pagina: request.payload.pagina,
    operacion: request.payload.operacion
  });
  const captureSuccessArtifacts = parseEnvBoolean(process.env.ASN_FUNDS_CAPTURE_SUCCESS_ARTIFACTS) ?? false;

  try {
    const runResult = await runAsnSessionSteps({
      appConfig: runtimeConfig,
      requestId: request.id,
      logger: jobLogger,
      credentials: {
        username: request.payload.agente,
        password: request.payload.contrasena_agente
      },
      captureSuccessArtifacts,
      onRun: async ({ page, runtimeConfig: cfg, artifactDir, artifactPaths, steps, isTurbo }) => {
        const userPath = `/NewAdmin/JugadoresCD.php?usr=${encodeURIComponent(request.payload.usuario)}`;
        const withdrawPath = `/NewAdmin/descarga-jugador.php?usr=${encodeURIComponent(request.payload.usuario)}`;
        const entryPath = resolveAsnDepositEntryPath(request.payload.operacion, request.payload.usuario, isTurbo);
        const isWithdrawOperation =
          request.payload.operacion === 'descarga' || request.payload.operacion === 'descarga_total';
        const useTransferBalanceValidation = request.payload.operacion === 'carga';

        const gotoStep = await executeActionStep(
          page,
          artifactDir,
          '02-goto-user-cd',
          async () => {
            await page.goto(entryPath, { waitUntil: 'domcontentloaded', timeout: cfg.timeoutMs });
            if (isWithdrawOperation) {
              await findFirstVisibleLocator(page, 'text=/Descarga|Disponible\\s*:|Jugador\\s*:/i', cfg.timeoutMs);
              return;
            }

            await findVisibleBySelectors(
              page,
              [
                'input#importe',
                'input[name="importe"]',
                'input[type="image"]',
                'input[type="submit"]',
                'button[type="submit"]',
                'text=/Saldo\\s+disponible\\s+actual|Cargar\\s+Saldo|Descargar\\s+Saldo|Importe\\s*:|Cargar/i'
              ],
              cfg.timeoutMs
            );
          },
          captureSuccessArtifacts
        );
        if (gotoStep.artifactPath) {
          artifactPaths.push(gotoStep.artifactPath);
        }
        steps.push(gotoStep);
        if (gotoStep.status === 'failed') {
          throw new Error(`Step failed: ${gotoStep.name} (${gotoStep.error ?? 'unknown error'})`);
        }

        let saldoAntes: AsnBalanceSnapshot | undefined;
        const readBeforeStep = await executeActionStep(
          page,
          artifactDir,
          '03-read-saldo-before',
          async () => {
            if (request.payload.operacion === 'carga' && isTurbo) {
              await gotoWithRetry(page, userPath, cfg.timeoutMs);
            }
            saldoAntes = useTransferBalanceValidation
              ? await readAsnTransferBalance(page, Math.min(cfg.timeoutMs, isTurbo ? 3_500 : 7_500))
              : await readAsnAvailableBalance(page, Math.min(cfg.timeoutMs, isTurbo ? 3_500 : 7_500));
          },
          captureSuccessArtifacts
        );
        if (readBeforeStep.artifactPath) {
          artifactPaths.push(readBeforeStep.artifactPath);
        }
        steps.push(readBeforeStep);
        if (readBeforeStep.status === 'failed') {
          throw new Error(`Step failed: ${readBeforeStep.name} (${readBeforeStep.error ?? 'unknown error'})`);
        }

        if (!saldoAntes) {
          throw new Error('ASN balance before operation was not captured');
        }

        let montoSolicitado = 0;
        const resolveAmountStep = await executeActionStep(
          page,
          artifactDir,
          '04-resolve-amount',
          async () => {
            montoSolicitado = resolveAsnRequestedAmount(
              request.payload.operacion,
              saldoAntes?.saldoNumero ?? 0,
              request.payload.cantidad
            );
          },
          captureSuccessArtifacts
        );
        if (resolveAmountStep.artifactPath) {
          artifactPaths.push(resolveAmountStep.artifactPath);
        }
        steps.push(resolveAmountStep);
        if (resolveAmountStep.status === 'failed') {
          throw new Error(`Step failed: ${resolveAmountStep.name} (${resolveAmountStep.error ?? 'unknown error'})`);
        }

        if (request.payload.operacion === 'descarga_total' && montoSolicitado <= 0.01) {
          steps.push({
            name: '05-apply-operation',
            status: 'skipped',
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            error: 'descarga_total skipped because available balance is zero'
          });
        } else {
          const applyStep = await executeActionStep(
            page,
            artifactDir,
            '05-apply-operation',
            async () => {
              await submitAsnFundsForm(
                page,
                request.payload.operacion,
                request.payload.usuario,
                montoSolicitado,
                cfg.timeoutMs
              );
            },
            captureSuccessArtifacts
          );
          if (applyStep.artifactPath) {
            artifactPaths.push(applyStep.artifactPath);
          }
          steps.push(applyStep);
          if (applyStep.status === 'failed') {
            throw new Error(`Step failed: ${applyStep.name} (${applyStep.error ?? 'unknown error'})`);
          }
        }

        let saldoDespues: AsnBalanceSnapshot | undefined;
        const expectedBalance = useTransferBalanceValidation
          ? computeExpectedAsnTransferBalance(saldoAntes.saldoNumero, montoSolicitado)
          : computeExpectedAsnBalance(request.payload.operacion, saldoAntes.saldoNumero, montoSolicitado);
        const refreshPath = isWithdrawOperation ? withdrawPath : userPath;
        const readAfterStep = await executeActionStep(
          page,
          artifactDir,
          '06-read-saldo-after',
          async () => {
            if (request.payload.operacion === 'descarga_total' && montoSolicitado <= 0.01) {
              saldoDespues = saldoAntes;
              return;
            }

            if (request.payload.operacion === 'carga' && isTurbo) {
              await gotoWithRetry(page, userPath, cfg.timeoutMs);
            }

            saldoDespues = useTransferBalanceValidation
              ? await waitForExpectedAsnTransferBalance(
                  page,
                  expectedBalance,
                  isTurbo ? Math.min(cfg.timeoutMs, 4_500) : Math.min(cfg.timeoutMs, 8_500),
                  refreshPath
                )
              : await waitForExpectedAsnBalance(
                  page,
                  expectedBalance,
                  isTurbo ? Math.min(cfg.timeoutMs, 4_500) : Math.min(cfg.timeoutMs, 8_500),
                  refreshPath
                );
          },
          captureSuccessArtifacts
        );
        if (readAfterStep.artifactPath) {
          artifactPaths.push(readAfterStep.artifactPath);
        }
        steps.push(readAfterStep);
        if (readAfterStep.status === 'failed') {
          throw new Error(`Step failed: ${readAfterStep.name} (${readAfterStep.error ?? 'unknown error'})`);
        }

        if (!saldoDespues) {
          throw new Error('ASN balance after operation was not captured');
        }

        const verifyStep = await executeActionStep(
          page,
          artifactDir,
          '07-verify-delta',
          async () => {
            const appliedAmount = useTransferBalanceValidation
              ? computeAsnTransferAppliedAmount(saldoAntes?.saldoNumero ?? 0, saldoDespues?.saldoNumero ?? 0)
              : computeAsnAppliedAmount(
                  request.payload.operacion,
                  saldoAntes?.saldoNumero ?? 0,
                  saldoDespues?.saldoNumero ?? 0
                );
            const appliedDeltaMatches = useTransferBalanceValidation
              ? appliedAmount >= -0.01
              : Math.abs(appliedAmount - montoSolicitado) <= 0.01;
            const expectedDeltaMatches = useTransferBalanceValidation
              ? isExpectedAsnTransferDelta(
                  saldoAntes?.saldoNumero ?? 0,
                  saldoDespues?.saldoNumero ?? 0,
                  montoSolicitado,
                  0.01
                )
              : isExpectedAsnDelta(
                  request.payload.operacion,
                  saldoAntes?.saldoNumero ?? 0,
                  saldoDespues?.saldoNumero ?? 0,
                  montoSolicitado,
                  0.01
                );
            if (!appliedDeltaMatches || !expectedDeltaMatches) {
              throw new Error(
                `Unexpected ASN balance delta: operacion=${request.payload.operacion}, saldoAntes=${saldoAntes?.saldoTexto}, saldoDespues=${saldoDespues?.saldoTexto}, montoSolicitado=${montoSolicitado}`
              );
            }
          },
          captureSuccessArtifacts
        );
        if (verifyStep.artifactPath) {
          artifactPaths.push(verifyStep.artifactPath);
        }
        steps.push(verifyStep);
        if (verifyStep.status === 'failed') {
          throw new Error(`Step failed: ${verifyStep.name} (${verifyStep.error ?? 'unknown error'})`);
        }

        const montoAplicado = computeAsnAppliedAmount(
          request.payload.operacion,
          saldoAntes.saldoNumero,
          saldoDespues.saldoNumero
        );
        let montoAplicadoFinal = montoAplicado;
        if (useTransferBalanceValidation) {
          const transferAppliedAmount = computeAsnTransferAppliedAmount(saldoAntes.saldoNumero, saldoDespues.saldoNumero);
          if (transferAppliedAmount - montoSolicitado > 0.01) {
            jobLogger.warn(
              {
                operacion: request.payload.operacion,
                usuario: request.payload.usuario,
                montoSolicitado,
                transferAppliedAmount,
                saldoAntes: saldoAntes.saldoNumero,
                saldoDespues: saldoDespues.saldoNumero
              },
              'ASN transfer balance moved more than requested; clamping applied amount to requested amount'
            );
          }

          montoAplicadoFinal = roundToTwoDecimals(Math.min(transferAppliedAmount, montoSolicitado));
        }

        const resultPayload: AsnFundsOperationResult = {
          kind: 'asn-funds-operation',
          pagina: 'ASN',
          operacion: request.payload.operacion,
          usuario: request.payload.usuario,
          montoSolicitado: roundToTwoDecimals(montoSolicitado),
          montoAplicado: roundToTwoDecimals(montoAplicadoFinal),
          montoAplicadoTexto: formatAsnMoney(montoAplicadoFinal),
          saldoAntesNumero: roundToTwoDecimals(saldoAntes.saldoNumero),
          saldoAntesTexto: saldoAntes.saldoTexto,
          saldoDespuesNumero: roundToTwoDecimals(saldoDespues.saldoNumero),
          saldoDespuesTexto: saldoDespues.saldoTexto
        };

        steps.push({
          name: '99-final',
          status: 'ok',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString()
        });

        return resultPayload;
      }
    });

    return {
      artifactPaths: runResult.artifactPaths,
      steps: runResult.steps,
      result: runResult.payload
    };
  } catch (error) {
    const friendlyError = toFriendlyAsnUserError(request.payload.usuario, error);
    if (!friendlyError) {
      throw error;
    }

    const wrapped = new Error(friendlyError.message, {
      cause: friendlyError.cause ?? (error instanceof Error ? error : undefined)
    });
    (wrapped as Error & { steps?: JobStepResult[]; artifactPaths?: string[] }).steps = (error as Error & { steps?: JobStepResult[] }).steps;
    (wrapped as Error & { steps?: JobStepResult[]; artifactPaths?: string[] }).artifactPaths =
      (error as Error & { artifactPaths?: string[] }).artifactPaths;
    throw wrapped;
  }
}
export async function runAsnBalanceJob(
  request: BalanceJobRequest,
  appConfig: AppConfig,
  logger: Logger
): Promise<JobExecutionResult> {
  if (request.payload.pagina !== 'ASN') {
    throw new Error('runAsnBalanceJob only supports pagina=ASN');
  }

  const siteConfig = resolveSiteAppConfig(appConfig, 'ASN');
  const runtimeConfig = buildRuntimeConfig(siteConfig, request.options);
  const jobLogger = logger.child({
    jobId: request.id,
    jobType: request.jobType,
    pagina: request.payload.pagina,
    operacion: request.payload.operacion
  });
  const captureSuccessArtifacts = parseEnvBoolean(process.env.ASN_BALANCE_CAPTURE_SUCCESS_ARTIFACTS) ?? false;

  try {
    const runResult = await runAsnSessionSteps({
      appConfig: runtimeConfig,
      requestId: request.id,
      logger: jobLogger,
      credentials: {
        username: request.payload.agente,
        password: request.payload.contrasena_agente
      },
      captureSuccessArtifacts,
      onRun: async ({ page, runtimeConfig: cfg, artifactDir, artifactPaths, steps }) => {
        const userPath = `/NewAdmin/JugadoresCD.php?usr=${encodeURIComponent(request.payload.usuario)}`;
        const gotoStep = await executeActionStep(
          page,
          artifactDir,
          '02-goto-user-cd',
          async () => {
            await gotoWithRetry(page, userPath, cfg.timeoutMs);
            await findFirstVisibleLocator(page, 'text=/Saldo\\s+disponible\\s+actual/i', cfg.timeoutMs);
          },
          captureSuccessArtifacts
        );
        if (gotoStep.artifactPath) {
          artifactPaths.push(gotoStep.artifactPath);
        }
        steps.push(gotoStep);
        if (gotoStep.status === 'failed') {
          throw new Error(`Step failed: ${gotoStep.name} (${gotoStep.error ?? 'unknown error'})`);
        }

        let balance: AsnBalanceSnapshot | undefined;
        const readStep = await executeActionStep(
          page,
          artifactDir,
          '03-read-saldo',
          async () => {
            balance = await readAsnAvailableBalance(page, Math.min(cfg.timeoutMs, 6_000));
          },
          captureSuccessArtifacts
        );
        if (readStep.artifactPath) {
          artifactPaths.push(readStep.artifactPath);
        }
        steps.push(readStep);
        if (readStep.status === 'failed') {
          throw new Error(`Step failed: ${readStep.name} (${readStep.error ?? 'unknown error'})`);
        }

        if (!balance) {
          throw new Error('ASN balance was not captured');
        }

        const resultPayload: AsnBalanceJobResult = {
          kind: 'asn-balance',
          pagina: 'ASN',
          operacion: 'consultar_saldo',
          usuario: request.payload.usuario,
          saldoTexto: balance.saldoTexto,
          saldoNumero: roundToTwoDecimals(balance.saldoNumero)
        };

        steps.push({
          name: '99-final',
          status: 'ok',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString()
        });

        return resultPayload;
      }
    });

    return {
      artifactPaths: runResult.artifactPaths,
      steps: runResult.steps,
      result: runResult.payload
    };
  } catch (error) {
    const friendlyError = toFriendlyAsnUserError(request.payload.usuario, error);
    if (!friendlyError) {
      throw error;
    }

    const wrapped = new Error(friendlyError.message, {
      cause: friendlyError.cause ?? (error instanceof Error ? error : undefined)
    });
    (wrapped as Error & { steps?: JobStepResult[]; artifactPaths?: string[] }).steps = (error as Error & { steps?: JobStepResult[] }).steps;
    (wrapped as Error & { steps?: JobStepResult[]; artifactPaths?: string[] }).artifactPaths =
      (error as Error & { artifactPaths?: string[] }).artifactPaths;
    throw wrapped;
  }
}
