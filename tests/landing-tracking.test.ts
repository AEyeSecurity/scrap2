import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const landingScript = readFileSync(resolve(process.cwd(), 'public/landing/landing.js'), 'utf8');

interface LandingHarnessOptions {
  pixelId?: string | null;
  pixelThrows?: boolean;
  search?: string;
  referrer?: string;
  cookies?: Record<string, string>;
}

interface SentRequest {
  method: string;
  url: string;
  body: string;
  headers: Record<string, string>;
}

class FakeXmlHttpRequest {
  readyState = 0;
  status = 0;
  responseText = '';
  timeout = 0;
  onreadystatechange: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onerror: (() => void) | null = null;
  request: SentRequest = { method: '', url: '', body: '', headers: {} };

  constructor(private readonly requests: FakeXmlHttpRequest[]) {
    requests.push(this);
  }

  open(method: string, url: string): void {
    this.request.method = method;
    this.request.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.request.headers[name] = value;
  }

  send(body: string): void {
    this.request.body = body;
  }

  respond(status: number, body: unknown): void {
    this.status = status;
    this.responseText = typeof body === 'string' ? body : JSON.stringify(body);
    this.readyState = 4;
    this.onreadystatechange?.();
  }

  failWithTimeout(): void {
    this.ontimeout?.();
  }
}

function createLandingHarness(options: LandingHarnessOptions = {}) {
  const cookies = new Map(Object.entries(options.cookies ?? {}));
  const requests: FakeXmlHttpRequest[] = [];
  const insertedScripts: Array<Record<string, unknown>> = [];
  const elements = {
    status: { hidden: false, innerHTML: '', href: '', onclick: null as (() => void) | null },
    retry: { hidden: false, innerHTML: '', href: '', onclick: null as (() => void) | null },
    'manual-whatsapp': { hidden: false, innerHTML: '', href: '', onclick: null as (() => void) | null }
  };
  const initialHref = `https://landing.reydeases.com/landing${options.search ?? ''}`;
  let currentHref = initialHref;
  const location = {
    search: options.search ?? ''
  } as { search: string; href: string };
  Object.defineProperty(location, 'href', {
    get: () => currentHref,
    set: (value: string) => {
      currentHref = value;
    }
  });

  const document = {
    referrer: options.referrer ?? '',
    getElementById: (id: keyof typeof elements) => elements[id],
    createElement: () => ({}),
    getElementsByTagName: () => [
      {
        parentNode: {
          insertBefore: (script: Record<string, unknown>) => insertedScripts.push(script)
        }
      }
    ]
  } as Record<string, unknown>;
  Object.defineProperty(document, 'cookie', {
    get: () =>
      [...cookies.entries()]
        .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
        .join('; '),
    set: (serialized: string) => {
      const [pair] = serialized.split(';');
      const separator = pair.indexOf('=');
      cookies.set(pair.slice(0, separator), decodeURIComponent(pair.slice(separator + 1)));
    }
  });

  const window = {
    __RDA_LANDING_CONFIG__: {
      pixelId: options.pixelId === undefined ? '1510669717126299' : options.pixelId,
      contactEndpoint: '/landing/contact',
      landingVariant: 'rda-central-auto-v1'
    },
    document,
    location,
    setTimeout,
    clearTimeout
  } as Record<string, unknown>;
  if (options.pixelThrows) {
    window.fbq = () => {
      throw new Error('Pixel blocked');
    };
  }
  window.window = window;

  const context = vm.createContext({
    window,
    document,
    XMLHttpRequest: class extends FakeXmlHttpRequest {
      constructor() {
        super(requests);
      }
    },
    setTimeout,
    clearTimeout,
    Math,
    Date,
    encodeURIComponent,
    decodeURIComponent
  });

  const run = () => vm.runInContext(landingScript, context);
  run();

  return {
    cookies,
    elements,
    initialHref,
    insertedScripts,
    location,
    requests,
    run,
    window,
    pixelCalls: () => {
      const fbq = window.fbq as { queue?: IArguments[] } | undefined;
      return (fbq?.queue ?? []).map((args) => Array.from(args));
    }
  };
}

function successfulContactResponse(url = 'https://wa.me/5493562590932?text=hola') {
  return {
    status: 'ok',
    attributionStatus: 'persisted',
    whatsappUrl: url
  };
}

