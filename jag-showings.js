/* ============================================================
   JAG Agent Hub: showings.
   - Showings tab (showing agents + leads): tours clients asked for in their app. Mark each home Asked / Confirmed /
     Not available, set times, reorder, add homes, then "Send schedule" (texts + emails the client). Feedback from the
     tour page shows on each home; 🔥 = the client loved it.
   - Hand-off (leads / admins): send a client to a showing agent (Lola texts the agent, FUB gets a tag + task).
   - Client offers waiting for an OK (people with the Offer OK job): one tap lets René send it for signatures.
   Needs window.JagShowings.init({ rpc, me, isLead, onCount }) from agent.html.
   ============================================================ */
(function () {
  var cfg = null, data = null, all = false, busy = {}, toastT = null;
  var API = (window.JAG_CRM ? window.JAG_CRM.url.replace(/\/+$/, '') : '') + '/functions/v1/home-search';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function money(n) { return n ? '$' + Math.round(n).toLocaleString('en-US') : ''; }
  function digits(p) { return String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); }
  function fmtPhone(p) { var d = digits(p); return d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : p || ''; }
  function dayLbl(d) { var x = new Date(d + 'T12:00:00'); return x.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }); }
  function rel(d) { var t = new Date(); t.setHours(0, 0, 0, 0); var x = new Date(d + 'T00:00:00'), n = Math.round((x - t) / 864e5);
    return n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : n === -1 ? 'Yesterday' : n > 1 && n < 7 ? 'In ' + n + ' days' : ''; }
  function t12(hhmm) { if (!hhmm) return ''; var h = +hhmm.slice(0, 2), m = hhmm.slice(3, 5); return ((h + 11) % 12 + 1) + ':' + m + ' ' + (h < 12 ? 'AM' : 'PM'); }
  var WIN = { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening', any: 'Any time' };
  var WSTART = { morning: '10:00', afternoon: '13:00', evening: '17:00', any: '10:00' };
  var TST = { requested: ['New request', 'r'], scheduling: ['Booking', 'y'], scheduled: ['Schedule sent', 'g'], done: ['Done', ''], cancelled: ['Canceled', ''] };
  var HST = [['asked', 'Asked'], ['confirmed', '✓ Confirmed'], ['declined', '✕ Not available']];
  var LIKE = { yes: 'Could live there', maybe: 'Maybe', no: 'Not for them' };

  var css = '' +
    '.sw-top{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 12px}.sw-top .sp{flex:1}' +
    '.tr{background:#fff;border-radius:18px;padding:16px;margin:0 0 14px;border:2px solid #ebe9e5}.tr.new{border-color:var(--red,#c8102e)}' +
    '.tr-h{display:flex;gap:10px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap}.tr-h b{font-size:17px}.tr-h small{display:block;color:var(--muted,#6a6972);font-size:13px}' +
    '.tr-d{font-weight:800;font-size:15px;margin:8px 0 2px}.tr-d span{color:var(--red,#c8102e)}' +
    '.tr-n{background:var(--card,#f5f5f7);border-radius:12px;padding:8px 12px;font-size:14px;margin:8px 0;white-space:pre-wrap}' +
    '.st{font-size:12px;font-weight:800;border-radius:99px;padding:4px 10px;background:var(--card,#f5f5f7);white-space:nowrap}.st.r{background:var(--red,#c8102e);color:#fff}.st.y{background:#fff4d6;color:#7a5600}.st.g{background:#e9f5ec;color:#1a5c31}' +
    '.hm{border-top:1px solid #ebe9e5;padding:12px 0 4px;display:grid;grid-template-columns:28px 1fr;gap:4px 10px}.hm.off{opacity:.55}' +
    '.hm-n{width:26px;height:26px;border-radius:13px;background:var(--ink,#17161c);color:#fff;font-weight:800;font-size:13px;display:flex;align-items:center;justify-content:center}' +
    '.hm.ok .hm-n{background:#1a5c31}.hm.off .hm-n{background:#b9b8c0}' +
    '.hm-a{font-weight:700;line-height:1.3}.hm-a a{color:inherit}.hm-a small{display:block;font-weight:600;color:var(--muted,#6a6972);font-size:12.5px}' +
    '.hm-c{grid-column:2;display:flex;flex-wrap:wrap;gap:6px;align-items:center}' +
    '.hm-c button,.sw-b{border:2px solid #e3e2e8;background:#fff;border-radius:99px;padding:7px 11px;font:inherit;font-size:13px;font-weight:700;cursor:pointer;color:var(--ink,#17161c)}' +
    '.hm-c button.on{background:var(--ink,#17161c);border-color:var(--ink,#17161c);color:#fff}.hm-c button.on.ok{background:#1a5c31;border-color:#1a5c31}.hm-c button.on.no{background:#8a8992;border-color:#8a8992}' +
    '.hm-c input[type=time]{border:2px solid #e3e2e8;border-radius:10px;padding:6px 8px;font:inherit;font-size:14px;font-weight:700;min-width:118px}' +
    '.hm-c .ar{padding:7px 10px}.hm-c .x{color:var(--muted,#6a6972)}' +
    '.fb{grid-column:2;background:#fdf6e6;border-radius:12px;padding:8px 12px;font-size:13.5px;line-height:1.45}.fb.hot{background:var(--red-t,#fdecef)}.fb b{font-weight:800}' +
    '.hm-o{grid-column:2;font-size:13px;font-weight:800;color:#1a5c31}' +
    '.tr-acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.tr-acts>*{flex:1 1 auto;text-align:center;border:0;border-radius:99px;padding:11px 14px;font:inherit;font-weight:800;font-size:14px;text-decoration:none;background:var(--card,#f5f5f7);color:var(--ink,#17161c);cursor:pointer}' +
    '.tr-acts .go{background:var(--red,#c8102e);color:#fff}.tr-acts .go[disabled]{opacity:.5}.tr-acts .dk{background:var(--ink,#17161c);color:#fff}' +
    '.tr-add{display:flex;gap:6px;margin-top:10px}.tr-add input{flex:1;border:2px solid #e3e2e8;border-radius:12px;padding:9px 12px;font:inherit;font-size:14px;min-width:0}' +
    '.tr-warn{font-size:13px;color:#7a5600;background:#fff4d6;border-radius:10px;padding:8px 12px;margin-top:10px}' +
    '.sw-toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);background:var(--ink,#17161c);color:#fff;border-radius:99px;padding:12px 18px;font-weight:700;font-size:14px;z-index:10060;max-width:92vw;box-shadow:0 8px 30px rgba(0,0,0,.25)}' +
    '.sw-ov{position:fixed;inset:0;background:rgba(15,14,20,.55);z-index:9400;display:flex;align-items:flex-end;justify-content:center}' +
    '@media(min-width:620px){.sw-ov{align-items:center}}' +
    '.sw-box{background:#fff;border-radius:20px 20px 0 0;width:100%;max-width:460px;padding:20px 18px 22px;max-height:88vh;overflow:auto}@media(min-width:620px){.sw-box{border-radius:20px}}' +
    '.sw-box h3{margin:0 0 4px;font-size:19px}.sw-box p{margin:0 0 14px;color:var(--muted,#6a6972);font-size:14px}' +
    '.sw-ag{display:flex;align-items:center;gap:12px;width:100%;border:2px solid #e3e2e8;background:#fff;border-radius:14px;padding:10px 12px;margin:0 0 8px;font:inherit;text-align:left;cursor:pointer}' +
    '.sw-ag.on{border-color:var(--ink,#17161c);background:var(--card,#f5f5f7)}.sw-ag img,.sw-ag i{width:42px;height:42px;border-radius:21px;object-fit:cover;flex:none;background:var(--ink,#17161c);color:#fff;font-style:normal;font-weight:800;display:flex;align-items:center;justify-content:center}' +
    '.sw-ag b{display:block}.sw-ag small{color:var(--muted,#6a6972)}' +
    '.okw{background:#fff;border:2px solid var(--red,#c8102e);border-radius:18px;padding:14px 16px;margin:0 0 14px}.okw h3{margin:0 0 4px;font-size:16px}.okw>p{margin:0 0 10px;color:var(--muted,#6a6972);font-size:13.5px}' +
    '.okr{border-top:1px solid #ebe9e5;padding:10px 0 2px}.okr b{display:block}.okr small{color:var(--muted,#6a6972);display:block;margin:2px 0 8px}';
  function addCss() { if (document.getElementById('sw-css')) return; var s = document.createElement('style'); s.id = 'sw-css'; s.textContent = css; document.head.appendChild(s); }
  function toast(m) { var t = document.querySelector('.sw-toast'); if (!t) { t = document.createElement('div'); t.className = 'sw-toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(function () { t.hidden = true; }, 3200); }

  /* ---------------- the Showings tab ---------------- */
  function el() { return document.getElementById('showings'); }
  function load() {
    if (!cfg || !el()) return Promise.resolve();
    return cfg.rpc('jag_tours_list', { p_all: all }).then(function (j) {
      if (!j || !j.ok) { el().innerHTML = '<div class="empty">Could not load tours.</div>'; return; }
      data = j; paint();
    }).catch(function () { el().innerHTML = '<div class="empty">Could not load tours. Check your connection.</div>'; });
  }
  function paint() {
    var tours = data.tours || [], n = tours.filter(function (t) { return t.status === 'requested'; }).length;
    if (cfg.onCount) cfg.onCount(n);
    var top = '<div class="sw-top"><span class="sp"><b>' + (all ? 'Every tour' : 'Your tours') + '</b></span>' +
      (data.can_all ? '<button type="button" class="chip' + (all ? '' : ' on') + '" data-sw-all="0">Mine</button><button type="button" class="chip' + (all ? ' on' : '') + '" data-sw-all="1">All tours</button>' : '') + '</div>';
    if (!tours.length) {
      el().innerHTML = top + '<div class="empty">No tours yet. When a client you\'re showing homes to picks homes and a day in their app, Lola texts you and it shows up here.</div>';
      return;
    }
    el().innerHTML = top + tours.map(tour).join('');
  }
  function tour(t) {
    var c = t.client || {}, st = TST[t.status] || [t.status, ''], ph = digits(c.phone), first = String(c.name || '').split(' ')[0];
    var hs = (t.homes || []).filter(function (h) { return h.status !== 'removed'; });
    var conf = hs.filter(function (h) { return h.status === 'confirmed'; }), noTime = conf.filter(function (h) { return !h.start_local; }).length;
    var closed = t.status === 'done' || t.status === 'cancelled';
    var h = '<article class="tr' + (t.status === 'requested' ? ' new' : '') + '" data-t="' + t.id + '">' +
      '<div class="tr-h"><div><b>' + esc(c.name || c.email || 'Client') + '</b><small>' + esc(fmtPhone(c.phone)) + (c.lang === 'en' ? ' · English' : ' · Español') +
        (c.proof ? ' · ✓ ' + (c.proof === 'pof' ? 'proof of funds' : 'pre-approved') : ' · pre-approval not verified') + (data.can_all && t.showing_agent !== data.me ? ' · with ' + esc(t.showing_agent || '?') : '') + '</small></div>' +
        '<span class="st ' + st[1] + '">' + esc(st[0]) + '</span></div>' +
      '<div class="tr-d"><span>' + esc(rel(t.date)) + (rel(t.date) ? ' · ' : '') + '</span>' + esc(dayLbl(t.date)) + ' · ' + esc(WIN[t.window] || t.window) + '</div>' +
      (t.note ? '<div class="tr-n">"' + esc(t.note) + '"</div>' : '') +
      hs.map(function (x, i) { return home(t, x, i, hs.length, closed); }).join('') +
      (closed ? '' : '<div class="tr-add"><input type="text" placeholder="Add a home: MLS #" aria-label="Add a home by MLS number" data-addv><button type="button" class="sw-b" data-add>Add</button></div>') +
      (!closed && !c.sms_ok ? '<div class="tr-warn">' + esc(first || 'The client') + ' didn\'t say yes to texts, so the schedule goes by email only. Call them too.</div>' : '') +
      (!closed && noTime ? '<div class="tr-warn">' + noTime + ' confirmed home' + (noTime === 1 ? ' has' : 's have') + ' no time yet.</div>' : '') +
      '<div class="tr-acts">' +
        (closed ? '' : '<button type="button" class="go" data-send' + (conf.length ? '' : ' disabled') + '>' + (t.sent_at ? '🔄 Send the update' : '📲 Send schedule to ' + esc(first || 'client')) + (conf.length ? ' (' + conf.length + ')' : '') + '</button>') +
        (closed ? '' : '<button type="button" data-fill>⏱ Times every 30 min</button>') +
        (ph ? '<a class="dk" href="tel:+1' + ph + '">Call</a><a href="sms:+1' + ph + '">Text</a>' : '') +
        '<a href="tour#' + esc(t.token) + '" target="_blank" rel="noopener">Client\'s page</a>' +
        (closed ? '' : '<button type="button" data-cancel>Cancel tour</button>') +
      '</div>' +
      (t.sent_at ? '<small style="display:block;margin-top:8px;color:var(--muted,#6a6972)">Schedule sent ' + new Date(t.sent_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + (t.sent_count > 1 ? ' (' + t.sent_count + ' times)' : '') + '</small>' : '') +
      '</article>';
    return h;
  }
  function home(t, x, i, n, closed) {
    var s = x.snap || {}, cls = x.status === 'confirmed' ? ' ok' : x.status === 'declined' ? ' off' : '';
    var tm = x.start_local ? x.start_local.slice(11, 16) : '';
    var fb = x.fb, fbh = '';
    if (fb) fbh = '<div class="fb' + (x.hot ? ' hot' : '') + '">' + (x.hot ? '🔥 ' : '💬 ') + (fb.stars ? '<b>' + '★★★★★'.slice(0, fb.stars) + '</b> ' : '') + (fb.live ? '<b>' + esc(LIKE[fb.live] || fb.live) + '</b>' : '') +
      (fb.likes && fb.likes.length ? '<br>👍 ' + esc(fb.likes.join(', ')) : '') + (fb.dislikes && fb.dislikes.length ? '<br>👎 ' + esc(fb.dislikes.join(', ')) : '') + (fb.note ? '<br>"' + esc(fb.note) + '"' : '') + '</div>';
    return '<div class="hm' + cls + '" data-h="' + x.id + '"><span class="hm-n">' + (i + 1) + '</span>' +
      '<div class="hm-a">' + (x.mls ? '<a href="homes#' + encodeURIComponent(x.mls) + '" target="_blank" rel="noopener">' : '') + esc(s.addr || 'MLS ' + x.mls) + (x.mls ? '</a>' : '') +
        '<small>' + esc([s.city, money(s.price), x.mls ? 'MLS ' + x.mls : ''].filter(Boolean).join(' · ')) + (tm && x.status === 'confirmed' ? ' · <b style="color:#1a5c31">' + t12(tm) + '</b>' : '') + '</small></div>' +
      (closed ? '' : '<div class="hm-c">' + HST.map(function (b) { return '<button type="button" data-hs="' + b[0] + '" class="' + (x.status === b[0] ? 'on ' : '') + (b[0] === 'confirmed' ? 'ok' : b[0] === 'declined' ? 'no' : '') + '" aria-pressed="' + (x.status === b[0]) + '">' + b[1] + '</button>'; }).join('') +
        '<input type="time" step="900" value="' + esc(tm) + '" data-tm aria-label="Showing time for ' + esc(s.addr || x.mls) + '">' +
        (i > 0 ? '<button type="button" class="ar" data-mv="-1" aria-label="Move up">↑</button>' : '') + (i < n - 1 ? '<button type="button" class="ar" data-mv="1" aria-label="Move down">↓</button>' : '') +
        '<button type="button" class="x" data-hs="removed" aria-label="Remove from the tour">Remove</button></div>') +
      (x.agent_note ? '<div class="fb" style="background:var(--card,#f5f5f7)">📝 ' + esc(x.agent_note) + '</div>' : '') + fbh +
      (x.offer ? '<div class="hm-o">📝 Offer ' + money(x.offer.price) + ' · ' + esc(x.offer.status || '') + '</div>' : '') + '</div>';
  }
  function tourOf(id) { return (data.tours || []).filter(function (t) { return String(t.id) === String(id); })[0]; }
  function setHome(id, p) {
    return cfg.rpc('jag_tour_home_set', { p_id: +id, p: p }).then(function (j) { if (!j || !j.ok) throw new Error('no'); });
  }
  function onClick(e) {
    var b = e.target.closest('[data-sw-all]'); if (b) { all = b.getAttribute('data-sw-all') === '1'; load(); return; }
    var art = e.target.closest('.tr'); if (!art) return;
    var t = tourOf(art.getAttribute('data-t')); if (!t || busy[t.id]) return;
    var hm = e.target.closest('.hm'), hid = hm && hm.getAttribute('data-h');
    var hs = e.target.closest('[data-hs]');
    if (hs && hid) {
      var v = hs.getAttribute('data-hs'), x = t.homes.filter(function (y) { return String(y.id) === hid; })[0];
      if (v === 'removed' && !confirm('Remove ' + ((x && x.snap && x.snap.addr) || 'this home') + ' from the tour?')) return;
      if (x && x.status === v && v !== 'removed') v = 'requested';
      busy[t.id] = 1; setHome(hid, { status: v }).then(function () { busy[t.id] = 0; load(); }).catch(function () { busy[t.id] = 0; toast('Could not save. Try again.'); });
      return;
    }
    var mv = e.target.closest('[data-mv]');
    if (mv && hid) {
      var list = t.homes.filter(function (y) { return y.status !== 'removed'; }).map(function (y) { return y.id; }), i = list.indexOf(+hid), j = i + (+mv.getAttribute('data-mv'));
      if (i < 0 || j < 0 || j >= list.length) return;
      list.splice(j, 0, list.splice(i, 1)[0]);
      busy[t.id] = 1; cfg.rpc('jag_tour_order', { p_tour: t.id, p_ids: list }).then(function () { busy[t.id] = 0; load(); }).catch(function () { busy[t.id] = 0; toast('Could not move it.'); });
      return;
    }
    if (e.target.closest('[data-add]')) { addHome(t, art.querySelector('[data-addv]')); return; }
    if (e.target.closest('[data-fill]')) { fillTimes(t); return; }
    if (e.target.closest('[data-send]')) { send(t, e.target.closest('[data-send]')); return; }
    if (e.target.closest('[data-cancel]')) {
      if (!confirm('Cancel this tour?' + (t.sent_at ? ' The client gets a text that it was canceled.' : ''))) return;
      busy[t.id] = 1; cfg.rpc('jag_tour_cancel', { p_tour: t.id }).then(function () { busy[t.id] = 0; toast('Tour canceled.'); load(); }).catch(function () { busy[t.id] = 0; toast('Could not cancel.'); });
    }
  }
  function onChange(e) {
    var tm = e.target.closest('[data-tm]'); if (!tm) return;
    var art = tm.closest('.tr'), t = tourOf(art.getAttribute('data-t')), hid = tm.closest('.hm').getAttribute('data-h');
    var x = t.homes.filter(function (y) { return String(y.id) === hid; })[0];
    var p = { start: tm.value ? t.date + 'T' + tm.value : '' };
    if (tm.value && x && x.status !== 'confirmed' && x.status !== 'declined') p.status = 'confirmed'; // a time = it's booked
    setHome(hid, p).then(function () { load(); }).catch(function () { toast('Could not save the time.'); });
  }
  function addHome(t, inp) {
    var v = String(inp.value || '').trim(), m = (v.match(/#([A-Za-z0-9-]{3,24})\s*$/) || [])[1] || (/^[A-Za-z0-9-]{3,24}$/.test(v) ? v : '');
    if (!m) { toast('Type the MLS number.'); inp.focus(); return; }
    busy[t.id] = 1;
    fetch(API + '?detail=1&mlsNumber=' + encodeURIComponent(m)).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }).then(function (j) {
      var l = j && j.listings && j.listings[0], a = (l && l.address) || {};
      var p = { mls: m };
      if (l) { p.addr = [a.streetNumber, a.streetDirectionPrefix, a.streetName, a.streetSuffix, a.streetDirection].filter(Boolean).join(' ') + (a.unitNumber ? ' #' + a.unitNumber : '');
        p.city = a.city; p.zip = a.zip; p.price = l.listPrice; p.photo = (l.images || [])[0]; }
      return cfg.rpc('jag_tour_home_add', { p_tour: t.id, p: p }).then(function (r) {
        busy[t.id] = 0; if (!r || !r.ok) throw new Error('no'); toast(l ? 'Added ' + p.addr + '.' : 'Added MLS ' + m + ' (couldn\'t look up the address).'); load(); });
    }).catch(function () { busy[t.id] = 0; toast('Could not add it.'); });
  }
  function fillTimes(t) {
    var hs = t.homes.filter(function (y) { return y.status !== 'removed' && y.status !== 'declined'; });
    if (!hs.length) return;
    var first = hs[0].start_local ? hs[0].start_local.slice(11, 16) : (prompt('Time of the first showing (like 1:00 PM)?', t12(WSTART[t.window] || '10:00')) || '');
    if (!first) return;
    var mm = String(first).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])?/i); if (!mm) { toast('Type a time like 1:00 PM.'); return; }
    var h = +mm[1] % 12 + (mm[3] && /p/i.test(mm[3]) ? 12 : (!mm[3] && +mm[1] < 8 ? 12 : 0)); if (!mm[3] && +mm[1] >= 13) h = +mm[1];
    var mins = h * 60 + (+mm[2] || 0);
    busy[t.id] = 1;
    hs.reduce(function (pr, y, i) {
      var v = mins + i * 30, s = ('0' + Math.floor(v / 60)).slice(-2) + ':' + ('0' + v % 60).slice(-2);
      return pr.then(function () { return setHome(y.id, { start: t.date + 'T' + s }); });
    }, Promise.resolve()).then(function () { busy[t.id] = 0; toast('Times set every 30 minutes, starting ' + t12(('0' + Math.floor(mins / 60)).slice(-2) + ':' + ('0' + mins % 60).slice(-2)) + '.'); load(); })
      .catch(function () { busy[t.id] = 0; toast('Could not set all the times.'); load(); });
  }
  function send(t, btn) {
    var conf = t.homes.filter(function (y) { return y.status === 'confirmed'; });
    var first = String((t.client || {}).name || '').split(' ')[0] || 'the client';
    var lines = conf.slice().sort(function (a, b) { return String(a.start_local || '9').localeCompare(String(b.start_local || '9')); })
      .map(function (y) { return (y.start_local ? t12(y.start_local.slice(11, 16)) + '  ' : '') + ((y.snap || {}).addr || 'MLS ' + y.mls); }).join('\n');
    if (!confirm((t.sent_at ? 'Send the updated schedule to ' : 'Send the schedule to ') + first + '?\n\n' + lines + '\n\n' + ((t.client || {}).sms_ok ? 'Lola texts it from the JAG line and it goes by email.' : 'It goes by email (no text: they didn\'t say yes to texts).'))) return;
    btn.disabled = true; busy[t.id] = 1;
    cfg.rpc('jag_tour_send', { p_tour: t.id }).then(function (j) {
      busy[t.id] = 0;
      if (!j || !j.ok) { btn.disabled = false; toast(j && j.reason === 'none_confirmed' ? 'Confirm at least one home first.' : 'Could not send it. Try again.'); return; }
      toast('✓ Sent to ' + first + (j.texted ? ' by text and email.' : ' by email.')); load();
    }).catch(function () { busy[t.id] = 0; btn.disabled = false; toast('Could not send it. Try again.'); });
  }

  /* ---------------- hand-off: send a client to a showing agent ---------------- */
  function handoff(c, done) {
    addCss();
    var ov = document.createElement('div'); ov.className = 'sw-ov';
    ov.innerHTML = '<div class="sw-box" role="dialog" aria-modal="true" aria-label="Send to a showing agent"><h3>👟 Send ' + esc(String(c.name || 'this client').split(' ')[0]) + ' for showings</h3>' +
      '<p>The showing agent gets a text from Lola and the client shows up in their Showings tab. ' + esc(String(c.name || 'The client').split(' ')[0]) + ' can then pick homes and a day in their app.</p><div data-ags>Loading…</div>' +
      '<button type="button" class="sw-b" data-x style="width:100%;margin-top:6px">Close</button></div>';
    document.body.appendChild(ov);
    function close() { ov.remove(); }
    ov.addEventListener('click', function (e) {
      if (e.target === ov || e.target.closest('[data-x]')) { close(); return; }
      var a = e.target.closest('[data-ag]'); if (!a) return;
      var code = a.getAttribute('data-ag'), name = a.getAttribute('data-n');
      ov.querySelectorAll('[data-ag]').forEach(function (x) { x.disabled = true; });
      cfg.rpc('jag_client_set_showing', { p_user: c.user_id, p_code: code || null }).then(function (j) {
        if (!j || !j.ok) { toast(j && j.reason === 'not_allowed' ? 'Only leads and admins can do this.' : 'Could not save. Try again.'); ov.querySelectorAll('[data-ag]').forEach(function (x) { x.disabled = false; }); return; }
        close(); toast(code ? '✓ Sent to ' + name + '. Lola is texting her now.' : 'Showing agent removed.'); if (done) done(j.showing_agent_code || null);
      }).catch(function () { toast('Could not save. Try again.'); ov.querySelectorAll('[data-ag]').forEach(function (x) { x.disabled = false; }); });
    });
    cfg.rpc('jag_showing_agents').then(function (j) {
      var ags = (j && j.agents) || [], box = ov.querySelector('[data-ags]');
      if (!ags.length) { box.innerHTML = '<p>No one has the <b>Showing</b> job yet. Jason can add it in Admin → Team access.</p>'; return; }
      box.innerHTML = ags.map(function (a) {
        var on = a.code === c.showing_agent_code;
        return '<button type="button" class="sw-ag' + (on ? ' on' : '') + '" data-ag="' + esc(a.code) + '" data-n="' + esc(a.first_name || a.name) + '">' +
          (a.photo_url ? '<img src="' + esc(a.photo_url) + '" alt="">' : '<i>' + esc(String(a.name || '?').charAt(0)) + '</i>') +
          '<span><b>' + esc(a.name) + (on ? ' ✓' : '') + '</b><small>' + (a.clients || 0) + ' client' + (a.clients === 1 ? '' : 's') + ' for showings</small></span></button>';
      }).join('') + (c.showing_agent_code ? '<button type="button" class="sw-b" data-ag="" data-n="" style="width:100%">Remove the showing agent</button>' : '');
    }).catch(function () { ov.querySelector('[data-ags]').innerHTML = '<p>Could not load the showing agents.</p>'; });
  }

  /* ---------------- client offers waiting for an OK ---------------- */
  function waiting(box) {
    if (!box || !cfg) return;
    cfg.rpc('jag_tc_waiting').then(function (j) {
      var rows = (j && j.ok && j.can && j.rows) || [];
      if (!rows.length) { box.innerHTML = ''; return; }
      addCss();
      box.innerHTML = '<div class="okw"><h3>⏸ Client offers waiting for your OK (' + rows.length + ')</h3><p>Clients sent these from their tour page. René is preparing them; he can\'t send them for signatures until you OK. You can also reply <b>OK &lt;number&gt;</b> to Lola\'s text.</p>' +
        rows.map(function (r) {
          return '<div class="okr" data-ok="' + r.id + '"><b>#' + r.id + ' · ' + esc(r.property) + '</b><small>' + esc([r.client, r.line].filter(Boolean).join(' · ')) + '</small>' +
            '<div class="tr-acts" style="margin-top:0"><button type="button" class="go" data-okgo>✅ OK, René can send it</button><a href="' + esc(r.checklist) + '" target="_blank" rel="noopener">René\'s checklist</a>' +
            (r.link ? '<a href="' + esc(r.link) + '" target="_blank" rel="noopener">Offer draft</a>' : '') + '</div></div>';
        }).join('') + '</div>';
    }).catch(function () { box.innerHTML = ''; });
    if (!box._sw) {
      box._sw = 1;
      box.addEventListener('click', function (e) {
        var b = e.target.closest('[data-okgo]'); if (!b) return;
        var id = +b.closest('[data-ok]').getAttribute('data-ok'); b.disabled = true; b.textContent = 'Saving…';
        cfg.rpc('jag_tc_ok', { p_id: id }).then(function (j) {
          toast(j && j.reply ? String(j.reply).replace(/\s*- Lola$/, '') : 'Could not save.');
          if (j && j.ok) waiting(box); else { b.disabled = false; b.textContent = '✅ OK, René can send it'; }
        }).catch(function () { b.disabled = false; b.textContent = '✅ OK, René can send it'; toast('Could not save. Try again.'); });
      });
    }
  }

  window.JagShowings = {
    init: function (o) {
      cfg = o; addCss();
      var e = el();
      if (e && !e._sw) { e._sw = 1; e.addEventListener('click', onClick); e.addEventListener('change', onChange);
        e.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && ev.target.matches('[data-addv]')) { ev.preventDefault(); var b = ev.target.parentNode.querySelector('[data-add]'); if (b) b.click(); } }); }
    },
    load: load, handoff: handoff, waiting: waiting
  };
})();
