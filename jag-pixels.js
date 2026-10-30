/* ============================================================
   Ad + CRM pixels, on PUBLIC pages only (loaded by jag-track.js).
     · TikTok Pixel (CNC4GV3C77UBR2I96NL0): page views, home views, searches, form sends, calls → TikTok Ads
       (measures and optimizes the TikTok ads). Automatic Advanced Matching is set in TikTok Events Manager to
       EMAIL ONLY, hashed (never phone: the A2P/SMS privacy promise says mobile numbers are never shared).
     · Follow Up Boss pixel (WT-GNOQKSCV): page views for people already in FUB → their FUB timeline.
   Never on: the loan application, client accounts, offers, private links (casas, lista, tour, join, lender, done…),
   or team pages. Only on the live site (not previews), never for bots or team members.
   Events come from the site's own tracker (JagTrack.ev) and lead forms (jagCapture): no personal data is sent with them.
   Privacy policy section 5 describes this; update it if pages or tools change.
   ============================================================ */
(function(){
  if (window.__jagPixels) return; window.__jagPixels = 1;
   if (window.top !== window) return;   // inside the JAG app (the site runs in a frame there): no call widget, no ad pixels
  var TIKTOK = '', FUB = 'WT-GNOQKSCV';   // TikTok paused: waiting for a proper Web pixel (old ID CNC4GV3C77UBR2I96NL0 was a hidden Lead Ad pixel, not in Data sources)
  var PUBLIC = /^\/(index|homes|h|buscar|calculadora|value|reels|team|offer-listing-intake)?(\.html)?\/?$/i;
  if (!/(^|\.)jasonaguirregroup\.company$/i.test(location.hostname)) return;
  if (!PUBLIC.test(location.pathname)) return;
  var ua = navigator.userAgent || '';
  if (navigator.webdriver || /bot|crawl|spider|slurp|preview|lighthouse|headlesschrome/i.test(ua)) return;
  try{ if (localStorage.getItem('jag_agent')) return; }catch(e){}   // the team browsing their own site

  /* ---- TikTok Pixel (TikTok's standard base code) ---- */
  if (TIKTOK) !function (w, d, t) {
    w.TiktokAnalyticsObject = t; var ttq = w[t] = w[t] || [];
    ttq.methods = ['page', 'track', 'identify', 'instances', 'debug', 'on', 'off', 'once', 'ready', 'alias', 'group', 'enableCookie', 'disableCookie', 'holdConsent', 'revokeConsent', 'grantConsent'];
    ttq.setAndDefer = function(t, e){ t[e] = function(){ t.push([e].concat(Array.prototype.slice.call(arguments, 0))); }; };
    for (var i = 0; i < ttq.methods.length; i++) ttq.setAndDefer(ttq, ttq.methods[i]);
    ttq.instance = function(t){ for (var e = ttq._i[t] || [], n = 0; n < ttq.methods.length; n++) ttq.setAndDefer(e, ttq.methods[n]); return e; };
    ttq.load = function(e, n){ var r = 'https://analytics.tiktok.com/i18n/pixel/events.js', o = n && n.partner;
      ttq._i = ttq._i || {}, ttq._i[e] = [], ttq._i[e]._u = r, ttq._t = ttq._t || {}, ttq._t[e] = +new Date, ttq._o = ttq._o || {}, ttq._o[e] = n || {};
      n = d.createElement('script'); n.type = 'text/javascript', n.async = !0, n.src = r + '?sdkid=' + e + '&lib=' + t;
      e = d.getElementsByTagName('script')[0]; e.parentNode.insertBefore(n, e); };
    ttq.load(TIKTOK);
    ttq.page();
  }(window, document, 'ttq');

  /* ---- Follow Up Boss pixel (FUB's widget tracker code) ----
     The same code also draws FUB's floating "call or text us" phone button + popup (an iframe pinned bottom-right).
     We keep the tracking (page views still reach FUB) and hide that button: homes already have "Call your agent". */
  try{ var hs = document.createElement('style'); hs.textContent = 'body>iframe[style*="2147483647"]{display:none!important;visibility:hidden!important}'; document.head.appendChild(hs); }catch(e){}
  (function(w, i, d, g, e, t){ w['WidgetTrackerObject'] = g; (w[g] = w[g] || function(){ (w[g].q = w[g].q || []).push(arguments); }), (w[g].ds = 1 * new Date());
    (e = 'script'), (t = d.createElement(e)), (e = d.getElementsByTagName(e)[0]); t.async = 1; t.src = i; e.parentNode.insertBefore(t, e);
  })(window, 'https://widgetbe.com/agent', document, 'widgetTracker');
  window.widgetTracker('create', FUB);
  window.widgetTracker('send', 'pageview');

  /* ---- events → TikTok (no names, emails or phones in them) ---- */
  function tt(ev, props){ try{ window.ttq && window.ttq.track(ev, props || {}); }catch(e){} }
  var MAP = {   // the site tracker's events (homes.html, jag-premium.js, chat) → TikTok standard events
    home_view: function(x){ return x && x.mls ? ['ViewContent', { content_id: String(x.mls), content_type: 'product', content_name: 'home' }] : null; },
    home_save: function(x){ return x && x.mls ? ['AddToWishlist', { content_id: String(x.mls), content_type: 'product' }] : null; },
    home_fav: function(x){ return x && x.mls ? ['AddToWishlist', { content_id: String(x.mls), content_type: 'product' }] : null; },
    home_inquiry: function(x){ return ['Contact', { content_id: x && x.mls ? String(x.mls) : undefined, content_name: 'home inquiry' }]; },
    showing_request: function(x){ return ['Contact', { content_id: x && x.mls ? String(x.mls) : undefined, content_name: 'showing request' }]; },
    chat_open: function(){ return ['ClickButton', { content_name: 'chat' }]; }
  };
  // taps on the phone number or a booking link
  document.addEventListener('click', function(e){
    var a = e.target && e.target.closest && e.target.closest('a[href]'); if (!a) return;
    var h = a.getAttribute('href') || '';
    if (/^tel:/i.test(h)) tt('Contact', { content_name: 'call' });
    else if (/calendly\.com|\/book|booking/i.test(h)) tt('Contact', { content_name: 'booking' });
    else if (/^(\.\/)?apply(\.html)?([?#]|$)/i.test(h)) tt('ClickButton', { content_name: 'loan application' });
  }, true);
  function hookTrack(){
    if (!window.JagTrack || window.JagTrack.__px) return !!(window.JagTrack && window.JagTrack.__px);
    var orig = window.JagTrack.ev;
    window.JagTrack.ev = function(kind, extra){ try{ var m = MAP[kind] && MAP[kind](extra); if (m) tt(m[0], m[1]); }catch(e){} return orig.apply(this, arguments); };
    window.JagTrack.__px = 1; return true;
  }
  function hookCapture(){
    if (typeof window.jagCapture !== 'function' || window.jagCapture.__px) return !!(window.jagCapture && window.jagCapture.__px);
    var orig = window.jagCapture;
    window.jagCapture = function(type){ tt('SubmitForm', { content_name: String(type || 'form').slice(0, 40) }); return orig.apply(this, arguments); };
    window.jagCapture.__px = 1; return true;
  }
  hookTrack(); hookCapture();
  var n = 0, iv = setInterval(function(){ var a = hookTrack(), b = hookCapture(); if ((a && b) || ++n > 20) clearInterval(iv); }, 500);
})();
