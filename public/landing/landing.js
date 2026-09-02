(function () {
  'use strict';
  var config = window.__RDA_LANDING_CONFIG__ || {};
  var status = document.getElementById('status');
  var retry = document.getElementById('retry');
  var whatsappLink = document.getElementById('manual-whatsapp');
  var landingSessionId = makeId('landing');
  var eventId = makeId('contact');
  var contactTracked = false;
  var fbpWaitMs = 500;
  var fbpPollMs = 50;

  function makeId(prefix) { return prefix + '-' + new Date().getTime().toString(36) + '-' + Math.floor(Math.random() * 2147483647).toString(36); }
  function readCookie(name) {
    var prefix = name + '='; var parts = document.cookie ? document.cookie.split(';') : []; var i;
    for (i = 0; i < parts.length; i += 1) { var value = parts[i].trim(); if (value.indexOf(prefix) === 0) { return decodeURIComponent(value.substring(prefix.length)); } }
    return null;
  }
  function writeCookie(name, value) { try { document.cookie = name + '=' + encodeURIComponent(value) + '; path=/; max-age=7776000; SameSite=Lax'; } catch (ignore) {} }
  function queryValue(name) {
    var source = window.location.search.substring(1).split('&'); var i;
    for (i = 0; i < source.length; i += 1) { var pair = source[i].split('='); if (decodeURIComponent(pair[0] || '').toLowerCase() === name.toLowerCase()) { return decodeURIComponent((pair.slice(1).join('=') || '').replace(/\+/g, ' ')); } }
    return null;
  }
  function initPixel() {
    if (!config.pixelId || window.__rdaPixelInitialized) { return; }
    window.__rdaPixelInitialized = true;
    try {
      !function(f,b,e,v,n,t,s){if(f.fbq){return;}n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments);};if(!f._fbq){f._fbq=n;}n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s);}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
      window.fbq('init', config.pixelId); window.fbq('track', 'PageView');
    } catch (ignore) {}
  }
  function trackContact() {
    if (contactTracked) { return false; }
    contactTracked = true;
    try { if (typeof window.fbq === 'function') { window.fbq('track', 'Contact', {}, { eventID: eventId }); } } catch (ignore) {}
    return true;
  }
  function confirmContact() {
    var endpoint = config.contactConfirmEndpoint || '/landing/contact/confirm';
    var body = JSON.stringify({ landingSessionId: landingSessionId, eventId: eventId });
    try {
      if (window.navigator && typeof window.navigator.sendBeacon === 'function') {
        window.navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/json' }));
      }
    } catch (ignore) {}
  }
  function send(payload, done) {
    var xhr = new XMLHttpRequest(); var finished = false;
    function complete(data) { if (finished) { return; } finished = true; done(data); }
    xhr.open('POST', config.contactEndpoint || '/landing/contact', true); xhr.timeout = 7000; xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onreadystatechange = function () { var data; if (xhr.readyState !== 4) { return; } if (xhr.status < 200 || xhr.status >= 300) { complete(null); return; } try { data = JSON.parse(xhr.responseText); } catch (ignore) { data = null; } complete(data && data.status === 'ok' && data.attributionStatus === 'persisted' && data.whatsappUrl ? data : null); };
    xhr.ontimeout = function () { complete(null); }; xhr.onerror = function () { complete(null); }; xhr.send(JSON.stringify(payload));
  }
  function payload() {
    var fbclid = queryValue('fbclid'); var fbc = readCookie('_fbc');
    if (!fbc && fbclid) { fbc = 'fb.1.' + new Date().getTime() + '.' + fbclid; writeCookie('_fbc', fbc); }
    return { eventId: eventId, landingSessionId: landingSessionId, landingVariant: config.landingVariant || 'rda-central-auto-v1', fbp: readCookie('_fbp'), fbc: fbc, fbclid: fbclid, eventSourceUrl: window.location.href, referrer: document.referrer || null, utmSource: queryValue('utm_source'), utmMedium: queryValue('utm_medium'), utmId: queryValue('utm_id'), utmCampaign: queryValue('utm_campaign'), utmContent: queryValue('utm_content'), utmTerm: queryValue('utm_term'), adsetId: queryValue('adset_id'), adId: queryValue('ad_id'), placement: queryValue('placement') };
  }
  function waitForFbp(done) {
    var elapsedMs = 0;
    function poll() {
      if (readCookie('_fbp') || elapsedMs >= fbpWaitMs) { done(); return; }
      elapsedMs += fbpPollMs; window.setTimeout(poll, fbpPollMs);
    }
    if (!config.pixelId) { done(); return; }
    poll();
  }
  function showRetry() {
    whatsappLink.hidden = true; whatsappLink.removeAttribute('href');
    status.innerHTML = 'No pudimos preparar la conexión. Reintentá.'; retry.hidden = false;
  }
  function prepare() {
    retry.hidden = true; whatsappLink.hidden = true; whatsappLink.removeAttribute('href');
    status.innerHTML = 'Estamos preparando tu conexión…';
    send(payload(), function (data) {
      if (!data) { showRetry(); return; }
      eventId = data.eventId || eventId;
      whatsappLink.href = data.whatsappUrl; whatsappLink.hidden = false;
      status.innerHTML = 'Tu conexión está lista.';
    });
  }
  whatsappLink.onclick = function () { if (trackContact()) { confirmContact(); } };
  retry.onclick = function () { prepare(); };
  initPixel(); waitForFbp(prepare);
}());
