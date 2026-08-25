(function () {
  'use strict';
  var config = window.__RDA_LANDING_CONFIG__ || {};
  var startedAt = new Date().getTime();
  var status = document.getElementById('status');
  var retry = document.getElementById('retry');
  var manual = document.getElementById('manual-whatsapp');
  var attempts = 0;
  var recoveryTimer = null;
  var landingSessionId = makeId('landing');
  var eventId = makeId('contact');

  function makeId(prefix) { return prefix + '-' + new Date().getTime().toString(36) + '-' + Math.floor(Math.random() * 2147483647).toString(36); }
  function readCookie(name) {
    var prefix = name + '='; var parts = document.cookie ? document.cookie.split(';') : []; var i;
    for (i = 0; i < parts.length; i += 1) { var item = parts[i].replace(/^\s+/, ''); if (item.indexOf(prefix) === 0) { return decodeURIComponent(item.substring(prefix.length)); } }
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
    !function(f,b,e,v,n,t,s){if(f.fbq){return;}n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments);};if(!f._fbq){f._fbq=n;}n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s);}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
    window.fbq('init', config.pixelId); window.fbq('track', 'PageView');
  }
  function trackContact() { if (window.fbq) { window.fbq('track', 'Contact', {}, { eventID: eventId }); } }
  function send(payload, done) {
    var xhr = new XMLHttpRequest(); var finished = false;
    function complete(data) { if (finished) { return; } finished = true; done(data); }
    xhr.open('POST', config.contactEndpoint || '/landing/contact', true); xhr.timeout = 7000; xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onreadystatechange = function () { var data; if (xhr.readyState !== 4) { return; } if (xhr.status < 200 || xhr.status >= 300) { complete(null); return; } try { data = JSON.parse(xhr.responseText); } catch (ignore) { data = null; } complete(data && data.status === 'ok' && data.attributionStatus === 'persisted' && data.whatsappUrl ? data : null); };
    xhr.ontimeout = function () { complete(null); }; xhr.onerror = function () { complete(null); }; xhr.send(JSON.stringify(payload));
  }
  function payload() {
    var fbclid = queryValue('fbclid'); var fbc = readCookie('_fbc');
    if (!fbc && fbclid) { fbc = 'fb.1.' + Math.floor(new Date().getTime() / 1000) + '.' + fbclid; writeCookie('_fbc', fbc); }
    return { eventId: eventId, landingSessionId: landingSessionId, landingVariant: config.landingVariant || 'rda-central-auto-v1', fbp: readCookie('_fbp'), fbc: fbc, fbclid: fbclid, eventSourceUrl: window.location.href, referrer: document.referrer || null, utmSource: queryValue('utm_source'), utmMedium: queryValue('utm_medium'), utmId: queryValue('utm_id'), utmCampaign: queryValue('utm_campaign'), utmContent: queryValue('utm_content'), utmTerm: queryValue('utm_term'), adsetId: queryValue('adset_id'), adId: queryValue('ad_id'), placement: queryValue('placement') };
  }
  function clearRecoveryTimer() { if (recoveryTimer) { window.clearTimeout(recoveryTimer); recoveryTimer = null; } }
  function showRetry() { clearRecoveryTimer(); manual.hidden = true; status.innerHTML = 'No pudimos preparar la conexión. Reintentá.'; retry.hidden = false; }
  function showManual() { retry.hidden = true; manual.hidden = false; status.innerHTML = 'Si WhatsApp no se abrió, tocá el botón.'; }
  function start() {
    attempts += 1; clearRecoveryTimer(); retry.hidden = true; manual.hidden = true; status.innerHTML = 'Te llevamos a WhatsApp…';
    send(payload(), function (data) { var wait; if (!data) { if (attempts < 3) { window.setTimeout(start, attempts * 350); } else { showRetry(); } return; } trackContact(); manual.href = data.whatsappUrl; wait = 900 - (new Date().getTime() - startedAt); window.setTimeout(function () { window.location.href = data.whatsappUrl; recoveryTimer = window.setTimeout(showManual, 2200); }, wait > 0 ? wait : 0); });
  }
  retry.onclick = function () { attempts = 0; start(); }; initPixel(); start();
}());
