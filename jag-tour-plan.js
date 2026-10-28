/* ============================================================
   JAG client account: plan a home tour with the showing agent.
   Shows only for clients the team sent to a showing agent (jag_clients.showing_agent_code).
     JagTourPlan.load()      → Promise; fetches jag_my_tours (agent, tours, saved homes)
     JagTourPlan.card()      → HTML for the "Plan my tour" card ('' when no showing agent)
     JagTourPlan.bind(el, onDone) → wires the card's buttons
   The request goes to jag_tour_request(); Lola texts the showing agent the list of homes.
   ============================================================ */
(function () {
  var CDN = 'https://cdn.repliers.io/', D = null, MAXH = 10;
  function A() { return window.JagAccount; }
  function lang() { try { return localStorage.getItem('jag_lang') === 'en' ? 'en' : 'es'; } catch (e) { return 'es'; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function digits(p) { return String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); }
  function fmtPhone(p) { var d = digits(p); return d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : ''; }
  function money(n) { return n ? '$' + Math.round(n).toLocaleString('en-US') : ''; }
  function photo(p) { return !p ? '' : /^https?:/.test(p) ? p : CDN + p + '?class=small'; }
  function fill(s, o) { return String(s).replace(/\{(\w)\}/g, function (_, k) { return o[k] == null ? '' : o[k]; }); }
  var T = {
    es: { badge: 'Recorrido de casas', with_: 'Con {a}, su agente de recorridos',
      p: 'Elija las casas que quiere ver y el día. {a} pide las citas y le confirma las horas por texto.',
      plan: '🗓️ Planear mi recorrido', call: 'Llamar', yours: 'Sus recorridos', see: 'Ver',
      st: { requested: 'Enviado a {a}', scheduling: '{a} está agendando', scheduled: 'Confirmado', done: 'Terminado', cancelled: 'Cancelado' },
      h1: '¿Qué casas quiere ver?', h1p: 'De sus casas guardadas. Hasta 10.', none: 'Todavía no tiene casas guardadas. Toque el ❤ en las casas que le gusten y regrese aquí.',
      search: 'Buscar casas', h2: '¿Qué día?', h3: '¿A qué hora más o menos?', win: { morning: 'En la mañana', afternoon: 'En la tarde', evening: 'En la noche', any: 'Cualquier hora' },
      note: 'Algo que {a} deba saber (opcional)', note_ph: 'Ej.: vamos con niños, salgo del trabajo a las 4…',
      phone: 'Su celular', sms: 'Sí, quiero recibir textos de JAG Real Estate sobre mis recorridos y ofertas a este número. La frecuencia varía. Pueden aplicar tarifas de mensajes y datos. Responda STOP para salir o HELP para ayuda.',
      sms_need: 'Sin textos le avisamos por correo.', next: 'Siguiente', back: 'Atrás', send: 'Enviar a {a}', sending: 'Enviando…', close: 'Cerrar', today: 'Hoy', tom: 'Mañana',
      pick1: 'Elija al menos una casa.', pickd: 'Elija un día.', badph: 'Escriba un celular de 10 dígitos o quite la marca de textos.',
      ok_h: '¡Listo! 🎉', ok_p: '{a} ya tiene su lista de {n} casa(s) para el {d}. Va a pedir las citas y le confirma las horas{s}.', ok_sms: ' por texto y correo', ok_mail: ' por correo',
      err: 'No pudimos enviarlo. Intente de nuevo o llame a {a}.', too_many: 'Ya tiene recorridos pendientes. {a} le contacta pronto.', homes: '{n} casa(s)', sel: '{n} de 10' },
    en: { badge: 'Home tour', with_: 'With {a}, your showing agent',
      p: 'Pick the homes you want to see and the day. {a} books the showings and texts you the times.',
      plan: '🗓️ Plan my tour', call: 'Call', yours: 'Your tours', see: 'View',
      st: { requested: 'Sent to {a}', scheduling: '{a} is booking it', scheduled: 'Confirmed', done: 'Done', cancelled: 'Canceled' },
      h1: 'Which homes do you want to see?', h1p: 'From your saved homes. Up to 10.', none: 'You have no saved homes yet. Tap the ❤ on homes you like, then come back here.',
      search: 'Search homes', h2: 'Which day?', h3: 'Around what time?', win: { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening', any: 'Any time' },
      note: 'Anything {a} should know (optional)', note_ph: 'E.g. kids are coming, I get off work at 4…',
      phone: 'Your cell', sms: 'Yes, text me from JAG Real Estate about my tours and offers at this number. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out or HELP for help.',
      sms_need: 'Without texts we\'ll email you.', next: 'Next', back: 'Back', send: 'Send to {a}', sending: 'Sending…', close: 'Close', today: 'Today', tom: 'Tomorrow',
      pick1: 'Pick at least one home.', pickd: 'Pick a day.', badph: 'Type a 10-digit cell, or uncheck texts.',
      ok_h: 'Done! 🎉', ok_p: '{a} has your list of {n} home(s) for {d}. They\'ll book the showings and confirm the times{s}.', ok_sms: ' by text and email', ok_mail: ' by email',
      err: 'We couldn\'t send it. Try again or call {a}.', too_many: 'You already have tours pending. {a} will reach out soon.', homes: '{n} home(s)', sel: '{n} of 10' }
  };
  function t(k) { return (T[lang()] || T.es)[k]; }
  function aName() { var a = D && D.showing; return a ? (a.first_name || String(a.name || '').split(' ')[0]) : 'JAG'; }
  function dayLbl(d) { var x = typeof d === 'string' ? new Date(d + 'T12:00:00') : d; return x.toLocaleDateString(lang() === 'es' ? 'es-MX' : 'en-US', { weekday: 'long', month: 'long', day: 'numeric' }); }
  function iso(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }

  var css = '.tp{border:2px solid var(--ink,#17161c);border-radius:18px;padding:18px;margin:0 0 18px;background:#fff}' +
    '.tp-b{display:inline-block;font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#c8102e;margin-bottom:8px}' +
    '.tp-a{display:flex;gap:12px;align-items:center;margin-bottom:8px}.tp-a img,.tp-a i{width:50px;height:50px;border-radius:25px;object-fit:cover;flex:none;background:#17161c;color:#fff;font-style:normal;font-weight:800;display:flex;align-items:center;justify-content:center;font-size:19px}' +
    '.tp-a b{display:block;font-size:17px}.tp-a small{color:var(--muted,#6a6972);font-size:13px}.tp>p{margin:0 0 12px;color:var(--muted,#6a6972);font-size:14.5px}' +
    '.tp-r{display:flex;gap:8px;flex-wrap:wrap}.tp-r>*{flex:1 1 auto;text-align:center;border:0;border-radius:99px;padding:13px 16px;font:inherit;font-weight:800;font-size:15px;cursor:pointer;text-decoration:none;background:#f5f5f7;color:#17161c}.tp-r .go{background:#c8102e;color:#fff}' +
    '.tp-l{margin-top:14px;border-top:1px solid #ebe9e5;padding-top:10px}.tp-l h4{margin:0 0 6px;font-size:14px}.tp-t{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:8px 0;font-size:14px;border-bottom:1px solid #f0eff3}.tp-t:last-child{border:0}' +
    '.tp-t b{display:block}.tp-t small{color:var(--muted,#6a6972)}.tp-t a{font-weight:800;color:#c8102e;white-space:nowrap}.tp-s{font-size:12px;font-weight:800;border-radius:99px;padding:3px 9px;background:#f5f5f7;white-space:nowrap}.tp-s.g{background:#e9f5ec;color:#1a5c31}' +
    '.tpm{position:fixed;inset:0;background:rgba(15,14,20,.55);z-index:10050;display:flex;align-items:flex-end;justify-content:center}@media(min-width:640px){.tpm{align-items:center}}' +
    '.tpx{background:#fff;border-radius:22px 22px 0 0;width:100%;max-width:520px;max-height:92vh;display:flex;flex-direction:column}@media(min-width:640px){.tpx{border-radius:22px}}' +
    '.tpx-h{display:flex;justify-content:space-between;align-items:center;padding:16px 18px 6px}.tpx-h b{font-size:19px}.tpx-h button{border:0;background:none;font-size:28px;line-height:1;color:#6a6972;cursor:pointer;padding:4px 8px}' +
    '.tpx-b{overflow:auto;padding:4px 18px 10px;flex:1}.tpx-b>p{margin:0 0 12px;color:#6a6972;font-size:14px}' +
    '.tpx-f{padding:12px 18px 18px;display:flex;gap:8px;border-top:1px solid #ebe9e5}.tpx-f button{flex:1;border:0;border-radius:99px;padding:14px;font:inherit;font-weight:800;font-size:15.5px;cursor:pointer;background:#f5f5f7;color:#17161c}.tpx-f .go{background:#c8102e;color:#fff}.tpx-f .go[disabled]{opacity:.6}' +
    '.tph{display:flex;gap:10px;align-items:center;border:2px solid #e3e2e8;border-radius:14px;padding:8px;margin:0 0 8px;cursor:pointer;background:#fff;width:100%;font:inherit;text-align:left}' +
    '.tph.on{border-color:#c8102e;background:#fdecef}.tph img,.tph .ni{width:64px;height:48px;border-radius:9px;object-fit:cover;flex:none;background:#ebe9e5}' +
    '.tph b{display:block;font-size:15px}.tph small{color:#6a6972;font-size:13px}.tph .ck{margin-left:auto;width:26px;height:26px;border-radius:13px;border:2px solid #c9c8d0;flex:none;display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff}.tph.on .ck{background:#c8102e;border-color:#c8102e}' +
    '.tpd{display:flex;gap:8px;overflow-x:auto;padding:2px 0 10px;margin:0 0 6px}.tpd button,.tpw button{flex:none;border:2px solid #e3e2e8;background:#fff;border-radius:14px;padding:10px 12px;font:inherit;font-weight:700;font-size:14px;cursor:pointer;text-align:center;color:#17161c}' +
    '.tpd button small{display:block;font-size:11.5px;font-weight:700;color:#6a6972;text-transform:capitalize}.tpd button b{font-size:20px}.tpd .on,.tpw .on{border-color:#c8102e;background:#fdecef}' +
    '.tpw{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:0 0 14px}' +
    '.tpx label.l{display:block;font-weight:800;font-size:14px;margin:12px 0 6px}.tpx textarea,.tpx input[type=tel]{width:100%;border:2px solid #e3e2e8;border-radius:12px;padding:11px 12px;font:inherit;font-size:16px;box-sizing:border-box}' +
    '.tpc{display:flex;gap:10px;align-items:flex-start;font-size:12.5px;line-height:1.45;color:#4a4952;margin:10px 0 0;cursor:pointer}.tpc input{width:22px;height:22px;flex:none;margin:1px 0 0;accent-color:#c8102e}' +
    '.tpe{color:#a30d26;font-weight:800;font-size:14px;margin:8px 0 0}.tpok{text-align:center;padding:18px 6px}.tpok b{display:block;font-size:24px;margin-bottom:8px}.tpok p{color:#4a4952;margin:0}';
  function addCss() { if (document.getElementById('tp-css')) return; var s = document.createElement('style'); s.id = 'tp-css'; s.textContent = css; document.head.appendChild(s); }

  function load() {
    var a = A(); if (!a || !a.user()) { D = null; return Promise.resolve(null); }
    return a.rpc('jag_my_tours').then(function (j) { D = j && j.ok ? j : null; return D; }).catch(function () { D = null; return null; });
  }
  function card() {
    if (!D || !D.showing) return '';
    addCss();
    var a = D.showing, ph = digits(a.phone), n = aName();
    var tours = (D.tours || []).filter(function (x) { return x.status !== 'cancelled' || new Date(x.date + 'T23:59:59') > new Date(); }).slice(0, 4);
    return '<div class="tp"><span class="tp-b">' + esc(t('badge')) + '</span>' +
      '<div class="tp-a">' + (a.photo_url ? '<img src="' + esc(a.photo_url) + '" alt="">' : '<i>' + esc(String(a.name || 'J').charAt(0)) + '</i>') +
        '<div><b>' + esc(a.name) + '</b><small>' + esc(fill(t('with_'), { a: n })) + (ph ? ' · ' + fmtPhone(ph) : '') + '</small></div></div>' +
      '<p>' + esc(fill(t('p'), { a: n })) + '</p>' +
      '<div class="tp-r"><button type="button" class="go" data-tp-plan>' + esc(t('plan')) + '</button>' + (ph ? '<a href="tel:+1' + ph + '">' + esc(t('call')) + ' ' + esc(n) + '</a>' : '') + '</div>' +
      (tours.length ? '<div class="tp-l"><h4>' + esc(t('yours')) + '</h4>' + tours.map(function (x) {
        var hs = (x.homes || []).filter(function (h) { return h.status !== 'removed'; });
        return '<div class="tp-t"><div><b>' + esc(dayLbl(x.date)) + '</b><small>' + esc(fill(t('homes'), { n: hs.length })) + '</small></div>' +
          '<span class="tp-s' + (x.status === 'scheduled' ? ' g' : '') + '">' + esc(fill(t('st')[x.status] || x.status, { a: n })) + '</span>' +
          '<a href="tour#' + esc(x.token) + '">' + esc(t('see')) + ' ›</a></div>';
      }).join('') + '</div>' : '') + '</div>';
  }
  function bind(el, onDone) {
    if (!el || el._tp) return; el._tp = 1;
    el.addEventListener('click', function (e) { if (e.target.closest('[data-tp-plan]')) { e.preventDefault(); open(onDone); } });
  }

  /* ---------------- the planner ---------------- */
  function open(onDone) {
    if (!D || !D.showing) return;
    addCss();
    var S = { step: 1, picked: {}, date: '', win: 'any', note: '', phone: digits(D.phone), sms: !!D.sms_ok, busy: false };
    var favs = (D.favorites || []).filter(function (f) { return !/sold|closed|leased|terminated|expired|withdrawn/i.test(f.status || ''); });
    var ov = document.createElement('div'); ov.className = 'tpm';
    ov.innerHTML = '<div class="tpx" role="dialog" aria-modal="true" aria-labelledby="tp-h"><div class="tpx-h"><b id="tp-h"></b><button type="button" data-x aria-label="' + esc(t('close')) + '">×</button></div><div class="tpx-b"></div><div class="tpx-f"></div></div>';
    document.body.appendChild(ov); document.body.style.overflow = 'hidden';
    var H = ov.querySelector('#tp-h'), B = ov.querySelector('.tpx-b'), F = ov.querySelector('.tpx-f');
    function close() { ov.remove(); document.body.style.overflow = ''; }
    function err(m) { var x = B.querySelector('.tpe'); if (!x) { x = document.createElement('p'); x.className = 'tpe'; x.setAttribute('role', 'alert'); B.appendChild(x); } x.textContent = m; x.scrollIntoView({ block: 'nearest' }); }
    function nPicked() { return Object.keys(S.picked).length; }
    function render() {
      var n = aName();
      if (S.step === 1) {
        H.textContent = t('h1');
        B.innerHTML = favs.length ? '<p>' + esc(t('h1p')) + ' <b>' + esc(fill(t('sel'), { n: nPicked() })) + '</b></p>' + favs.map(function (f) {
          var s = f.snap || {}, on = !!S.picked[f.mls];
          return '<button type="button" class="tph' + (on ? ' on' : '') + '" data-h="' + esc(f.mls) + '" aria-pressed="' + on + '">' + (s.photo ? '<img src="' + esc(photo(s.photo)) + '" alt="">' : '<span class="ni"></span>') +
            '<span><b>' + esc(money(f.price || s.price)) + '</b><small>' + esc([s.addr, s.city].filter(Boolean).join(', ')) + '</small></span><span class="ck">' + (on ? '✓' : '') + '</span></button>';
        }).join('') : '<p>' + esc(t('none')) + '</p><div class="tp-r"><a class="go" href="homes" style="background:#c8102e;color:#fff">' + esc(t('search')) + '</a></div>';
        F.innerHTML = '<button type="button" data-x>' + esc(t('close')) + '</button>' + (favs.length ? '<button type="button" class="go" data-next>' + esc(t('next')) + '</button>' : '');
      } else if (S.step === 2) {
        H.textContent = t('h2');
        var now = new Date(), days = [];
        for (var k = 0; k < 14; k++) days.push(new Date(now.getFullYear(), now.getMonth(), now.getDate() + k));
        var L = lang() === 'es' ? 'es-MX' : 'en-US';
        B.innerHTML = '<div class="tpd" role="group" aria-label="' + esc(t('h2')) + '">' + days.map(function (d, i) { var v = iso(d);
            return '<button type="button" data-d="' + v + '" class="' + (S.date === v ? 'on' : '') + '" aria-pressed="' + (S.date === v) + '"><small>' + esc(i === 0 ? t('today') : i === 1 ? t('tom') : d.toLocaleDateString(L, { weekday: 'short' })) + '</small><b>' + d.getDate() + '</b><small>' + esc(d.toLocaleDateString(L, { month: 'short' })) + '</small></button>'; }).join('') + '</div>' +
          '<label class="l">' + esc(t('h3')) + '</label><div class="tpw">' + ['morning', 'afternoon', 'evening', 'any'].map(function (w) { return '<button type="button" data-w="' + w + '" class="' + (S.win === w ? 'on' : '') + '" aria-pressed="' + (S.win === w) + '">' + esc(t('win')[w]) + '</button>'; }).join('') + '</div>' +
          '<label class="l" for="tp-note">' + esc(fill(t('note'), { a: n })) + '</label><textarea id="tp-note" rows="2" maxlength="600" placeholder="' + esc(t('note_ph')) + '">' + esc(S.note) + '</textarea>' +
          '<label class="l" for="tp-ph">' + esc(t('phone')) + '</label><input id="tp-ph" type="tel" inputmode="tel" autocomplete="tel" value="' + esc(fmtPhone(S.phone) || S.phone) + '">' +
          '<label class="tpc"><input type="checkbox" id="tp-sms"' + (S.sms ? ' checked' : '') + '><span>' + esc(t('sms')) + '</span></label>' +
          (S.sms ? '' : '<p style="font-size:12.5px;color:#6a6972;margin:6px 0 0">' + esc(t('sms_need')) + '</p>');
        F.innerHTML = '<button type="button" data-back>' + esc(t('back')) + '</button><button type="button" class="go" data-send>' + esc(fill(t('send'), { a: n })) + '</button>';
        var sel = B.querySelector('.tpd .on'); if (sel) sel.scrollIntoView({ inline: 'center', block: 'nearest' });
      } else {
        H.textContent = '';
        B.innerHTML = '<div class="tpok"><b>' + esc(t('ok_h')) + '</b><p>' + esc(fill(t('ok_p'), { a: n, n: nPicked(), d: dayLbl(S.date), s: S.sms ? t('ok_sms') : t('ok_mail') })) + '</p></div>';
        F.innerHTML = '<button type="button" class="go" data-x>' + esc(t('close')) + '</button>';
      }
    }
    function keep() { var a = B.querySelector('#tp-note'), b = B.querySelector('#tp-ph'), c = B.querySelector('#tp-sms'); if (a) S.note = a.value; if (b) S.phone = digits(b.value); if (c) S.sms = c.checked; }
    ov.addEventListener('click', function (e) {
      if (e.target === ov || e.target.closest('[data-x]')) { close(); if (S.step === 3 && onDone) onDone(); return; }
      var h = e.target.closest('[data-h]');
      if (h) { var m = h.getAttribute('data-h'); if (S.picked[m]) delete S.picked[m]; else if (nPicked() < MAXH) S.picked[m] = 1; var y = B.scrollTop; render(); B.scrollTop = y; return; }
      if (e.target.closest('[data-next]')) { if (!nPicked()) { err(t('pick1')); return; } S.step = 2; render(); B.scrollTop = 0; return; }
      if (e.target.closest('[data-back]')) { keep(); S.step = 1; render(); return; }
      var d = e.target.closest('[data-d]'); if (d) { keep(); S.date = d.getAttribute('data-d'); var x0 = B.querySelector('.tpd').scrollLeft; render(); B.querySelector('.tpd').scrollLeft = x0; return; }
      var w = e.target.closest('[data-w]'); if (w) { keep(); S.win = w.getAttribute('data-w'); var y0 = B.scrollTop, x1 = B.querySelector('.tpd').scrollLeft; render(); B.scrollTop = y0; B.querySelector('.tpd').scrollLeft = x1; return; }
      var sb = e.target.closest('[data-send]'); if (sb) send(sb);
    });
    ov.addEventListener('change', function (e) { if (e.target.id === 'tp-sms') { keep(); var y = B.scrollTop, x = B.querySelector('.tpd').scrollLeft; render(); B.scrollTop = y; B.querySelector('.tpd').scrollLeft = x; } });
    function send(btn) {
      keep();
      if (!S.date) { err(t('pickd')); return; }
      if (S.sms && S.phone.length !== 10) { err(t('badph')); return; }
      var homes = favs.filter(function (f) { return S.picked[f.mls]; }).map(function (f) { var s = f.snap || {};
        return { mls: f.mls, addr: s.addr || null, city: s.city || null, zip: s.zip || null, price: f.price || s.price || null, photo: s.photo || null, beds: s.beds, baths: s.baths }; });
      btn.disabled = true; btn.textContent = t('sending');
      A().rpc('jag_tour_request', { p: { date: S.date, window: S.win, note: S.note || null, phone: S.phone || null, sms_ok: S.sms, homes: homes } }).then(function (j) {
        if (j && j.ok) { S.step = 3; render(); return; }
        btn.disabled = false; btn.textContent = fill(t('send'), { a: aName() });
        err(j && j.reason === 'too_many' ? fill(t('too_many'), { a: aName() }) : j && j.reason === 'date' ? t('pickd') : fill(t('err'), { a: aName() }));
      }).catch(function () { btn.disabled = false; btn.textContent = fill(t('send'), { a: aName() }); err(fill(t('err'), { a: aName() })); });
    }
    render();
  }

  window.JagTourPlan = { load: load, card: card, bind: bind, open: open, data: function () { return D; } };
})();
