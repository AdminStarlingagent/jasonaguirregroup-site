/* ============================================================
   JAG Premium: every website account has a dedicated agent and can ask for a showing.
     JagPremium.agent()            → Promise of { agent, assigned } for the signed-in client (cached)
     JagPremium.card(opts)         → HTML for the "your agent" card (account page, home detail)
     JagPremium.bind(el, opts)     → wires the card's buttons inside el
     JagPremium.openShowing(opts)  → the showing request window; opts.home = one home, opts.homes = homes to pick from
     JagPremium.showings()         → Promise of the client's recent showing requests
   Needs jag-account.js (window.JagAccount). The request goes to jag_showing_request(); the agent gets
   a Follow Up Boss task + note and a text (n8n "JAG Site · Showing requests").
   ============================================================ */
(function(){
  var CDN = 'https://cdn.repliers.io/';
  function A(){ return window.JagAccount; }
  function lang(){ try{ return localStorage.getItem('jag_lang') === 'en' ? 'en' : 'es'; }catch(e){ return 'es'; } }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function digits(p){ var d = String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); return d.length === 10 ? d : ''; }
  function fmtPhone(p){ var d = digits(p); return d ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : ''; }
  function money(n){ return n ? '$' + Math.round(n).toLocaleString('en-US') : ''; }
  function photo(p){ return !p ? '' : /^https?:/.test(p) ? p : CDN + p + '?class=small'; }

  var T = {
    es: { badge: 'Cuenta Premium', your: 'Su agente', team: 'Su equipo JAG',
      p: 'Llame o escriba directo a su agente. Le ayuda con visitas, ofertas y cualquier pregunta.',
      p_team: 'Le asignamos un agente en unos minutos. Mientras tanto, nuestro equipo le atiende.',
      call: 'Llamar', text: 'Mensaje', mail: 'Correo', visit: 'Pedir una visita',
      sms: 'Hola {a}, soy {c}. Tengo una pregunta sobre casas.',
      h: 'Pedir una visita', with_: 'Con {a}', home: 'Casa', pick: 'Elija una casa', other: 'Otra casa (escriba la dirección)', addr: 'Dirección de la casa',
      when: '¿Cuándo le queda bien?', when_p: 'Elija hasta 3 opciones. {a} le confirma la hora.', opt: 'Opción', none: '—',
      w: { morning: 'En la mañana (9–12)', midday: 'Al mediodía (12–3)', afternoon: 'En la tarde (3–6)', evening: 'En la noche (6–8)' },
      note: 'Algo que debamos saber (opcional)', note_ph: 'Ej.: vamos con niños, preferimos fin de semana…', send: 'Pedir la visita', sending: 'Enviando…', cancel: 'Cancelar', close: 'Cerrar',
      need_home: 'Elija una casa o escriba la dirección.', need_time: 'Elija al menos un día.',
      ok_h: '¡Listo!', ok_p: 'Le avisamos a {a}. Le va a confirmar la visita por texto o llamada.', ok_late: 'Le avisamos a {a}. Como ya es tarde, le contacta mañana a partir de las 8 AM.',
      limit: 'Ya pidió varias visitas hoy. Su agente le contactará pronto; también puede llamarle.', err: 'No pudimos enviar su solicitud. Intente de nuevo o llame a su agente.',
      signin: 'Inicie sesión para pedir una visita. Su agente le confirma la hora.',
      list_h: 'Sus visitas', st_new: 'Recibida', st_sent: 'Su agente ya la tiene', st_done: 'Atendida', asked: 'Pedida el ' },
    en: { badge: 'Premium account', your: 'Your agent', team: 'Your JAG team',
      p: 'Call or text your agent directly. They help with showings, offers and any question.',
      p_team: 'We assign you an agent in a few minutes. Our team is here for you in the meantime.',
      call: 'Call', text: 'Text', mail: 'Email', visit: 'Request a showing',
      sms: 'Hi {a}, this is {c}. I have a question about homes.',
      h: 'Request a showing', with_: 'With {a}', home: 'Home', pick: 'Pick a home', other: 'Another home (type the address)', addr: 'Home address',
      when: 'When works for you?', when_p: 'Pick up to 3 options. {a} confirms the time.', opt: 'Option', none: '—',
      w: { morning: 'Morning (9–12)', midday: 'Midday (12–3)', afternoon: 'Afternoon (3–6)', evening: 'Evening (6–8)' },
      note: 'Anything we should know (optional)', note_ph: 'E.g. bringing kids, weekends are better…', send: 'Request the showing', sending: 'Sending…', cancel: 'Cancel', close: 'Close',
      need_home: 'Pick a home or type the address.', need_time: 'Pick at least one day.',
      ok_h: 'Done!', ok_p: 'We let {a} know. They will confirm the showing by text or call.', ok_late: 'We let {a} know. Since it is late, they will reach out tomorrow after 8 AM.',
      limit: 'You already asked for several showings today. Your agent will reach out soon, or give them a call.', err: 'We could not send your request. Try again or call your agent.',
      signin: 'Sign in to request a showing. Your agent confirms the time.',
      list_h: 'Your showings', st_new: 'Received', st_sent: 'Your agent has it', st_done: 'Handled', asked: 'Requested ' }
  };
  function t(k){ return (T[lang()] || T.es)[k]; }
  function fill(s, o){ return String(s).replace(/\{(\w)\}/g, function(_, k){ return o[k] == null ? '' : o[k]; }); }
  // what the team reads in Follow Up Boss and the text (always English, same as the other site notes)
  var W_EN = { morning: 'Morning (9 AM–12 PM)', midday: 'Midday (12–3 PM)', afternoon: 'Afternoon (3–6 PM)', evening: 'Evening (6–8 PM)' };

  /* ---------- styles ---------- */
  var css = '' +
    '.jp-card{border:1px solid #e3e3e8;border-radius:18px;padding:18px;background:#fff;display:grid;grid-template-columns:auto 1fr;gap:4px 16px;align-items:center;margin:0 0 6px}' +
    '.jp-av{width:68px;height:68px;border-radius:50%;background:#f1f1f4 center/cover no-repeat;grid-row:span 2;display:grid;place-items:center;font-weight:800;font-size:24px;color:#5f5e68}' +
    '.jp-k{display:inline-block;font-size:10px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;background:#17161c;color:#fff;border-radius:99px;padding:4px 9px;margin-bottom:4px}' +
    '.jp-n{font-size:19px;font-weight:800;letter-spacing:-.01em;line-height:1.2}.jp-n small{display:block;font-size:12px;font-weight:700;color:#5f5e68;letter-spacing:0}' +
    '.jp-p{grid-column:1/-1;margin:8px 0 0;color:#45444c;font-size:14px}' +
    '.jp-btns{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}' +
    '.jp-b{flex:1 1 auto;min-height:44px;border-radius:10px;border:0;font:inherit;font-weight:800;font-size:14px;padding:10px 14px;display:inline-flex;align-items:center;justify-content:center;gap:6px;text-decoration:none;cursor:pointer;background:#fff;color:#17161c;box-shadow:inset 0 0 0 1.5px #17161c}' +
    '.jp-b:hover{background:#f5f5f7}.jp-b.go{background:#c8102e;color:#fff;box-shadow:none;flex-basis:100%}.jp-b.go:hover{background:#a30d26}' +
    '.jp-list{grid-column:1/-1;margin:14px 0 0;border-top:1px solid #eee;padding-top:10px}.jp-list h4{margin:0 0 6px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#5f5e68}' +
    '.jp-list li{list-style:none;display:flex;justify-content:space-between;gap:10px;font-size:13.5px;padding:6px 0;border-bottom:1px dashed #eee}.jp-list ul{margin:0;padding:0}.jp-list em{font-style:normal;font-weight:800;white-space:nowrap}.jp-list em.done{color:#1a5c31}' +
    '.jp-ov{position:fixed;inset:0;background:rgba(15,14,20,.55);display:none;align-items:center;justify-content:center;padding:14px;z-index:9600}.jp-ov.on{display:flex}' +
    '.jp-bx{background:#fff;border-radius:18px;max-width:470px;width:100%;max-height:calc(100vh - 28px);overflow:auto;padding:22px 20px;position:relative;font-family:inherit;color:#17161c}' +
    '.jp-bx h3{margin:0;font-size:21px;font-weight:800;letter-spacing:-.01em}.jp-sub{color:#5f5e68;margin:2px 0 14px;font-size:14px}' +
    '.jp-x{position:absolute;top:10px;right:10px;width:38px;height:38px;border:0;background:#f5f5f7;border-radius:50%;font-size:20px;cursor:pointer}' +
    '.jp-bx label{display:block;font-weight:800;font-size:13px;margin:12px 0 5px}.jp-bx .jp-hint{font-size:12.5px;color:#5f5e68;margin:-2px 0 6px}' +
    '.jp-bx select,.jp-bx input,.jp-bx textarea{width:100%;border:1.5px solid #c9c8d0;border-radius:10px;padding:10px 11px;font:inherit;font-size:16px;background:#fff;color:inherit}' +
    '.jp-row{display:grid;grid-template-columns:1.25fr 1fr;gap:8px;margin-bottom:8px}' +
    '.jp-home{display:flex;gap:12px;align-items:center;background:#f5f5f7;border-radius:12px;padding:10px}.jp-home i{width:74px;height:54px;border-radius:8px;background:#e3e3e8 center/cover no-repeat;flex:none}.jp-home b{display:block}.jp-home span{font-size:13px;color:#5f5e68}' +
    '.jp-err{color:#c8102e;font-weight:700;font-size:13px;min-height:18px;margin:8px 0 0}' +
    '.jp-go{width:100%;margin-top:10px;min-height:48px;border:0;border-radius:10px;background:#c8102e;color:#fff;font:inherit;font-weight:800;font-size:16px;cursor:pointer}.jp-go[disabled]{opacity:.6;cursor:default}' +
    '.jp-ok{text-align:center;padding:10px 0}.jp-ok b{display:block;font-size:22px;margin-bottom:6px}.jp-ok p{color:#45444c;margin:0 0 16px}' +
    '@media(max-width:420px){.jp-row{grid-template-columns:1fr 1fr}.jp-b{flex-basis:calc(33% - 6px);white-space:nowrap;font-size:13.5px;padding:10px 6px}.jp-b.go{flex-basis:100%}}';
  function ensureCss(){ if(document.getElementById('jp-css')) return; var s = document.createElement('style'); s.id = 'jp-css'; s.textContent = css; document.head.appendChild(s); }

  /* ---------- data ---------- */
  var cache = null;
  function agent(force){
    var a = A(); if(!a || !a.user || !a.user()) return Promise.resolve(null);
    if(cache && !force) return cache;
    cache = a.rpc('jag_my_agent').then(function(j){ return j && j.ok ? j : null; }).catch(function(){ cache = null; return null; });
    return cache;
  }
  function showings(){ var a = A(); if(!a || !a.user()) return Promise.resolve([]); return a.rpc('jag_my_showings').then(function(r){ return r || []; }).catch(function(){ return []; }); }

  /* ---------- card ---------- */
  function card(o){
    ensureCss(); o = o || {};
    var ag = o.agent && o.agent.agent, first = ag ? (ag.first_name || String(ag.name || '').split(' ')[0]) : '';
    var ph = ag && digits(ag.phone), me = (A() && A().profile && A().profile()) || {};
    var sms = fill(t('sms'), { a: first, c: String(me.name || '').split(' ')[0] || '' }).replace(' , ', ', ').replace(/, \./, '.');
    var av = ag && ag.photo_url ? '<span class="jp-av" style="background-image:url(\'' + esc(ag.photo_url) + '\')" aria-hidden="true"></span>'
      : '<span class="jp-av" aria-hidden="true">' + esc((first || 'J').charAt(0)) + '</span>';
    var list = '';
    if(o.showings && o.showings.length){
      list = '<div class="jp-list"><h4>' + t('list_h') + '</h4><ul>' + o.showings.slice(0, 4).map(function(s){
        var h = s.home || {}, st = s.handled_at ? '<em class="done">' + t('st_done') + '</em>' : '<em>' + t(s.sent ? 'st_sent' : 'st_new') + '</em>';
        var when = new Date(s.created_at).toLocaleDateString(lang() === 'es' ? 'es-MX' : 'en-US', { month: 'short', day: 'numeric' });
        return '<li><span>' + esc(h.addr || ('MLS ' + (s.mls || ''))) + ' · ' + t('asked') + esc(when) + '</span>' + st + '</li>';
      }).join('') + '</ul></div>';
    }
    return '<div class="jp-card" data-jp>' + av +
      '<div><span class="jp-k">★ ' + t('badge') + '</span><div class="jp-n">' + (ag ? '<small>' + t('your') + '</small>' + esc(ag.name || first) : esc(t('team'))) + '</div></div>' +
      '<p class="jp-p">' + t(ag ? 'p' : 'p_team') + '</p>' +
      '<div class="jp-btns">' +
        (ph ? '<a class="jp-b" href="tel:+1' + ph + '" data-jp-a="call">📞 ' + t('call') + '</a><a class="jp-b" href="sms:+1' + ph + '?&body=' + encodeURIComponent(sms) + '" data-jp-a="text">💬 ' + t('text') + '</a>' : '') +
        (ag && ag.email ? '<a class="jp-b" href="mailto:' + esc(ag.email) + '" data-jp-a="mail">✉️ ' + t('mail') + '</a>' : '') +
        (o.noVisit ? '' : '<button type="button" class="jp-b go" data-jp-visit>🏠 ' + t('visit') + '</button>') +
      '</div>' + list + '</div>';
  }
  function bind(el, o){
    if(!el) return; o = o || {};
    var b = el.querySelector('[data-jp-visit]');
    if(b) b.onclick = function(){ openShowing({ home: o.home, homes: o.homes, onDone: o.onDone }); };
  }

  /* ---------- showing request window ---------- */
  var ov = null;
  function days(){ var out = [], n = new Date(); for(var k = 0; k <= 14; k++) out.push(new Date(n.getFullYear(), n.getMonth(), n.getDate() + k)); return out; }
  function dayLbl(d, k){ var L = lang() === 'es' ? 'es-MX' : 'en-US'; var s = d.toLocaleDateString(L, { weekday: 'short', month: 'short', day: 'numeric' }); return k === 0 ? (lang() === 'es' ? 'Hoy, ' : 'Today, ') + s : k === 1 ? (lang() === 'es' ? 'Mañana, ' : 'Tomorrow, ') + s : s; }
  function winFor(time){ var m = /(\d+):(\d+)\s*(AM|PM)/i.exec(time || ''); if(!m) return 'morning'; var h = (+m[1] % 12) + (/pm/i.test(m[3]) ? 12 : 0); return h < 12 ? 'morning' : h < 15 ? 'midday' : h < 18 ? 'afternoon' : 'evening'; }
  function lateNow(){ try{ var h = +new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hourCycle: 'h23' }).format(new Date()); return h < 8 || h >= 20; }catch(e){ return false; } }
  function homeOf(x){ // from a saved-home row ({mls, snap, last_price}) or a home object
    if(!x) return null;
    if(x.snap){ var s = x.snap || {}; return { mls: x.mls, addr: s.addr, city: s.city, zip: s.zip, price: x.last_price || s.price, beds: s.beds, photo: s.photo }; }
    return x;
  }

  function openShowing(o){
    o = o || {}; ensureCss();
    var a = A(); if(!a) return;
    if(!a.user()){ a.requireSignIn(t('signin')).then(function(){ openShowing(o); }).catch(function(){}); return; }
    var one = homeOf(o.home), list = (o.homes || []).map(homeOf).filter(function(h){ return h && h.mls; });
    if(!ov){ ov = document.createElement('div'); ov.className = 'jp-ov'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); document.body.appendChild(ov);
      ov.addEventListener('click', function(e){ if(e.target === ov) ov.classList.remove('on'); });
      document.addEventListener('keydown', function(e){ if(e.key === 'Escape' && ov.classList.contains('on')) ov.classList.remove('on'); }); }
    agent().then(function(j){
      var ag = j && j.agent, first = ag ? (ag.first_name || String(ag.name || '').split(' ')[0]) : (lang() === 'es' ? 'su agente' : 'your agent');
      var D = days(), pre = o.pre || {}, preDay = pre.day != null ? +pre.day + 1 : 1, preWin = winFor(pre.time);   // homes.html counts days from tomorrow
      var dOpts = function(sel, blank){ return (blank ? '<option value="">' + t('none') + '</option>' : '') + D.map(function(d, k){ return '<option value="' + k + '"' + (k === sel ? ' selected' : '') + '>' + esc(dayLbl(d, k)) + '</option>'; }).join(''); };
      var wOpts = function(sel){ return Object.keys(W_EN).map(function(k){ return '<option value="' + k + '"' + (k === sel ? ' selected' : '') + '>' + esc(t('w')[k]) + '</option>'; }).join(''); };
      var homeHtml = one ? '<div class="jp-home"><i style="background-image:url(\'' + esc(photo(one.photo)) + '\')"></i><span><b>' + esc(money(one.price)) + '</b>' + esc([one.addr, one.city].filter(Boolean).join(', ')) + '</span></div>'
        : '<select id="jp-home" aria-label="' + esc(t('home')) + '">' + (list.length ? '<option value="">' + esc(t('pick')) + '</option>' : '') +
            list.map(function(h, i){ return '<option value="' + i + '">' + esc([money(h.price), h.addr, h.city].filter(Boolean).join(' · ')) + '</option>'; }).join('') +
            '<option value="other"' + (list.length ? '' : ' selected') + '>' + esc(t('other')) + '</option></select>' +
          '<input id="jp-addr" placeholder="' + esc(t('addr')) + '" autocomplete="street-address" maxlength="160" style="margin-top:8px' + (list.length ? ';display:none' : '') + '">';
      ov.innerHTML = '<div class="jp-bx"><button class="jp-x" type="button" aria-label="' + esc(t('close')) + '">×</button>' +
        '<h3>' + t('h') + '</h3><p class="jp-sub">' + esc(fill(t('with_'), { a: ag ? ag.name || first : t('team') })) + '</p>' +
        '<form novalidate><label>' + t('home') + '</label>' + homeHtml +
        '<label>' + t('when') + '</label><p class="jp-hint">' + esc(fill(t('when_p'), { a: first })) + '</p>' +
        [0, 1, 2].map(function(r){ return '<div class="jp-row"><select data-d="' + r + '" aria-label="' + t('opt') + ' ' + (r + 1) + '">' + dOpts(r ? -1 : Math.min(preDay, 14), r > 0) + '</select>' +
          '<select data-w="' + r + '" aria-label="' + t('opt') + ' ' + (r + 1) + '">' + wOpts(r ? 'afternoon' : preWin) + '</select></div>'; }).join('') +
        '<label for="jp-note">' + t('note') + '</label><textarea id="jp-note" rows="2" maxlength="500" placeholder="' + esc(t('note_ph')) + '"></textarea>' +
        '<p class="jp-err" id="jp-err" role="alert"></p><button class="jp-go" type="submit">' + t('send') + '</button></form></div>';
      ov.classList.add('on');
      ov.querySelector('.jp-x').onclick = function(){ ov.classList.remove('on'); };
      var hs = ov.querySelector('#jp-home'), ad = ov.querySelector('#jp-addr');
      if(hs) hs.onchange = function(){ ad.style.display = hs.value === 'other' ? '' : 'none'; if(hs.value === 'other') ad.focus(); };
      var f = ov.querySelector('form'), go = ov.querySelector('.jp-go'), er = ov.querySelector('#jp-err');
      f.addEventListener('change', function(){ er.textContent = ''; }); f.addEventListener('input', function(){ er.textContent = ''; });
      f.onsubmit = function(e){
        e.preventDefault(); er.textContent = '';
        var h = one;
        if(!h){ if(hs && hs.value !== '' && hs.value !== 'other') h = list[+hs.value]; else if(ad && ad.value.trim().length >= 5) h = { addr: ad.value.trim() }; }
        if(!h){ er.textContent = t('need_home'); return; }
        var times = [], seen = {};
        [0, 1, 2].forEach(function(r){
          var dv = f.querySelector('[data-d="' + r + '"]').value, wv = f.querySelector('[data-w="' + r + '"]').value;
          if(dv === '') return; var d = D[+dv], key = dv + wv; if(seen[key]) return; seen[key] = 1;
          times.push(d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' + W_EN[wv]);
        });
        if(!times.length){ er.textContent = t('need_time'); return; }
        go.disabled = true; go.textContent = t('sending');
        a.rpc('jag_showing_request', { p_mls: h.mls || null, p_home: { addr: h.addr || null, city: h.city || null, zip: h.zip || null, price: h.price || null, beds: h.beds != null ? h.beds : null, photo: h.photo || null },
          p_times: times, p_note: ov.querySelector('#jp-note').value.trim() || null })
        .then(function(r){
          if(!r || !r.ok){ go.disabled = false; go.textContent = t('send'); er.textContent = t(r && r.reason === 'limit' ? 'limit' : 'err'); return; }
          if(a.logActivity) a.logActivity({ kind: 'inquiry', mls: h.mls || null });
          var nm = r.agent_first || first;
          ov.querySelector('.jp-bx').innerHTML = '<div class="jp-ok"><b>' + t('ok_h') + '</b><p>' + esc(fill(t(lateNow() ? 'ok_late' : 'ok_p'), { a: nm })) + '</p>' +
            (ag && digits(ag.phone) ? '<a class="jp-b" style="width:100%;margin-bottom:8px" href="tel:+1' + digits(ag.phone) + '">📞 ' + t('call') + ' ' + esc(nm) + ' · ' + esc(fmtPhone(ag.phone)) + '</a>' : '') +
            '<button type="button" class="jp-go">' + t('close') + '</button></div>';
          ov.querySelector('.jp-go').onclick = function(){ ov.classList.remove('on'); };
          if(o.onDone) try{ o.onDone(r); }catch(x){}
        })
        .catch(function(){ go.disabled = false; go.textContent = t('send'); er.textContent = t('err'); });
      };
    });
  }

  window.JagPremium = { agent: agent, card: card, bind: bind, openShowing: openShowing, showings: showings, reset: function(){ cache = null; } };
  if(A() && A().onChange) A().onChange(function(){ cache = null; });
})();