describe('landing Meta tracking', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('initializes Pixel once and emits one PageView', () => {
    const harness = createLandingHarness({ cookies: { _fbp: 'fb.1.1710000000000.111' } });

    harness.run();

    expect(harness.insertedScripts).toHaveLength(1);
    expect(harness.pixelCalls().filter((call) => call[0] === 'init')).toEqual([
      ['init', '1510669717126299']
    ]);
    expect(harness.pixelCalls().filter((call) => call[0] === 'track' && call[1] === 'PageView')).toHaveLength(1);
  });

  it('waits for _fbp and preserves browser and campaign attribution in the contact payload', async () => {
    const harness = createLandingHarness({
      search:
        '?fbclid=click-123&utm_source=meta&utm_medium=paid_social&utm_id=campaign-1&utm_campaign=Agosto&utm_content=video-1&utm_term=prospecting&adset_id=set-1&ad_id=ad-1&placement=instagram_story',
      referrer: 'https://l.facebook.com/'
    });

    expect(harness.requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(250);
    harness.cookies.set('_fbp', 'fb.1.1710000000000.111');
    await vi.advanceTimersByTimeAsync(50);

    expect(harness.requests).toHaveLength(1);
    const payload = JSON.parse(harness.requests[0].request.body);
    expect(payload).toMatchObject({
      landingVariant: 'rda-central-auto-v1',
      fbp: 'fb.1.1710000000000.111',
      fbclid: 'click-123',
      referrer: 'https://l.facebook.com/',
      utmSource: 'meta',
      utmMedium: 'paid_social',
      utmId: 'campaign-1',
      utmCampaign: 'Agosto',
      utmContent: 'video-1',
      utmTerm: 'prospecting',
      adsetId: 'set-1',
      adId: 'ad-1',
      placement: 'instagram_story'
    });
    expect(payload.eventId).toMatch(/^contact-/);
    expect(payload.landingSessionId).toMatch(/^landing-/);
    expect(payload.fbc).toMatch(/^fb\.1\.\d{13}\.click-123$/);
    expect(harness.cookies.get('_fbc')).toBe(payload.fbc);
  });

  it('starts the contact request after the bounded 500 ms _fbp wait', async () => {
    const harness = createLandingHarness();

    await vi.advanceTimersByTimeAsync(499);
    expect(harness.requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(harness.requests).toHaveLength(1);
    expect(JSON.parse(harness.requests[0].request.body).fbp).toBeNull();
  });

  it('emits Contact only after persistence and redirects 800 ms later with the same event ID', async () => {
    const harness = createLandingHarness({ cookies: { _fbp: 'fb.1.1710000000000.111' } });
    const payload = JSON.parse(harness.requests[0].request.body);
    const whatsappUrl = 'https://wa.me/5493562590932?text=hola';

    expect(harness.pixelCalls().some((call) => call[1] === 'Contact')).toBe(false);
    harness.requests[0].respond(200, successfulContactResponse(whatsappUrl));

    const contactCalls = harness.pixelCalls().filter((call) => call[0] === 'track' && call[1] === 'Contact');
    expect(contactCalls).toHaveLength(1);
    expect(contactCalls[0][3]).toEqual({ eventID: payload.eventId });
    expect(harness.elements['manual-whatsapp'].href).toBe(whatsappUrl);
    expect(harness.location.href).toBe(harness.initialHref);

    await vi.advanceTimersByTimeAsync(799);
    expect(harness.location.href).toBe(harness.initialHref);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.location.href).toBe(whatsappUrl);
  });

  it('does not emit Contact for HTTP errors, timeouts, or invalid responses', () => {
    const httpFailure = createLandingHarness({ cookies: { _fbp: 'fb.1.1.1' } });
    httpFailure.requests[0].respond(500, { message: 'error' });

    const timeout = createLandingHarness({ cookies: { _fbp: 'fb.1.1.2' } });
    timeout.requests[0].failWithTimeout();

    const invalid = createLandingHarness({ cookies: { _fbp: 'fb.1.1.3' } });
    invalid.requests[0].respond(200, { status: 'ok', attributionStatus: 'incomplete' });

    for (const harness of [httpFailure, timeout, invalid]) {
      expect(harness.pixelCalls().some((call) => call[1] === 'Contact')).toBe(false);
      expect(harness.location.href).toBe(harness.initialHref);
    }
  });

  it('reuses attribution identity across retries and emits one Contact after the final success', async () => {
    const harness = createLandingHarness({ cookies: { _fbp: 'fb.1.1710000000000.111' } });
    const firstPayload = JSON.parse(harness.requests[0].request.body);
    harness.requests[0].respond(503, { message: 'retry' });

    await vi.advanceTimersByTimeAsync(350);
    expect(harness.requests).toHaveLength(2);
    const secondPayload = JSON.parse(harness.requests[1].request.body);
    expect(secondPayload.eventId).toBe(firstPayload.eventId);
    expect(secondPayload.landingSessionId).toBe(firstPayload.landingSessionId);

    harness.requests[1].respond(200, successfulContactResponse());
    expect(harness.pixelCalls().filter((call) => call[1] === 'Contact')).toHaveLength(1);
  });

  it('continues to WhatsApp when Pixel is unavailable', async () => {
    const harness = createLandingHarness({ pixelId: null });
    const whatsappUrl = 'https://wa.me/5493562590932?text=sin-pixel';

    expect(harness.requests).toHaveLength(1);
    harness.requests[0].respond(200, successfulContactResponse(whatsappUrl));
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.pixelCalls()).toEqual([]);
    expect(harness.location.href).toBe(whatsappUrl);
  });

  it('continues to create the session and open WhatsApp when Pixel calls are blocked', async () => {
    const harness = createLandingHarness({ pixelThrows: true });
    const whatsappUrl = 'https://wa.me/5493562590932?text=pixel-bloqueado';

    await vi.advanceTimersByTimeAsync(500);
    expect(harness.requests).toHaveLength(1);
    harness.requests[0].respond(200, successfulContactResponse(whatsappUrl));
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.location.href).toBe(whatsappUrl);
  });

  it('never emits checkout, lead, or purchase events from the browser', () => {
    const harness = createLandingHarness({ cookies: { _fbp: 'fb.1.1710000000000.111' } });
    harness.requests[0].respond(200, successfulContactResponse());
    const eventNames = harness.pixelCalls().filter((call) => call[0] === 'track').map((call) => call[1]);

    expect(eventNames).toEqual(['PageView', 'Contact']);
    expect(eventNames).not.toContain('InitiateCheckout');
    expect(eventNames).not.toContain('Lead');
    expect(eventNames).not.toContain('Purchase');
  });
});
