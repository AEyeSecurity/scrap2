(function () {
  const config = window.__RDA_LANDING_CONFIG__ || {};
  const TRACKING_TIMEOUT_MS = 900;
  const FBP_POLL_INTERVAL_MS = 100;
  const FBP_POLL_TIMEOUT_MS = 5000;
  let cachedFbp = null;

  function safeRandomId(prefix) {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return `${prefix}_${window.crypto.randomUUID()}`;
    }
    return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  const routingSeed = safeRandomId("routing");

  function readCookie(name) {
    const match = document.cookie.match(new RegExp(`(?:^|; )${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : null;
  }

  function writeCookie(name, value) {
    const maxAge = 60 * 60 * 24 * 90;
    document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAge}; SameSite=Lax`;
  }

  function getLandingSessionId() {
    const key = "rda_landing_session_id";
    try {
      const existing = window.localStorage.getItem(key);
      if (existing) {
        return existing;
      }
      const created = safeRandomId("session");
      window.localStorage.setItem(key, created);
      return created;
    } catch (_error) {
      return safeRandomId("session");
    }
  }

  function getSearchParam(name) {
    return new URLSearchParams(window.location.search).get(name);
  }

  function getFbc(fbclid) {
    const current = readCookie("_fbc");
    if (current) {
      return current;
    }
    if (!fbclid) {
      return null;
    }
    const generated = `fb.1.${Date.now()}.${fbclid}`;
    writeCookie("_fbc", generated);
    return generated;
  }

  function readValidFbp() {
    const value = readCookie("_fbp");
    return typeof value === "string" && value.startsWith("fb.") ? value : null;
  }

  function captureFbp() {
    const current = readValidFbp();
    if (current && !cachedFbp) {
      cachedFbp = current;
    }
    return current || cachedFbp;
  }

  function startFbpCapture() {
    captureFbp();
    const startedAt = Date.now();
    const timer = window.setInterval(function () {
      if (captureFbp() || Date.now() - startedAt >= FBP_POLL_TIMEOUT_MS) {
        window.clearInterval(timer);
      }
    }, FBP_POLL_INTERVAL_MS);
  }

  function getWhatsappPhones() {
    return Array.isArray(config.whatsappPhones) && config.whatsappPhones.length > 0
      ? config.whatsappPhones
      : [config.whatsappPhone || "5493515747477"];
  }

  function pickWhatsappPhone(seed) {
    const phones = getWhatsappPhones();
    let hash = 0;
    for (let index = 0; index < seed.length; index += 1) {
      hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
    }
    return phones[hash % phones.length];
  }

  function buildWhatsappUrl(phone, message) {
    return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
  }

  function initPixel() {
    if (!config.pixelId || window.fbq) {
      return;
    }

    window.fbq = function () {
      window.fbq.callMethod ? window.fbq.callMethod.apply(window.fbq, arguments) : window.fbq.queue.push(arguments);
    };
    if (!window._fbq) {
      window._fbq = window.fbq;
    }
    window.fbq.push = window.fbq;
    window.fbq.loaded = true;
    window.fbq.version = "2.0";
    window.fbq.queue = [];

    const script = document.createElement("script");
    script.async = true;
    script.src = "https://connect.facebook.net/en_US/fbevents.js";
    document.head.appendChild(script);

    window.fbq("init", config.pixelId);
    window.fbq("track", "PageView");
  }

  function buildContactPayload(eventId) {
    const fbclid = getSearchParam("fbclid");
    const landingSessionId = getLandingSessionId();
    const fallbackWhatsappUrl = buildWhatsappUrl(
      pickWhatsappPhone(routingSeed),
      config.whatsappMessage || "Hola quiero mi usuario suertudo del Rey Dorado"
    );
    return {
      eventId,
      landingSessionId,
      routingSeed,
      fbp: captureFbp(),
      fbc: getFbc(fbclid),
      fbclid,
      eventSourceUrl: window.location.href,
      referrer: document.referrer || null,
      utmSource: getSearchParam("utm_source"),
      utmMedium: getSearchParam("utm_medium"),
      utmId: getSearchParam("utm_id"),
      utmCampaign: getSearchParam("utm_campaign"),
      utmContent: getSearchParam("utm_content"),
      utmTerm: getSearchParam("utm_term"),
      adsetId: getSearchParam("adset_id"),
      adId: getSearchParam("ad_id"),
      placement: getSearchParam("placement"),
      consentMarketing: null,
      consentTimestamp: null,
      whatsappUrl: fallbackWhatsappUrl
    };
  }

  function trackPixelContact(eventId) {
    if (!window.fbq) {
      return;
    }

    window.fbq(
      "track",
      "Contact",
      {
        content_name: "Rey Dorado WhatsApp CTA",
        destination: "whatsapp",
        landing_variant: config.landingVariant || "rda-luqui10-v1"
      },
      { eventID: eventId }
    );
  }

  function timeout(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  async function postContact(payload) {
    if (!config.contactEndpoint) {
      return null;
    }

    const request = fetch(config.contactEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      credentials: "same-origin",
      keepalive: true
    })
      .then((response) => (response && response.ok ? response.json().catch(() => null) : null))
      .catch(() => null);

    return Promise.race([request, timeout(TRACKING_TIMEOUT_MS).then(() => null)]);
  }

  function redirectToWhatsapp(whatsappUrl) {
    window.location.href =
      whatsappUrl ||
      config.whatsappUrl ||
      "https://wa.me/5493515747477?text=Hola%20quiero%20mi%20usuario%20suertudo%20del%20Rey%20Dorado";
  }

  function bindCta() {
    const cta = document.querySelector("[data-track-contact='true']");
    if (!cta) {
      return;
    }

    let redirecting = false;
    cta.addEventListener("click", async function (event) {
      event.preventDefault();
      if (redirecting) {
        return;
      }
      redirecting = true;

      const eventId = safeRandomId("contact");
      trackPixelContact(eventId);
      const payload = buildContactPayload(eventId);

      const result = await postContact(payload);
      redirectToWhatsapp(result && typeof result.whatsappUrl === "string" ? result.whatsappUrl : payload.whatsappUrl);
    });
  }

  initPixel();
  startFbpCapture();
  bindCta();
})();
