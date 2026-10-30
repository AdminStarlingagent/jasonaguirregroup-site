/* ============================================================
   JAG funnel tracking — anonymous visitor → booked appointment.
   One anonymous ID per browser (no cookies, no personal data),
   where the visitor came from, page views and key actions.
   Writes only through the jag_track() RPC; the site never reads it.

   Channel tags for links we send ourselves:
     ?src=ai     AI agent / Lola texts      → ai_text
     ?src=alert  listing alert emails       → email
     ?src=share  agent shares a home by text → sms_share

   Other scripts call:  JagTrack.ev('kind', { mls, detail })
                        JagTrack.id()  /  JagTrack.channel()
   ============================================================ */
(function(){
  if (window.JagTrack) return;
  var URL_ = 'https://nyaxywghbpphjhwcmspd.supabase.co';
  var KEY  = 'sb_publishable_a3LN_l283LN8J-bJTEO8hQ_U40t09eh';
  var noop = { ev: function(){}, id: function(){ return null; }, channel: function(){ return null; } };

  var ua = navigator.userAgent || '';
  if (navigator.webdriver || /bot|crawl|spider|slurp|preview|lighthouse|headlesschrome/i.test(ua)) { window.JagTrack = noop; return; }

  function ls(k, v){ try{ if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); }catch(e){ return null; } }
  function ss(k, v){ try{ if (v === undefined) return sessionStorage.getItem(k); sessionStorage.setItem(k, v); }catch(e){ return null; } }
  function rid(){
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c){ var r = Math.random()*16|0; return (c === 'x' ? r : (r&3|8)).toString(16); });
  }

  var vid = ls('jag_vid');
  if (!vid || !/^[A-Za-z0-9-]{8,64}$/.test(vid)) { vid = rid(); ls('jag_vid', vid); }
  var sid = ss('jag_sid'); if (!sid) { sid = rid(); ss('jag_sid', sid); }

  /* ---- where did this visit come from? ---- */
  var q = new URLSearchParams(location.search);
  var g = function(k){ return (q.get(k) || '').toLowerCase(); };
  var src = g('src'), us = g('utm_source'), um = g('utm_medium');
  var ref = ''; try{ ref = document.referrer ? new URL(document.referrer).hostname.replace(/^www\./, '') : ''; }catch(e){}
  if (ref === location.hostname.replace(/^www\./, '')) ref = '';

  function detect(){
    if (src === 'ai' || src === 'lola' || us === 'starling' || us === 'lola' || us === 'ai') return 'ai_text';
    if (src === 'alert' || um === 'email' || us === 'email') return 'email';
    if (src === 'share' || um === 'sms') return 'sms_share';
    if (q.get('ttclid') || q.get('iab_source') || us === 'tiktok') return 'tiktok';
    if (q.get('fbclid') || /^(facebook|fb|instagram|ig|meta)$/.test(us)) return 'meta';
    if (q.get('gclid') || q.get('gbraid') || q.get('wbraid') || (us === 'google' && /cpc|paid|ppc/.test(um))) return 'google_ads';
    if (us) return /social/.test(um) ? 'social' : 'other';
    if (/(^|\.)(google|bing|yahoo|duckduckgo|ecosia|baidu)\./.test(ref)) return 'organic_search';
    if (/(facebook|instagram|tiktok|t\.co|twitter|x\.com|linkedin|youtube|pinterest|reddit|whatsapp)/.test(ref)) return 'social';
    if (ref) return 'referral';
    return null; /* no signal on this page load */
  }
  var hit = detect();
  /* last-touch for this visit: keep the session's channel unless a new tagged link arrives */
  var ch = hit || ss('jag_ch') || 'direct';
  if (hit || !ss('jag_ch')) ss('jag_ch', ch);

  var lang = (document.documentElement.lang || '').slice(0, 2) || null;
  try{ var ql = q.get('lang'); if (ql === 'es' || ql === 'en') lang = ql; }catch(e){}
  var dev = /Mobi|Android|iPhone|iPad/i.test(ua) ? 'mobile' : 'desktop';
  var page = location.pathname.replace(/\.html$/, '').replace(/\/+$/, '') || '/';
  var camp = q.get('utm_campaign') || q.get('campaign') || null;

  function send(kind, extra){
    try{
      var body = { v: vid, s: sid, k: kind, page: page, ch: ch, lang: lang, dev: dev };
      if (kind === 'page_view' || !ls('jag_vid_sent')) {
        body.src = (us || src || ref || null); body.camp = camp; body.land = page; body.ref = ref || null;
      }
      if (extra) { if (extra.mls) body.mls = String(extra.mls); if (extra.detail) body.detail = String(extra.detail).slice(0, 120); }
      fetch(URL_ + '/rest/v1/rpc/jag_track', {
        method: 'POST', keepalive: true,
        headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p: body })
      }).then(function(r){ if (r.ok) ls('jag_vid_sent', '1'); }).catch(function(){});
    }catch(e){}
  }

  var once = {};
  function ev(kind, extra){
    var key = kind + ':' + ((extra && (extra.mls || extra.detail)) || '');
    if (once[key]) return; once[key] = 1;
    send(kind, extra);
  }

  window.JagTrack = { ev: ev, id: function(){ return vid; }, channel: function(){ return ch; } };
  send('page_view');

  /* ---- ad + CRM pixels (TikTok, Follow Up Boss): jag-pixels.js decides which pages get them (public pages only) ---- */
  try{ var px = document.createElement('script'); px.async = true; px.src = 'jag-pixels.js?v=2'; document.head.appendChild(px); }catch(e){}

  /* ---- first touch on a form = started (application, home value, offer) ---- */
  var startKind = /\/apply$/.test(page) ? 'apply_start' : /\/value$/.test(page) ? 'value_start'
                : /\/(offer|offer-listing-intake)$/.test(page) ? 'offer_start' : null;
  if (startKind) {
    var started = function(e){
      var t = e.target; if (!t || !t.closest) return;
      var el = t.closest('button, input, select, textarea, label, [role="radio"], [role="button"], .opt, .choice');
      if (!el || !el.closest('main, form') || el.closest('header, nav, footer, .jc, .jc-b')) return;
      document.removeEventListener('input', started, true); document.removeEventListener('click', started, true);
      ev(startKind);
    };
    document.addEventListener('input', started, true);
    document.addEventListener('click', started, true);
  }

  /* ---- taps that matter: calling the office, booking a time ---- */
  document.addEventListener('click', function(e){
    var a = e.target && e.target.closest && e.target.closest('a[href]'); if (!a) return;
    var h = a.getAttribute('href') || '';
    if (/^tel:/i.test(h)) ev('call_click', { detail: page });
    else if (/calendly\.com|\/book|booking/i.test(h)) ev('book_click', { detail: page });
  }, true);

  /* ---- signed-in clients: tie this browser to the account (team members get flagged out) ---- */
  function link(u){
    if (!u || !window.JagAccount || !JagAccount.rpc) return;
    if (ss('jag_vid_linked') === u.id) return;
    JagAccount.rpc('jag_track_link', { p_visitor: vid }).then(function(){ ss('jag_vid_linked', u.id); }).catch(function(){});
    ev('signin');
  }
  function hookAccount(){
    if (!window.JagAccount) return false;
    try{ JagAccount.onChange(link); link(JagAccount.user()); }catch(e){}
    return true;
  }
  if (!hookAccount()) {
    var tries = 0, iv = setInterval(function(){ if (hookAccount() || ++tries > 20) clearInterval(iv); }, 500);
  }
})();
