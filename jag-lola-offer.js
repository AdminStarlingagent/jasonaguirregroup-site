/* ============================================================
   "Tell Lola about an offer" (Agent Hub). The showing agent answers Lola's questions, one at a time,
   the same ones as "Begin offer": which house (Lola pulls the listing from HAR: legal, HOA, MUD, listing agent),
   buyer, price, loan, down payment, seller help, earnest money, option, closing, title, warranty, notes.
   Send → jag_lola_offer: the offer draft is created and Katherine + the TC (closings@) get the hand-off email
   with the listing, the offer, SkySlope steps and a ready-to-send email to the listing agent asking for the
   title company and seller names (edge function jag-offer-tc).
   JagLolaOffer.open()  ·  JagLolaOffer.mine(el) → "Sent to the TC" list
   Needs: jag-share.js (JagShare.token), jag-team-offer.js (JagTeamOffer.facts).
   ============================================================ */
(function () {
  'use strict';
  var C = window.JAG_CRM || {}, BASE = String(C.url || '').replace(/\/+$/, ''), KEY = C.anonKey;
  var API = BASE + '/functions/v1/home-search', CDN = 'https://cdn.repliers.io/', SAVE = 'jag_lola_offer_v1';
  var LOLA = '<svg aria-hidden="true" viewBox="0 0 16 16" shape-rendering="crispEdges"><rect x="6" y="0" width="4" height="1" fill="#2b1d16"/><rect x="5" y="1" width="6" height="1" fill="#2b1d16"/><rect x="3" y="2" width="10" height="1" fill="#2b1d16"/><rect x="2" y="3" width="12" height="1" fill="#2b1d16"/><rect x="2" y="4" width="1" height="1" fill="#5b5a63"/><rect x="3" y="4" width="2" height="1" fill="#2b1d16"/><rect x="5" y="4" width="6" height="1" fill="#d9a07a"/><rect x="11" y="4" width="2" height="1" fill="#2b1d16"/><rect x="13" y="4" width="1" height="1" fill="#5b5a63"/><rect x="2" y="5" width="1" height="1" fill="#5b5a63"/><rect x="3" y="5" width="1" height="1" fill="#2b1d16"/><rect x="4" y="5" width="8" height="1" fill="#d9a07a"/><rect x="12" y="5" width="1" height="1" fill="#2b1d16"/><rect x="13" y="5" width="1" height="1" fill="#5b5a63"/><rect x="2" y="6" width="1" height="1" fill="#5b5a63"/><rect x="3" y="6" width="2" height="1" fill="#d9a07a"/><rect x="5" y="6" width="1" height="1" fill="#17161c"/><rect x="6" y="6" width="4" height="1" fill="#d9a07a"/><rect x="10" y="6" width="1" height="1" fill="#17161c"/><rect x="11" y="6" width="2" height="1" fill="#d9a07a"/><rect x="13" y="6" width="1" height="1" fill="#5b5a63"/><rect x="2" y="7" width="1" height="1" fill="#5b5a63"/><rect x="3" y="7" width="2" height="1" fill="#d9a07a"/><rect x="5" y="7" width="1" height="1" fill="#17161c"/><rect x="6" y="7" width="4" height="1" fill="#d9a07a"/><rect x="10" y="7" width="1" height="1" fill="#17161c"/><rect x="11" y="7" width="2" height="1" fill="#d9a07a"/><rect x="13" y="7" width="1" height="1" fill="#5b5a63"/><rect x="2" y="8" width="1" height="1" fill="#5b5a63"/><rect x="3" y="8" width="1" height="1" fill="#d9a07a"/><rect x="4" y="8" width="1" height="1" fill="#eb9c8a"/><rect x="5" y="8" width="6" height="1" fill="#d9a07a"/><rect x="11" y="8" width="1" height="1" fill="#eb9c8a"/><rect x="12" y="8" width="1" height="1" fill="#d9a07a"/><rect x="13" y="8" width="1" height="1" fill="#5b5a63"/><rect x="1" y="9" width="2" height="1" fill="#5b5a63"/><rect x="3" y="9" width="4" height="1" fill="#d9a07a"/><rect x="7" y="9" width="2" height="1" fill="#a3333d"/><rect x="9" y="9" width="4" height="1" fill="#d9a07a"/><rect x="13" y="9" width="1" height="1" fill="#5b5a63"/><rect x="1" y="10" width="1" height="1" fill="#c8102e"/><rect x="3" y="10" width="1" height="1" fill="#b9805c"/><rect x="4" y="10" width="7" height="1" fill="#d9a07a"/><rect x="11" y="10" width="1" height="1" fill="#b9805c"/><rect x="1" y="11" width="1" height="1" fill="#c8102e"/><rect x="5" y="11" width="1" height="1" fill="#b9805c"/><rect x="6" y="11" width="4" height="1" fill="#d9a07a"/><rect x="10" y="11" width="1" height="1" fill="#b9805c"/><rect x="2" y="12" width="12" height="1" fill="#c8102e"/><rect x="1" y="13" width="6" height="1" fill="#c8102e"/><rect x="7" y="13" width="2" height="1" fill="#ffffff"/><rect x="9" y="13" width="6" height="1" fill="#c8102e"/><rect x="1" y="14" width="6" height="1" fill="#c8102e"/><rect x="7" y="14" width="2" height="1" fill="#ffffff"/><rect x="9" y="14" width="6" height="1" fill="#c8102e"/><rect x="1" y="15" width="14" height="1" fill="#c8102e"/><g class="lid"><rect x="5" y="6" width="1" height="1" fill="#d9a07a"/><rect x="10" y="6" width="1" height="1" fill="#d9a07a"/></g></svg>';
  var ov = null, S = null, cur = null, back = null, clients = null, offersP = null, sending = false;
  var ORDER = ['home', 'la', 'buyer', 'contact', 'price', 'loan', 'down', 'conc', 'earnest', 'option', 'close', 'title', 'warranty', 'note', 'review'];

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function digits(p) { return String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); }
  function phone(p) { var d = digits(p); return d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : String(p || ''); }
  function money(n) { var v = Number(String(n == null ? '' : n).replace(/[^0-9.]/g, '')); return v > 0 ? '$' + Math.round(v).toLocaleString('en-US') : ''; }
  function num(s) { var v = String(s == null ? '' : s).replace(/[^0-9.]/g, ''); return v && !isNaN(+v) ? +v : 0; }
  function r500(n) { return Math.round(n / 500) * 500; }
  function r100(n) { return Math.round(n / 100) * 100; }
  function ls(v) { try { if (v === undefined) return JSON.parse(localStorage.getItem(SAVE) || 'null'); if (v === null) localStorage.removeItem(SAVE); else localStorage.setItem(SAVE, JSON.stringify(v)); } catch (e) { return null; } }
  function rpc(name, args) {
    return JagShare.token().then(function (tk) {
      if (!tk) throw new Error('signin');
      return fetch(BASE + '/rest/v1/rpc/' + name, { method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' }, body: JSON.stringify(args || {}) });
    }).then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); });
  }
  function addr(l) { var a = (l && l.address) || {}; return [a.streetNumber, a.streetDirectionPrefix, a.streetName, a.streetSuffix, a.streetDirection].filter(Boolean).join(' ') + (a.unitNumber && a.unitNumber !== '0' ? ' #' + a.unitNumber : ''); }
  // closing dates: business days, off the days title companies close
  function holiday(d) {
    var m = d.getMonth() + 1, day = d.getDate(), wd = d.getDay(), md = m + '-' + day;
    if (['1-1', '7-4', '12-24', '12-25', '12-31'].indexOf(md) > -1) return true;
    if (m === 11 && wd === 4 && day >= 22 && day <= 28) return true;
    if (m === 11 && wd === 5 && day >= 23 && day <= 29) return true;
    if (m === 5 && wd === 1 && day >= 25) return true;
    if (m === 9 && wd === 1 && day <= 7) return true;
    return false;
  }
  function iso(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function addDays(n) { var d = new Date(); d.setDate(d.getDate() + n); while (d.getDay() === 0 || d.getDay() === 6 || holiday(d)) d.setDate(d.getDate() + 1); return iso(d); }
  function nice(isoD) { if (!/^\d{4}-\d{2}-\d{2}$/.test(isoD || '')) return isoD || ''; var d = new Date(isoD + 'T12:00:00'); return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); }
  var LOAN = { fha: 'FHA', conventional: 'Conventional', va: 'VA', usda: 'USDA', cash: 'Cash' };
  var DOWN = { fha: ['3.5'], conventional: ['3', '5', '10', '20'], va: ['0'], usda: ['0'] };

  /* ---------------- styles ---------------- */
  function css() {
    if (document.getElementById('lo-css')) return;
    var s = document.createElement('style'); s.id = 'lo-css';
    s.textContent =
      '.lo-ov{position:fixed;inset:0;background:rgba(15,14,20,.6);display:none;align-items:center;justify-content:center;padding:14px;z-index:9650}.lo-ov.on{display:flex}' +
      '.lo-m{background:#fff;color:#17161c;border-radius:20px;width:100%;max-width:560px;height:min(820px,calc(100vh - 28px));height:min(820px,calc(100dvh - 28px));display:flex;flex-direction:column;overflow:hidden;font-family:inherit;font-size:15px}' +
      '.lo-hd{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid #e8e8ec;flex:none}' +
      '.lo-av{width:40px;height:40px;border-radius:11px;background:#f5f5f7;display:grid;place-items:center;flex:none;image-rendering:pixelated}.lo-av svg{width:34px;height:34px;display:block}' +
      '.lo-av .lid{opacity:0;animation:loBlink 5s infinite}@keyframes loBlink{0%,93%{opacity:0}94%,97%{opacity:1}98%,100%{opacity:0}}@media (prefers-reduced-motion:reduce){.lo-av .lid{animation:none}}' +
      '.lo-hd .who{flex:1;min-width:0}.lo-hd b{display:block;font-size:16px;font-weight:800}.lo-hd small{color:#6a6972;font-size:12.5px}' +
      '.lo-x{border:0;background:#f5f5f7;width:40px;height:40px;border-radius:50%;font-size:22px;cursor:pointer;flex:none;color:#17161c}' +
      '.lo-log{flex:1;overflow-y:auto;padding:14px;background:#faf9f7;display:flex;flex-direction:column;gap:8px}' +
      '.lo-r{display:flex;gap:8px;align-items:flex-end;max-width:92%}.lo-r .lo-av{width:30px;height:30px;border-radius:9px}.lo-r .lo-av svg{width:24px;height:24px}' +
      '.lo-r.me{align-self:flex-end;max-width:85%}' +
      '.lo-b{padding:10px 13px;border-radius:18px;line-height:1.45;overflow-wrap:anywhere;white-space:pre-wrap}' +
      '.lo-r.her .lo-b{background:#fff;border:1px solid #e8e8ec;border-bottom-left-radius:5px}' +
      '.lo-r.me .lo-b{background:#17161c;color:#fff;border-bottom-right-radius:5px}' +
      '.lo-r.me .lo-ed{border:0;background:none;color:#c8102e;font-weight:700;font-size:12px;padding:2px 4px;align-self:center;cursor:pointer}' +
      '.lo-dots span{display:inline-block;width:7px;height:7px;border-radius:50%;background:#b9b8c0;margin:0 2px;animation:loDot 1s infinite}.lo-dots span:nth-child(2){animation-delay:.15s}.lo-dots span:nth-child(3){animation-delay:.3s}' +
      '@keyframes loDot{0%,80%,100%{opacity:.3}40%{opacity:1}}' +
      '.lo-card{background:#fff;border:1px solid #e8e8ec;border-radius:16px;overflow:hidden;white-space:normal;max-width:420px;width:100%}' +
      '.lo-card .ph{display:block;height:140px;background:#efedea center/cover no-repeat}.lo-card .tx{padding:10px 12px}.lo-card .tx b{font-size:20px;font-weight:800;letter-spacing:-.02em;display:block}' +
      '.lo-card .tx span{display:block;font-size:13.5px;color:#3f3e47}.lo-card .tx small{color:#6a6972;font-size:12px}' +
      '.lo-facts{margin:8px 0 0;border-top:1px solid #ebe9e5;font-size:13px}.lo-facts div{display:flex;gap:10px;padding:5px 0;border-bottom:1px solid #f0eeea}.lo-facts div:last-child{border:0}' +
      '.lo-card .tx .lo-facts b{display:inline;font-size:13px;font-weight:700;letter-spacing:0}.lo-facts span{color:#6a6972;flex:0 0 96px}.lo-facts em{font-style:normal;color:#a30d26;font-weight:700}' +
      '.lo-pick{display:flex;gap:10px;align-items:center;width:100%;text-align:left;background:#fff;border:2px solid #ebe9e5;border-radius:14px;padding:8px;cursor:pointer;font:inherit;color:#17161c}.lo-pick:hover{border-color:#17161c}' +
      '.lo-pick i{width:64px;height:52px;border-radius:9px;background:#efedea center/cover no-repeat;flex:none}.lo-pick b{display:block;font-size:14.5px}.lo-pick small{color:#6a6972;font-size:12.5px}' +
      '.lo-picks{display:flex;flex-direction:column;gap:6px;width:100%;max-width:420px}' +
      '.lo-in{flex:none;border-top:1px solid #e8e8ec;padding:10px 12px calc(10px + env(safe-area-inset-bottom,0px));background:#fff;display:flex;flex-direction:column;gap:8px}' +
      '.lo-chips{display:flex;flex-wrap:wrap;gap:6px}' +
      '.lo-chip{border:2px solid #c8102e;color:#c8102e;background:#fff;border-radius:99px;padding:8px 13px;font:inherit;font-weight:700;font-size:14px;cursor:pointer;min-height:42px}' +
      '.lo-chip.pri{background:#c8102e;color:#fff}.lo-chip.on{background:#17161c;border-color:#17161c;color:#fff}' +
      '.lo-row{display:flex;gap:8px;align-items:flex-end}' +
      '.lo-row input,.lo-row textarea{flex:1;min-width:0;border:1px solid #d9d6d1;background:#f6f5f3;border-radius:14px;padding:11px 13px;font:inherit;font-size:16px;color:#17161c}' +
      '.lo-row textarea{min-height:48px;max-height:140px;resize:none;line-height:1.35}.lo-row input:focus,.lo-row textarea:focus{outline:3px solid #fdecef;border-color:#c8102e}' +
      '.lo-go{flex:none;border:0;border-radius:14px;background:#c8102e;color:#fff;font:inherit;font-weight:800;padding:0 16px;height:48px;cursor:pointer}.lo-go:disabled{background:#d6d5dc}' +
      '.lo-two{display:grid;grid-template-columns:1fr 1fr;gap:8px}.lo-two label{display:block;font-size:12px;font-weight:700;color:#6a6972;margin:0 0 3px}' +
      '.lo-two input{width:100%;box-sizing:border-box;border:1px solid #d9d6d1;background:#f6f5f3;border-radius:12px;padding:10px 12px;font:inherit;font-size:16px;color:#17161c}' +
      '.lo-err{color:#a30d26;font-weight:700;font-size:13.5px;margin:0}.lo-err:empty{display:none}' +
      '.lo-rev{background:#fff;border:2px solid #17161c;border-radius:16px;overflow:hidden;white-space:normal;width:100%;max-width:440px}' +
      '.lo-rev h4{margin:0;padding:10px 12px;background:#17161c;color:#fff;font-size:14px}' +
      '.lo-rev button{display:flex;justify-content:space-between;gap:10px;width:100%;text-align:left;border:0;border-bottom:1px solid #f0eeea;background:#fff;padding:9px 12px;font:inherit;font-size:14px;color:#17161c;cursor:pointer}' +
      '.lo-rev button:hover{background:#faf9f7}.lo-rev button span{color:#6a6972}.lo-rev button b{text-align:right;overflow-wrap:anywhere;white-space:pre-wrap}.lo-rev button b em{font-style:normal;color:#c8102e}' +
      '.lo-send{border:0;border-radius:14px;background:#c8102e;color:#fff;font:inherit;font-weight:800;font-size:16px;padding:14px;cursor:pointer;width:100%}.lo-send:disabled{opacity:.6}' +
      '.lo-sub{border:2px solid #c8102e;border-radius:14px;background:#fff;color:#c8102e;font:inherit;font-weight:800;padding:11px;cursor:pointer;text-align:center;text-decoration:none;display:block}' +
      '.lo-btns{display:flex;flex-direction:column;gap:8px}' +
      '@media(max-width:560px){.lo-ov{padding:0}.lo-m{border-radius:0;height:100vh;height:100dvh;max-width:none}}' +
      /* Agent Hub: the Offers tab card and the "Sent to the TC" list */
      '.lo-cta{display:flex;gap:12px;align-items:center;background:#fff;border:2px solid #17161c;border-radius:22px;padding:14px 16px;margin-bottom:12px;box-shadow:4px 4px 0 #17161c}' +
      '.lo-cta .lo-av{width:52px;height:52px;border-radius:13px}.lo-cta .lo-av svg{width:44px;height:44px}' +
      '.lo-cta .t{flex:1;min-width:0}.lo-cta b{display:block;font-size:17px;font-weight:800}.lo-cta span{display:block;font-size:13.5px;color:#6a6972}' +
      '.lo-cta button{flex:none;border:0;border-radius:99px;background:#c8102e;color:#fff;font:inherit;font-weight:800;padding:12px 18px;cursor:pointer;min-height:46px}' +
      '@media(max-width:480px){.lo-cta{flex-wrap:wrap}.lo-cta button{width:100%}}' +
      '.lo-mine h3{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#6a6972;margin:4px 2px 8px}' +
      '.lo-sent{background:#f6f5f3;border-radius:16px;padding:10px 14px;margin-bottom:8px;display:flex;gap:10px;align-items:center;font-size:13.5px}' +
      '.lo-sent .t{flex:1;min-width:0}.lo-sent b{display:block;font-size:14.5px;overflow-wrap:anywhere}.lo-sent small{color:#6a6972}' +
      '.lo-sent .st{font-weight:800;font-size:12px;white-space:nowrap}.lo-sent .st.ok{color:#0f8a4d}.lo-sent .st.bad{color:#a30d26}' +
      '.lo-sent a{color:#c8102e;font-weight:700;white-space:nowrap}';
    document.head.appendChild(s);
  }

  /* ---------------- chat plumbing ---------------- */
  function log() { return ov.querySelector('#lo-log'); }
  function scroll() { var l = log(); l.scrollTop = l.scrollHeight; }
  function her(html, raw) {
    var r = document.createElement('div'); r.className = 'lo-r her';
    r.innerHTML = '<span class="lo-av">' + LOLA + '</span><div class="lo-b">' + (raw ? html : esc(html)) + '</div>';
    log().appendChild(r); scroll(); return r;
  }
  function herBlock(html) { var r = document.createElement('div'); r.className = 'lo-r her'; r.innerHTML = '<span class="lo-av" style="visibility:hidden"></span>' + html; log().appendChild(r); scroll(); return r; }
  function me(text, editStep) {
    var r = document.createElement('div'); r.className = 'lo-r me';
    r.innerHTML = (editStep ? '<button type="button" class="lo-ed" data-ed="' + editStep + '">Change</button>' : '') + '<div class="lo-b">' + esc(text) + '</div>';
    log().appendChild(r); scroll();
  }
  function typing(ms) {
    var r = her('<span class="lo-dots"><span></span><span></span><span></span></span>', true);
    return new Promise(function (res) { setTimeout(function () { r.remove(); res(); }, ms == null ? 350 : ms); });
  }
  function input(html) { var el = ov.querySelector('#lo-in'); el.innerHTML = html; setTimeout(scroll, 0); return el; }
  function chipsHtml(list) { return '<div class="lo-chips">' + list.map(function (c, i) { return '<button type="button" class="lo-chip' + (c.pri ? ' pri' : '') + (c.on ? ' on' : '') + '" data-c="' + i + '">' + esc(c.label) + '</button>'; }).join('') + '</div>'; }
  function bindChips(el, list) { el.querySelectorAll('[data-c]').forEach(function (b) { b.onclick = function () { var c = list[+b.getAttribute('data-c')]; if (c && c.go) c.go(); }; }); }
  function focus(el) { if (el && matchMedia('(pointer:fine)').matches) setTimeout(function () { el.focus(); }, 30); }
  // chips + one text box + Send
  function ask(o) {
    var el = input((o.chips && o.chips.length ? chipsHtml(o.chips) : '') + (o.field === false ? '' :
      '<div class="lo-row">' + (o.area ? '<textarea id="lo-t" rows="2" placeholder="' + esc(o.ph || '') + '"></textarea>' : '<input id="lo-t" autocomplete="off" ' + (o.type ? 'type="' + o.type + '" ' : '') + (o.mode ? 'inputmode="' + o.mode + '" ' : '') + 'placeholder="' + esc(o.ph || '') + '">') +
      '<button type="button" class="lo-go" id="lo-go">' + esc(o.btn || 'Send') + '</button></div>') + '<p class="lo-err" id="lo-err"></p>');
    bindChips(el, o.chips || []);
    var t = el.querySelector('#lo-t'), go = el.querySelector('#lo-go');
    if (t) {
      if (o.value != null) t.value = o.value;
      var submit = function () { var v = String(t.value || '').trim(); if (!v && !o.allowEmpty) { t.focus(); return; } var e = o.done(v); if (e) el.querySelector('#lo-err').textContent = e; };
      go.onclick = submit;
      t.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !(o.area && e.shiftKey) && !e.isComposing) { e.preventDefault(); submit(); } });
      if (o.onInput) t.addEventListener('input', function () { o.onInput(t.value, el); });
      focus(t);
    }
    return el;
  }
  function save() { if (S && S.home) ls({ at: Date.now(), S: S, step: cur }); }

  /* ---------------- steps ---------------- */
  function next(from) {
    if (back) { var b = back; back = null; return go(b); }
    var i = ORDER.indexOf(from) + 1;
    while (i < ORDER.length && STEPS[ORDER[i]].skip && STEPS[ORDER[i]].skip()) i++;
    go(ORDER[i] || 'review');
  }
  function go(id) { cur = id; save(); typing().then(function () { STEPS[id].run(); }); }
  function answer(id, text) { me(text, id === 'home' ? null : id); next(id); }
  function edit(id) { if (sending || !S || !S.home) return; back = 'review'; me('Change: ' + (LABEL[id] || id)); go(id); }
  var LABEL = { la: 'listing agent', buyer: 'buyer', contact: 'email and phone', price: 'price', loan: 'loan', down: 'down payment', conc: 'seller help', earnest: 'earnest money', option: 'option', close: 'closing date', title: 'title company', warranty: 'home warranty', note: 'notes' };
  function price() { return S.price || S.list || 0; }

  var STEPS = {
    home: { run: function () {
      her('Which house? Type the address or the MLS #.');
      ask({ ph: 'e.g. 23022 Earlmist or 37442433', done: function (v) { me(v); find(v); } });
    } },
    la: { skip: function () { return !S.manual; }, run: function () {
      her('Who\'s the listing agent? Name and phone or email, whatever you have. The TC will reach out to them.');
      ask({ ph: 'e.g. Maria Lopez 713-555-0101', value: S.la || '', chips: [{ label: 'I don\'t have it', go: function () { S.la = ''; answer('la', 'I don\'t have it'); } }],
        done: function (v) { S.la = v; answer('la', v); } });
    } },
    buyer: { run: function () {
      her('Who\'s the buyer? Pick your client or type their full legal names, the way they\'ll sign. Two buyers: "Ana Lopez and Juan Lopez".');
      var keep = S.names ? [{ label: 'Keep ' + S.names, pri: true, go: function () { answer('buyer', S.names); } }] : [];
      var el = ask({ ph: 'Client name', value: '', chips: keep, done: function (v) { S.names = v; S.user_id = null; afterBuyer(v); },
        onInput: function (q, el2) { suggest(q, el2); } });
      loadClients().then(function () { var t = el.querySelector('#lo-t'); if (t && t.value) suggest(t.value, el); });
    } },
    contact: { run: function () {
      her(S.email || S.phone ? 'Their email and cell, right? The TC sends the contract there for signatures.' : 'Their email and cell? The TC sends the contract there for signatures.');
      var el = input('<div class="lo-two"><div><label for="lo-e">Email</label><input id="lo-e" type="email" autocomplete="off" value="' + esc(S.email || '') + '"></div>' +
        '<div><label for="lo-p">Cell</label><input id="lo-p" type="tel" autocomplete="off" value="' + esc(S.phone ? phone(S.phone) : '') + '"></div></div>' +
        '<div class="lo-row"><button type="button" class="lo-go" id="lo-go" style="flex:1">Next</button></div>' +
        chipsHtml([{ label: 'Skip, the TC can ask me' }]) + '<p class="lo-err" id="lo-err"></p>');
      el.querySelector('[data-c="0"]').onclick = function () { answer('contact', 'Skip, the TC can ask me'); };
      el.querySelector('#lo-go').onclick = function () {
        var e = el.querySelector('#lo-e').value.trim().toLowerCase(), p = el.querySelector('#lo-p').value.trim();
        if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) { el.querySelector('#lo-err').textContent = 'That email doesn\'t look right.'; return; }
        if (p && digits(p).length !== 10) { el.querySelector('#lo-err').textContent = 'Type the 10-digit cell number.'; return; }
        S.email = e; S.phone = p; answer('contact', [e, p ? phone(p) : ''].filter(Boolean).join(' · ') || 'No contact info');
      };
      focus(el.querySelector(S.email ? '#lo-p' : '#lo-e'));
    } },
    price: { run: function () {
      var L = S.list;
      her(L ? 'What are we offering? List price is ' + money(L) + (S.dom ? ', on the market ' + S.dom + ' day' + (S.dom === 1 ? '' : 's') : '') + '.' + (S.dom > 45 ? ' That\'s a while, they might take less. 😏' : '') : 'What are we offering?');
      var ch = [];
      if (S.price && S.price !== L) ch.push({ label: 'Keep ' + money(S.price), pri: true, go: function () { answer('price', money(S.price)); } });
      if (L) [[0, 'List price'], [0.02, '2% under'], [0.05, '5% under']].forEach(function (x) { var v = x[0] ? r500(L * (1 - x[0])) : L; ch.push({ label: x[1] + ' · ' + money(v), go: function () { setPrice(v); } }); });
      ask({ ph: 'Or type the price', mode: 'numeric', chips: ch, done: function (v) { var n = num(v); if (n < 10000) return 'Type the full price, like 265000.'; setPrice(n); } });
    } },
    loan: { run: function () {
      her('How are they paying?');
      var ch = Object.keys(LOAN).map(function (k) { return { label: LOAN[k], on: S.loan === k, go: function () { if (S.loan !== k) S.down = null; S.loan = k; answer('loan', LOAN[k]); } }; });
      ask({ field: false, chips: ch });
    } },
    down: { skip: function () { return S.loan === 'cash'; }, run: function () {
      her('Down payment?');
      var opts = DOWN[S.loan] || ['3', '5', '10'];
      var ch = opts.map(function (d) { return { label: d + '%' + (price() ? ' · ' + money(price() * d / 100) : ''), on: S.down === d, pri: opts.length === 1, go: function () { S.down = d; answer('down', d + '%'); } }; });
      ask({ ph: 'Or type the %', mode: 'decimal', chips: ch, done: function (v) { var n = num(v); if (n > 100) return 'Type it as a percent, like 5.'; S.down = String(n); answer('down', n + '%'); } });
    } },
    conc: { run: function () {
      her('Asking the seller to help with closing costs?');
      var P = price(), ch = [{ label: 'No', on: S.conc === 0, go: function () { S.conc = 0; answer('conc', 'No'); } }];
      [2, 3].concat(S.loan === 'fha' || S.loan === 'usda' ? [6] : S.loan === 'va' ? [4] : []).forEach(function (p) {
        if (P) ch.push({ label: p + '% · ' + money(r100(P * p / 100)), go: function () { S.conc = r100(P * p / 100); answer('conc', money(S.conc) + ' (' + p + '%)'); } });
      });
      if (S.conc > 0) ch.unshift({ label: 'Keep ' + money(S.conc), pri: true, go: function () { answer('conc', money(S.conc)); } });
      ask({ ph: '$ amount or %', mode: 'decimal', chips: ch, done: function (v) {
        var n = num(v); if (/%/.test(v) || (n > 0 && n <= 10)) { if (!P) return 'Type the dollar amount.'; n = r100(P * n / 100); }
        S.conc = n; answer('conc', n ? money(n) : 'No');
      } });
    } },
    earnest: { run: function () {
      her('Earnest money?');
      var P = price(), one = P ? Math.max(500, r100(P * 0.01)) : 0, ch = [];
      if (S.earnest && S.earnest !== one) ch.push({ label: 'Keep ' + money(S.earnest), pri: true, go: function () { answer('earnest', money(S.earnest)); } });
      if (one) ch.push({ label: '1% · ' + money(one), pri: !S.earnest, go: function () { S.earnest = one; answer('earnest', money(one)); } });
      ch.push({ label: '$1,000', go: function () { S.earnest = 1000; answer('earnest', '$1,000'); } });
      ask({ ph: 'Or type the amount', mode: 'numeric', chips: ch, done: function (v) { var n = num(v); if (n < 100) return 'Type a dollar amount, like 2500.'; S.earnest = n; answer('earnest', money(n)); } });
    } },
    option: { run: function () {
      her('Option fee and option days?');
      var el = input(chipsHtml([{ label: '$200 · 7 days (usual)', pri: true }, { label: '$100 · 5 days' }, { label: '$300 · 10 days' }]) +
        '<div class="lo-two"><div><label for="lo-of">Option fee ($)</label><input id="lo-of" inputmode="numeric" value="' + esc(S.ofee != null ? S.ofee : 200) + '"></div>' +
        '<div><label for="lo-od">Days</label><input id="lo-od" inputmode="numeric" value="' + esc(S.odays != null ? S.odays : 7) + '"></div></div>' +
        '<div class="lo-row"><button type="button" class="lo-go" id="lo-go" style="flex:1">Next</button></div><p class="lo-err" id="lo-err"></p>');
      var pick = function (f, d) { S.ofee = f; S.odays = d; answer('option', money(f) + ' · ' + d + ' days'); };
      el.querySelector('[data-c="0"]').onclick = function () { pick(200, 7); };
      el.querySelector('[data-c="1"]').onclick = function () { pick(100, 5); };
      el.querySelector('[data-c="2"]').onclick = function () { pick(300, 10); };
      el.querySelector('#lo-go').onclick = function () { var f = num(el.querySelector('#lo-of').value), d = num(el.querySelector('#lo-od').value); if (!d) { el.querySelector('#lo-err').textContent = 'How many option days?'; return; } pick(f, d); };
    } },
    close: { run: function () {
      her('Closing date?' + (S.loan === 'cash' ? ' Cash can close fast.' : ''));
      var ch = (S.loan === 'cash' ? [14, 21, 30] : [30, 35, 45]).map(function (n, i) { var d = addDays(n); return { label: n + ' days · ' + nice(d), pri: i === 0 && !S.close, on: S.close === d, go: function () { S.close = d; answer('close', nice(d)); } }; });
      if (S.close && !ch.some(function (c) { return c.on; })) ch.unshift({ label: 'Keep ' + nice(S.close), pri: true, go: function () { answer('close', nice(S.close)); } });
      ask({ type: 'date', chips: ch, value: S.close || '', btn: 'Use date', done: function (v) { if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return 'Pick a date.'; if (v < iso(new Date())) return 'That date already passed.'; S.close = v; answer('close', nice(v)); } });
    } },
    title: { run: function () {
      her('Title company? Most of the time the seller picks it, so if you don\'t know, the TC asks the listing agent.');
      var ch = [{ label: 'TC asks the listing agent', pri: !S.title, on: S.title === '', go: function () { S.title = ''; answer('title', 'TC asks the listing agent'); } },
        { label: 'Capital Title', on: S.title === 'Capital Title', go: function () { S.title = 'Capital Title'; answer('title', 'Capital Title'); } }];
      ask({ ph: 'Or type the title company', chips: ch, done: function (v) { S.title = /^(ask|tbd|idk|no se|n\/?a)\b/i.test(v) ? '' : v; answer('title', S.title || 'TC asks the listing agent'); } });
    } },
    warranty: { run: function () {
      her('Home warranty paid by the seller?');
      var ch = [{ label: '$700 (usual)', pri: S.warranty == null, on: S.warranty === 700, go: function () { S.warranty = 700; answer('warranty', '$700'); } },
        { label: 'No warranty', on: S.warranty === 0, go: function () { S.warranty = 0; answer('warranty', 'No warranty'); } }];
      ask({ ph: 'Or type the amount', mode: 'numeric', chips: ch, done: function (v) { S.warranty = num(v); answer('warranty', S.warranty ? money(S.warranty) : 'No warranty'); } });
    } },
    note: { run: function () {
      her('Anything else Katherine and the TC should know? Pre-approval letter, when the client can sign, multiple offers, repairs you saw…');
      ask({ area: true, ph: 'Type a note (optional)', value: S.note || '', allowEmpty: true, btn: 'Next',
        chips: [{ label: 'Nothing else', go: function () { S.note = ''; answer('note', 'Nothing else'); } }],
        done: function (v) { S.note = v; answer('note', v || 'Nothing else'); } });
    } },
    review: { run: review },
  };

  /* ---------------- finding the house ---------------- */
  function find(q) {
    var m = String(q).match(/(?:#|mls\s*#?\s*)?\b(\d{6,9})\b/i), url;
    if (m && !/[a-z]{3,}/i.test(q.replace(/mls/ig, ''))) url = API + '?mlsNumber=' + encodeURIComponent(m[1]);
    else url = API + '?state=TX&type=sale&resultsPerPage=6&search=' + encodeURIComponent(q.replace(/,?\s*(tx|texas)\b.*$/i, '').trim());
    var wait = typing(500);
    fetch(url).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }).then(function (j) {
      return wait.then(function () {
        var L = (j && j.listings) || [];
        if (!L.length) return notFound(q);
        if (L.length === 1) { her('Found it:'); herBlock(card(L[0], true)); return confirmOne(L[0]); }
        her('Which one?');
        var box = herBlock('<div class="lo-picks">' + L.map(function (l, i) { return pickRow(l, i); }).join('') + '</div>');
        box.querySelectorAll('[data-pk]').forEach(function (b) { b.onclick = function () { box.querySelectorAll('[data-pk]').forEach(function (x) { x.disabled = true; }); var l = L[+b.getAttribute('data-pk')]; me(addr(l)); pick(l); }; });
        ask({ ph: 'Not here? Type it again', done: function (v) { me(v); find(v); } });
      });
    });
  }
  function photo(l) { var im = (l.images || [])[0]; return im ? CDN + im + '?class=small' : ''; }
  function pickRow(l, i) {
    var a = l.address || {}, d = l.details || {};
    return '<button type="button" class="lo-pick" data-pk="' + i + '"><i style="background-image:url(\'' + esc(photo(l)) + '\')"></i><span><b>' + esc(addr(l)) + '</b><small>' + esc([a.city, money(l.listPrice), d.numBedrooms ? d.numBedrooms + ' bd' : '', 'MLS ' + l.mlsNumber].filter(Boolean).join(' · ')) + '</small></span></button>';
  }
  function card(l, small, factsHtml) {
    var a = l.address || {}, d = l.details || {};
    return '<div class="lo-card">' + (photo(l) ? '<i class="ph" style="background-image:url(\'' + esc(photo(l).replace('class=small', 'class=medium')) + '\')"></i>' : '') +
      '<div class="tx"><b>' + money(l.listPrice) + '</b><span>' + esc(addr(l)) + ', ' + esc([a.city, a.zip].filter(Boolean).join(' ')) + '</span>' +
      '<small>' + esc([d.numBedrooms ? d.numBedrooms + ' bd' : '', d.numBathrooms ? d.numBathrooms + ' ba' : '', d.sqft ? Number(d.sqft).toLocaleString('en-US') + ' sqft' : '', 'MLS ' + l.mlsNumber].filter(Boolean).join(' · ')) + '</small>' + (factsHtml || '') + '</div></div>';
  }
  function confirmOne(l) {
    var el = input(chipsHtml([{ label: 'Yes, that\'s it', pri: true }, { label: 'No, search again' }]));
    el.querySelector('[data-c="0"]').onclick = function () { me('Yes, that\'s it'); pick(l); };
    el.querySelector('[data-c="1"]').onclick = function () { me('No, search again'); go('home'); };
  }
  function notFound(q) {
    her('I can\'t find "' + q + '" on HAR. It may not be active anymore, or it\'s spelled differently. Try again, or type the full address with city and ZIP and I\'ll send it anyway.');
    ask({ ph: 'Full address, city, ZIP', chips: [{ label: 'Send it with this address', go: function () { manual(q); } }],
      done: function (v) { me(v); if (/\d{5}/.test(v)) manual(v); else find(v); } });
  }
  function manual(v) {
    var parts = v.split(',').map(function (x) { return x.trim(); }).filter(Boolean), zip = (v.match(/\b(\d{5})\b(?!.*\d{5})/) || [])[1] || '';
    S.manual = true; S.home = parts[0] || v; S.mls = ''; S.list = 0; S.dom = 0;
    S.F = { address: parts[0] || v, city: (parts[1] || '').replace(/\b(tx|texas)\b.*$/i, '').replace(/\d{5}/, '').trim(), zip: zip };
    save();
    her('Got it. I\'ll send ' + S.home + ' without the HAR details, so the TC will look them up.');
    next('home');
  }
  function pick(l) {
    S.manual = false; S.home = addr(l); S.mls = String(l.mlsNumber); S.list = Math.round(l.listPrice || 0); S.dom = l.daysOnMarket || 0;
    var wait = typing(600);
    fetch(API + '?detail=1&mlsNumber=' + encodeURIComponent(S.mls)).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }).then(function (j) {
      var full = (j && j.listings && j.listings[0]) || l;
      S.F = window.JagTeamOffer ? JagTeamOffer.facts(full.address ? full : l, full) : { address: S.home, city: (l.address || {}).city, zip: (l.address || {}).zip };
      S.F.year_built = S.F.year_built || ((full.details || {}).yearBuilt) || '';
      if (full.listPrice) S.list = Math.round(full.listPrice);
      if (full.daysOnMarket != null) S.dom = full.daysOnMarket;
      save();
      wait.then(function () {
        her('Here\'s what HAR has. It all goes on the contract:');
        herBlock(card(full, false, factsHtml(S.F)));
        var gaps = [!S.F.listing_agent_email ? 'the listing agent\'s email' : '', 'the title company', 'the seller names'].filter(Boolean);
        her('The TC will ask the listing agent for ' + gaps.join(', ').replace(/, ([^,]*)$/, ' and $1') + '. You don\'t need them.');
        webOfferFor(null).then(function (w) {
          if (w && !S.names) {
            her('Heads up: ' + (tc(w.name) || 'a client') + ' sent an offer on this house from the website' + (w.offer_price ? ' (' + money(w.offer_price) + ')' : '') + '. Is that your buyer?');
            var el = input(chipsHtml([{ label: 'Yes, use their offer', pri: true }, { label: 'No, someone else' }]));
            el.querySelector('[data-c="0"]').onclick = function () { me('Yes, use their offer'); fillFrom(w); her('Done. I filled in what they sent. Just check each answer.'); next('home'); };
            el.querySelector('[data-c="1"]').onclick = function () { me('No, someone else'); next('home'); };
          } else next('home');
        });
      });
    });
  }
  function factsHtml(F) {
    var u = '<em>TC will ask</em>', rows = [
      ['Legal', [F.lot ? 'Lot ' + F.lot : '', F.block ? 'Block ' + F.block : '', F.addition].filter(Boolean).join(', ') || F.legal_raw],
      ['County', F.county], ['Built', F.year_built],
      ['HOA', F.hoa === 'true' ? ['Yes', String(F.hoa_fee || '').replace('al año', 'a year').replace('al mes', 'a month').replace('por trimestre', 'a quarter').replace('cada 6 meses', 'twice a year'), F.hoa_name].filter(Boolean).join(' · ') : F.hoa === 'false' ? 'No' : ''],
      ['MUD', F.district_notices || 'No'],
      ['Listing agent', [F.listing_agent, F.listing_agent_phone].filter(Boolean).join(' · ')],
      ['Agent email', F.listing_agent_email], ['Brokerage', F.listing_firm]];
    return '<div class="lo-facts">' + rows.map(function (r) { return '<div><span>' + esc(r[0]) + '</span><b>' + (r[1] ? esc(r[1]) : u) + '</b></div>'; }).join('') + '</div>';
  }

  /* ---------------- buyer ---------------- */
  function loadClients() { return clients ? Promise.resolve(clients) : rpc('jag_agent_clients').then(function (j) { clients = (j && j.clients) || []; return clients; }).catch(function () { clients = []; return clients; }); }
  function webOffers() { return offersP || (offersP = rpc('jag_offers_team').then(function (j) { return (j && j.offers) || []; }).catch(function () { offersP = null; return []; })); }
  function webOfferFor(uid) {
    if (!S.mls) return Promise.resolve(null);
    return webOffers().then(function (all) { return all.filter(function (o) { return String(o.mls || '') === S.mls && o.status !== 'withdrawn' && (!uid || o.user_id === uid); })[0] || null; });
  }
  function suggest(q, el) {
    var box = el.querySelector('.lo-sug'); if (!box) { box = document.createElement('div'); box.className = 'lo-chips lo-sug'; el.insertBefore(box, el.querySelector('.lo-row')); }
    q = String(q || '').trim().toLowerCase();
    if (q.length < 2 || !clients) { box.innerHTML = ''; return; }
    var hits = clients.filter(function (c) { return (String(c.name || '') + ' ' + String(c.email || '') + ' ' + digits(c.phone)).toLowerCase().indexOf(q) > -1; }).slice(0, 5);
    box.innerHTML = hits.map(function (c, i) { return '<button type="button" class="lo-chip" data-s="' + i + '">' + esc(c.name || c.email) + '</button>'; }).join('');
    box.querySelectorAll('[data-s]').forEach(function (b) { b.onclick = function () { var c = hits[+b.getAttribute('data-s')]; S.names = c.name || ''; S.email = c.email ? String(c.email).toLowerCase() : S.email; S.phone = c.phone || S.phone; S.user_id = c.user_id; afterBuyer(S.names || c.email); }; });
  }
  function afterBuyer(label) {
    me(label, 'buyer');
    if (!S.names) { her('What are their full legal names, the way they\'ll sign?'); return ask({ ph: 'Full legal name(s)', done: function (v) { S.names = v; me(v, 'buyer'); next('buyer'); } }); }
    (S.user_id ? webOfferFor(S.user_id) : Promise.resolve(null)).then(function (w) {
      if (w && !S.fromWeb) { fillFrom(w); her('They sent an offer on this house from the website, so I filled in their numbers. Check each one.'); }
      next('buyer');
    });
  }
  function tc(x) { x = String(x || '').trim(); return x && x === x.toLowerCase() ? x.replace(/(^|[\s-])(\S)/g, function (m, a, c) { return a + c.toUpperCase(); }) : x; }
  function fillFrom(w) {
    S.fromWeb = true;
    var nm = S.names || tc(w.name), co = tc(w.co_buyer);
    if (co && nm.toLowerCase().indexOf(co.toLowerCase()) < 0) nm = nm ? nm + ' and ' + co : co;
    S.names = nm; if (w.email) S.email = String(w.email).toLowerCase(); if (w.phone) S.phone = w.phone; if (w.user_id) S.user_id = w.user_id;
    if (w.offer_price) S.price = Math.round(w.offer_price);
    var lk = String(w.loan_type || '').toLowerCase();
    if (w.financing === 'cash') S.loan = 'cash'; else if (LOAN[lk]) S.loan = lk;
    if (w.financing !== 'cash' && w.down_payment) { var m = String(w.down_payment).match(/([0-9.]+)\s*%/); if (m) S.down = m[1]; }
    if (w.earnest) S.earnest = Math.round(w.earnest);
    if (w.option_days) S.odays = +w.option_days;
    if (w.close_date) S.close = String(w.close_date).slice(0, 10);
    var extra = [w.lender ? 'Lender: ' + w.lender : '', (w.contingencies || []).length ? 'Client asked for: ' + w.contingencies.join(', ') : '', w.notes ? 'Client notes: ' + w.notes : ''].filter(Boolean).join('\n');
    if (extra && !S.note) S.note = extra;
  }
  function setPrice(n) {
    S.price = n; me(money(n) + (S.list && n !== S.list ? ' (' + (n < S.list ? Math.round((1 - n / S.list) * 1000) / 10 + '% under list' : 'over list') + ')' : ''), 'price');
    next('price');
  }

  /* ---------------- review + send ---------------- */
  function rows() {
    var P = price(), F = S.F || {};
    return [
      ['home', 'House', S.home + (S.mls ? ' · MLS ' + S.mls : '')],
      S.manual ? ['la', 'Listing agent', S.la || '<TC will find>'] : ['home', 'Listing agent', F.listing_agent || '<TC will find>'],
      ['buyer', 'Buyer', S.names || '<missing>'],
      ['contact', 'Contact', [S.email, S.phone ? phone(S.phone) : ''].filter(Boolean).join(' · ') || '<TC will ask you>'],
      ['price', 'Offer', P ? money(P) + (S.list && P !== S.list ? ' (list ' + money(S.list) + ')' : '') : '<missing>'],
      ['loan', 'Loan', S.loan ? LOAN[S.loan] + (S.loan !== 'cash' && S.down != null ? ' · ' + S.down + '% down' : '') : '<missing>'],
      ['conc', 'Seller help', S.conc ? money(S.conc) : 'None'],
      ['earnest', 'Earnest money', S.earnest ? money(S.earnest) : '<missing>'],
      ['option', 'Option', S.ofee != null ? money(S.ofee) + ' · ' + S.odays + ' days' : '<missing>'],
      ['close', 'Closing', S.close ? nice(S.close) : '<missing>'],
      ['title', 'Title', S.title || '<TC asks the listing agent>'],
      ['warranty', 'Home warranty', S.warranty ? money(S.warranty) : 'None'],
      ['note', 'Notes', S.note || 'None'],
    ];
  }
  function review() {
    her('Here\'s your offer. Tap any line to fix it, then send it to Katherine and the TC.');
    var R = rows(), box = herBlock('<div class="lo-rev"><h4>' + esc(S.home) + '</h4>' + R.map(function (r, i) {
      var v = String(r[2]), soft = /^<.*>$/.test(v); return '<button type="button" data-rv="' + i + '"><span>' + esc(r[1]) + '</span><b>' + (soft ? '<em>' + esc(v.slice(1, -1)) + '</em>' : esc(v)) + '</b></button>'; }).join('') + '</div>');
    box.querySelectorAll('[data-rv]').forEach(function (b) { b.onclick = function () { var r = R[+b.getAttribute('data-rv')]; if (r[0] === 'home') { if (confirm('Start over with a different house?')) restart(); } else edit(r[0]); }; });
    var need = !S.names ? 'buyer' : !price() ? 'price' : !S.loan ? 'loan' : '';
    var el = input('<div class="lo-btns"><button type="button" class="lo-send" id="lo-send">Send to Katherine & the TC</button><p class="lo-err" id="lo-err"></p></div>');
    el.querySelector('#lo-send').onclick = function () { if (need) { edit(need); return; } send(this); };
  }
  function terms() {
    var F = S.F || {}, P = price(), t = {
      city: F.city, zip: F.zip, county: F.county, year_built: F.year_built, lot: F.lot, block: F.block, addition: F.addition,
      hoa: F.hoa, hoa_name: F.hoa_name, hoa_phone: F.hoa_phone, district_notices: F.district_notices,
      listing_agent: F.listing_agent, listing_firm: F.listing_firm, listing_agent_phone: F.listing_agent_phone,
      listing_agent_email: F.listing_agent_email, listing_agent_address: F.listing_agent_address,
      buyer_names: S.names, buyer_email: S.email, buyer_phone: S.phone ? phone(S.phone) : '',
      sales_price: P ? String(P) : '', loan_type: S.loan, down_payment: S.loan === 'cash' || S.down == null ? '' : S.down + '%',
      seller_concession: S.conc ? String(S.conc) : '', earnest_money: S.earnest ? String(S.earnest) : '',
      option_fee: S.ofee != null ? String(S.ofee) : '', option_days: S.odays != null ? String(S.odays) : '',
      closing_date: S.close, service_contract: S.warranty != null ? String(S.warranty) : '',
      list_price: S.list ? String(S.list) : '', days_on_market: S.dom ? String(S.dom) : '',
    };
    Object.keys(t).forEach(function (k) { if (t[k] === '' || t[k] == null) delete t[k]; });
    t.title_company = S.title || ''; // empty on purpose: the TC asks the listing agent (it shows under "Still needed")
    return t;
  }
  function send(btn) {
    if (sending) return; sending = true; btn.disabled = true; btn.textContent = 'Sending…';
    var notes = [S.note, S.manual && S.la ? 'Listing agent (from the showing agent): ' + S.la : '', S.manual ? 'Not found on HAR, so the listing details need to be looked up.' : ''].filter(Boolean).join('\n');
    rpc('jag_lola_offer', { p: { address: S.home, mls: S.mls || '', client: S.names, terms: terms(), note: notes || null } })
      .then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.reason) || 'fail');
        sending = false; ls(null); var who = (r.to || []).length ? listNames(r.to) : 'Katherine and the TC';
        me('Send it');
        typing(500).then(function () {
          her(r.tc_ok === false ? 'I saved the offer, but the email didn\'t go out. Text Jason so he can send it.' :
            'Sent! 🎉 ' + who + ' have it. They\'ll email the listing agent for the title info and get it ready in SkySlope for signatures. You\'re copied on the email.');
          var el = input('<div class="lo-btns"><a class="lo-sub" href="' + esc(r.link) + '" target="_blank" rel="noopener">Open the offer draft</a>' +
            '<button type="button" class="lo-send" id="lo-again">Another offer</button><button type="button" class="lo-sub" id="lo-done">Close</button></div>');
          el.querySelector('#lo-again').onclick = restart; el.querySelector('#lo-done').onclick = close;
          if (typeof JagLolaOffer.onSent === 'function') try { JagLolaOffer.onSent(r); } catch (e) { /* fine */ }
        });
      })
      .catch(function (e) {
        sending = false; btn.disabled = false; btn.textContent = 'Send to Katherine & the TC';
        var er = ov.querySelector('#lo-err'); if (er) er.textContent = /signin/.test(String(e && e.message)) ? 'Your sign-in ran out. Sign in again; your answers are saved.' : 'That didn\'t go through. Check your internet and tap Send again.';
      });
  }
  function listNames(a) { a = a.slice().sort(function (x, y) { return (x === 'the TC') - (y === 'the TC'); }); return a.length > 1 ? a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1] : a[0]; }

  /* ---------------- open / close ---------------- */
  function shell() {
    css();
    if (!ov) {
      ov = document.createElement('div'); ov.className = 'lo-ov'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-label', 'Tell Lola about an offer');
      document.body.appendChild(ov);
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && ov.classList.contains('on')) { e.stopPropagation(); close(); } }, true);
    }
    ov.innerHTML = '<div class="lo-m"><div class="lo-hd"><span class="lo-av">' + LOLA + '</span><div class="who"><b>Lola</b><small>Offers to Katherine & the TC</small></div>' +
      '<button type="button" class="lo-x" id="lo-x" aria-label="Close">×</button></div><div class="lo-log" id="lo-log" aria-live="polite"></div><div class="lo-in" id="lo-in"></div></div>';
    ov.querySelector('#lo-x').onclick = close;
    log().addEventListener('click', function (e) { var b = e.target.closest('[data-ed]'); if (b) edit(b.getAttribute('data-ed')); });
    ov.classList.add('on'); document.documentElement.style.overflow = 'hidden';
  }
  function restart() { S = { ofee: null, odays: null }; back = null; ls(null); shell(); her('Ooh, an offer! 💅 Let\'s get it to Katherine and the TC.'); go('home'); }
  function open() {
    shell(); back = null; sending = false;
    var saved = ls();
    if (saved && saved.S && saved.S.home && Date.now() - saved.at < 3 * 86400000 && saved.step) {
      her('We were working on an offer for ' + saved.S.home + (saved.S.names ? ' (' + saved.S.names + ')' : '') + '. Pick up where we left off?');
      var el = input(chipsHtml([{ label: 'Yes, keep going', pri: true }, { label: 'Start a new one' }]));
      el.querySelector('[data-c="0"]').onclick = function () { S = saved.S; me('Yes, keep going'); if (saved.step === 'home') next('home'); else go(saved.step); };
      el.querySelector('[data-c="1"]').onclick = function () { me('Start a new one'); restart(); };
      return;
    }
    S = { ofee: null, odays: null };
    her('Ooh, an offer! 💅 Let\'s get it to Katherine and the TC.');
    go('home');
  }
  function close() { if (!ov) return; ov.classList.remove('on'); ov.innerHTML = ''; document.documentElement.style.overflow = ''; }

  /* ---------------- Agent Hub: the card + "Sent to the TC" ---------------- */
  function cta() {
    css();
    return '<div class="lo-cta"><span class="lo-av">' + LOLA + '</span><div class="t"><b>Tell Lola about an offer</b><span>Your client wants to make an offer? Lola asks the questions, pulls the listing from HAR, and emails Katherine and the TC.</span></div>' +
      '<button type="button" data-lola-offer>Start</button></div>';
  }
  function ago(isoS) { var m = (Date.now() - new Date(isoS).getTime()) / 60000; if (m < 2) return 'just now'; if (m < 60) return Math.floor(m) + ' min ago'; if (m < 1440) return Math.floor(m / 60) + ' h ago'; return new Date(isoS).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
  function mine(el) {
    if (!el) return Promise.resolve();
    return rpc('jag_tc_mine').then(function (j) {
      var R = (j && j.rows) || [];
      el.innerHTML = R.length ? '<div class="lo-mine"><h3>Sent to the TC</h3>' + R.slice(0, 6).map(function (r) {
        var st = r.sent_at ? '<span class="st ok">✓ Emailed</span>' : r.failed ? '<span class="st bad">Didn\'t send, tell Jason</span>' : '<span class="st">Sending…</span>';
        return '<div class="lo-sent"><div class="t"><b>' + esc(r.property) + '</b><small>' + esc([r.client, money(r.price), ago(r.created_at)].filter(Boolean).join(' · ')) + '</small></div>' + st +
          (r.link ? '<a href="' + esc(r.link) + '" target="_blank" rel="noopener">Draft</a>' : '') + '</div>';
      }).join('') + '</div>' : '';
    }).catch(function () { el.innerHTML = ''; });
  }
  document.addEventListener('click', function (e) { var b = e.target.closest && e.target.closest('[data-lola-offer]'); if (b) { e.preventDefault(); open(); } });

  window.JagLolaOffer = { open: open, close: close, cta: cta, mine: mine, onSent: null };
})();
