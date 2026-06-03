(function () {
  const config = window.__RDA_LANDING_CONFIG__ || {};
  const TRACKING_TIMEOUT_MS = 900;

  function safeRandomId(prefix) {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return `${prefix}_${window.crypto.randomUUID()}`;
    }
    return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

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
    return {
      eventId,
      landingSessionId: getLandingSessionId(),
      fbp: readCookie("_fbp"),
      fbc: getFbc(fbclid),
      fbclid,
      eventSourceUrl: window.location.href,
      referrer: document.referrer || null,
      utmSource: getSearchParam("utm_source"),
      utmMedium: getSearchParam("utm_medium"),
      utmCampaign: getSearchParam("utm_campaign"),
      utmContent: getSearchParam("utm_content"),
      utmTerm: getSearchParam("utm_term"),
      consentMarketing: null,
      consentTimestamp: null,
      whatsappUrl: config.whatsappUrl
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
      "https://wa.me/5493516346253?text=Hola%20quiero%20mi%20usuario%20suertudo%20del%20Rey%20Dorado";
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
      const payload = buildContactPayload(eventId);
      trackPixelContact(eventId);

      const result = await postContact(payload);
      redirectToWhatsapp(result && typeof result.whatsappUrl === "string" ? result.whatsappUrl : null);
    });
  }

  initPixel();
  bindCta();
})();
