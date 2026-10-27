/* ============================================================
   JAG sharing + agent attribution.
   Clients: a link like /homes?a=katherine&s=<share id>#<MLS> remembers the agent for 60 days,
     shows that agent's name, photo and Follow Up Boss number instead of the team line,
     counts the open for the agent, and ties the client's account to that agent.
   Agents: when signed in to the Agent Hub on this device, JagShare.open() builds a text,
     WhatsApp or email with their own link and number.
   Needs jag-capture.js (JAG_CRM) loaded first.
   ============================================================ */
(function(){
  var C = window.JAG_CRM || {}, BASE = String(C.url || '').replace(/\/+$/, ''), KEY = C.anonKey;
  var SITE = 'https://jasonaguirregroup.company';
  function ls(k, v){ try{ if(v === undefined) return JSON.parse(localStorage.getItem(k) || 'null'); if(v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); }catch(e){ return null; } }
  function lang(){ try{ return localStorage.getItem('jag_lang') === 'en' ? 'en' : 'es'; }catch(e){ return 'es'; } }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmtPhone(p){ var d = String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); return d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : (p || ''); }
  function tel(p){ var d = String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); return d.length === 10 ? '+1' + d : ''; }
  function rpc(name, args, token){
    return fetch(BASE + '/rest/v1/rpc/' + name, { method: 'POST', keepalive: true,
      headers: { apikey: KEY, Authorization: 'Bearer ' + (token || KEY), 'Content-Type': 'application/json' }, body: JSON.stringify(args || {}) })
      .then(function(r){ if(!r.ok) throw new Error(r.status); return r.status === 204 ? null : r.json(); });
  }

  /* ---------------- client side: who sent me here ---------------- */
  var agent = null, listeners = [];
  function ref(){ var r = ls('jag_ref'); return r && r.code && Date.now() - (r.at || 0) < 60 * 864e5 ? r : null; }
  (function capture(){
    var q; try{ q = new URLSearchParams(location.search); }catch(e){ return; }
    var a = (q.get('a') || '').toLowerCase(), s = q.get('s') || '';
    if(/^[a-z0-9-]{2,30}$/.test(a)) ls('jag_ref', { code: a, at: Date.now() });
    if(/^[0-9a-f-]{36}$/i.test(s)){
      var seen = false; try{ seen = !!sessionStorage.getItem('jag_s_' + s); sessionStorage.setItem('jag_s_' + s, '1'); }catch(e){}
      if(!seen && !ls('jag_agent')) rpc('jag_share_opened', { p_id: s }).catch(function(){});   // agents opening their own links don't count
    }
  })();
  function loadAgent(){
    var r = ref(); if(!r || !BASE) return;
    rpc('jag_agent_public', { p_code: r.code }).then(function(a){
      if(!a || !a.code) return;
      agent = a; window.JAG_AGENT = a;
      paintHeader();
      listeners.forEach(function(f){ try{ f(a); }catch(e){} });
    }).catch(function(){});
  }
  function paintHeader(){
    if(!agent || !agent.phone) return;
    document.querySelectorAll('a.hphone,[data-team-phone]').forEach(function(el){ el.href = 'tel:' + tel(agent.phone); el.textContent = fmtPhone(agent.phone); });
  }
  // a signed-in client who came through an agent's link belongs to that agent (first agent wins)
  function linkAccount(){
    var A = window.JagAccount, r = ref();
    if(!A || !A.user || !A.user() || !r || !A.token) return;
    var done = ls('jag_ref_linked'); if(done === r.code) return;
    Promise.resolve(A.token()).then(function(t){ if(!t) return; return rpc('jag_client_set_agent', { p_code: r.code }, t).then(function(){ ls('jag_ref_linked', r.code); }); }).catch(function(){});
  }
  function boot(){
    loadAgent(); paintHeader(); linkAccount();
    if(window.JagAccount && JagAccount.onChange) JagAccount.onChange(linkAccount);
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  // card for the listing page: "Your agent"
  function agentCard(){
    if(!agent) return '';
    var es = lang() === 'es', first = agent.first_name || (agent.name || '').split(' ')[0];
    return '<div class="ja-card" style="display:flex;gap:12px;align-items:center;background:#fff;border:1px solid #e8e8ec;border-radius:16px;padding:14px">' +
      (agent.photo_url ? '<img src="' + esc(agent.photo_url) + '" alt="" style="width:54px;height:54px;border-radius:50%;object-fit:cover;flex:0 0 54px">' : '') +
      '<div style="min-width:0;flex:1"><small style="display:block;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6a6972">' + (es ? 'Tu agente' : 'Your agent') + '</small>' +
      '<b style="display:block;font-size:16px">' + esc(agent.name) + '</b><span style="font-size:13px;color:#6a6972">Jason Aguirre Group · eXp Realty</span>' +
      (agent.phone ? '<div style="display:flex;gap:8px;margin-top:8px"><a href="tel:' + tel(agent.phone) + '" style="flex:1;text-align:center;background:#17161c;color:#fff;border-radius:99px;padding:9px 10px;font-weight:700;font-size:13.5px;text-decoration:none">' + (es ? 'Llamar a ' : 'Call ') + esc(first) + '</a>' +
        '<a href="sms:' + tel(agent.phone) + '" style="flex:1;text-align:center;background:#f5f5f7;color:#17161c;border-radius:99px;padding:9px 10px;font-weight:700;font-size:13.5px;text-decoration:none">' + (es ? 'Enviar texto' : 'Text') + '</a></div>' +
        '<div style="font-size:13px;margin-top:6px;font-weight:600">' + esc(fmtPhone(agent.phone)) + '</div>' : '') +
      '</div></div>';
  }

  /* ---------------- agent side: share sheet ---------------- */
  function me(){ var a = ls('jag_agent'); if(a && a.until && Date.now() > a.until){ ls('jag_agent', null); return null; } return a && a.code && a.r ? a : null; }
  function agentToken(){
    var a = me(); if(!a) return Promise.resolve(null);
    if(a.t && a.x && a.x - Date.now() > 60000) return Promise.resolve(a.t);
    return fetch(BASE + '/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: a.r }) })
      .then(function(r){ return r.json(); }).then(function(j){
        if(!j || !j.access_token){ return null; }
        a.t = j.access_token; a.r = j.refresh_token || a.r; a.x = Date.now() + (j.expires_in || 3600) * 1000; ls('jag_agent', a); return a.t;
      }).catch(function(){ return null; });
  }
  var MSG = {
    es: { listing: function(o, a){ return '¡Hola! Te comparto esta casa que creo que te va a gustar' + (o.summary ? ': ' + o.summary : '') + '.\nMírala aquí: ' + o.url + '\n\nCualquier pregunta, aquí estoy.\n' + a.first_name + ' · Jason Aguirre Group' + (a.phone ? ' · ' + fmtPhone(a.phone) : ''); },
      search: function(o, a){ return '¡Hola! Te preparé esta búsqueda de casas' + (o.summary ? ' (' + o.summary + ')' : '') + '. Crea tu cuenta gratis para guardar tus favoritas y recibir avisos de casas nuevas:\n' + o.url + '\n\n' + a.first_name + ' · Jason Aguirre Group' + (a.phone ? ' · ' + fmtPhone(a.phone) : ''); },
      site: function(o, a){ return '¡Hola! Aquí puedes buscar casas en todo Houston, guardar tus favoritas y recibir avisos cuando salgan casas nuevas. Es gratis:\n' + o.url + '\n\n' + a.first_name + ' · Jason Aguirre Group' + (a.phone ? ' · ' + fmtPhone(a.phone) : ''); },
      subj: { listing: 'Una casa para ti', search: 'Tu búsqueda de casas', site: 'Busca casas con nosotros' } },
    en: { listing: function(o, a){ return 'Hi! Here\'s a home I think you\'ll like' + (o.summary ? ': ' + o.summary : '') + '.\nTake a look: ' + o.url + '\n\nAny questions, I\'m here.\n' + a.first_name + ' · Jason Aguirre Group' + (a.phone ? ' · ' + fmtPhone(a.phone) : ''); },
      search: function(o, a){ return 'Hi! I set up this home search for you' + (o.summary ? ' (' + o.summary + ')' : '') + '. Create your free account to save favorites and get alerts on new homes:\n' + o.url + '\n\n' + a.first_name + ' · Jason Aguirre Group' + (a.phone ? ' · ' + fmtPhone(a.phone) : ''); },
      site: function(o, a){ return 'Hi! Here you can search homes all over Houston, save your favorites and get alerts when new homes hit the market. It\'s free:\n' + o.url + '\n\n' + a.first_name + ' · Jason Aguirre Group' + (a.phone ? ' · ' + fmtPhone(a.phone) : ''); },
      subj: { listing: 'A home for you', search: 'Your home search', site: 'Search homes with us' } }
  };
  function buildUrl(o, code, sid){
    var u = new URL(o.path || '/homes', SITE);
    if(o.query) Object.keys(o.query).forEach(function(k){ if(o.query[k] != null && o.query[k] !== '') u.searchParams.set(k, o.query[k]); });
    u.searchParams.set('a', code); if(sid) u.searchParams.set('s', sid);
    if(o.mls) u.hash = encodeURIComponent(o.mls);
    return u.toString();
  }
  var css = '.js-ov{position:fixed;inset:0;z-index:10000;background:rgba(23,22,28,.5);display:flex;align-items:flex-end;justify-content:center;font-family:"Plus Jakarta Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}' +
    '@media(min-width:640px){.js-ov{align-items:center}}' +
    '.js-sh{background:#fff;color:#17161c;width:100%;max-width:460px;border-radius:20px 20px 0 0;padding:18px 18px calc(18px + env(safe-area-inset-bottom,0px));display:flex;flex-direction:column;gap:12px;max-height:92vh;overflow:auto}' +
    '@media(min-width:640px){.js-sh{border-radius:20px}}.js-sh h3{margin:0;font-size:18px;font-weight:800}.js-top{display:flex;align-items:center;gap:8px}' +
    '.js-x{margin-left:auto;border:0;background:#f5f5f7;width:34px;height:34px;border-radius:50%;font-size:20px;cursor:pointer}' +
    '.js-lg{display:inline-flex;border:2px solid #17161c;border-radius:99px;overflow:hidden}.js-lg button{border:0;background:none;font:800 12.5px "Plus Jakarta Sans",sans-serif;padding:6px 11px;cursor:pointer}.js-lg button.on{background:#17161c;color:#fff}' +
    '.js-sh textarea{width:100%;box-sizing:border-box;min-height:150px;border:2px solid #e3e3e8;border-radius:14px;padding:11px;font:500 14.5px/1.45 "Plus Jakarta Sans",sans-serif;resize:vertical}' +
    '.js-gr{display:grid;grid-template-columns:1fr 1fr;gap:8px}.js-gr button,.js-gr a{display:flex;align-items:center;justify-content:center;gap:6px;border:0;border-radius:14px;padding:13px 10px;font:700 14.5px "Plus Jakarta Sans",sans-serif;text-decoration:none;cursor:pointer}' +
    '.js-sms{background:#c8102e;color:#fff}.js-wa{background:#1f9d55;color:#fff}.js-em{background:#2653d9;color:#fff}.js-cp{background:#f5f5f7;color:#17161c}' +
    '.js-note{font-size:12px;color:#6a6972;margin:0}' +
    '.js-app{background:#fdecef;border-radius:16px;padding:12px;display:flex;flex-direction:column;gap:8px}.js-app b{font-size:14.5px}.js-app small{color:#6a6972;font-size:12px}' +
    '.js-app select,.js-app input{width:100%;box-sizing:border-box;border:2px solid #e3e3e8;border-radius:12px;padding:10px;font:500 15px "Plus Jakarta Sans",sans-serif;background:#fff}' +
    '.js-go{border:0;border-radius:14px;padding:13px 10px;font:800 15px "Plus Jakarta Sans",sans-serif;background:#c8102e;color:#fff;cursor:pointer}.js-go:disabled{opacity:.55}' +
    '.js-ok{color:#0f8a4d;font-weight:700;font-size:13.5px}.js-bad{color:#a30d26;font-weight:700;font-size:13.5px}.js-or{font-size:12px;color:#6a6972;text-align:center;margin:2px 0 -4px}';
  // o.as: agent object from jag_agent_me (screener / admin sign-in), o.token: that session's token,
  // o.to: { phone, email } to address the text/email to the client, o.lang: 'es' | 'en' for the message.
  function open(o){
    var a = (o.as && o.as.code) ? o.as : me();
    if(!a){ location.href = SITE + '/agent'; return; }
    if(!document.getElementById('js-css')){ var st = document.createElement('style'); st.id = 'js-css'; st.textContent = css; document.head.appendChild(st); }
    var L = (o.lang === 'en' || o.lang === 'es') ? o.lang : lang(), sid = null, kind = o.kind || 'listing';
    var to = o.to || {}, toTel = tel(to.phone), toMail = String(to.email || '').trim();
    var ov = document.createElement('div'); ov.className = 'js-ov';
    ov.innerHTML = '<div class="js-sh" role="dialog" aria-modal="true" aria-label="Compartir"><div class="js-top"><h3>' + (o.title || 'Compartir') + '</h3>' +
      '<span class="js-lg" style="margin-left:10px"><button type="button" data-l="es">ES</button><button type="button" data-l="en">EN</button></span><button type="button" class="js-x" aria-label="Cerrar">×</button></div>' +
      (kind !== 'site' ? '<div class="js-app"><b>📲 ' + (L === 'en' ? 'To their JAG app' : 'A su app JAG') + '</b>' +
        '<small>' + (L === 'en' ? 'Lands in Messages in their account (red badge). They get an email, and a text from Lola if they turned texts on.' : 'Le llega a Mensajes en su cuenta (globito rojo). Recibe un correo, y un texto de Lola si activó los textos.') + '</small>' +
        '<select id="js-cl" aria-label="Cliente"><option value="">' + (L === 'en' ? 'Loading clients…' : 'Cargando clientes…') + '</option></select>' +
        '<input id="js-note" maxlength="300" aria-label="Nota">' +
        '<button type="button" class="js-go" id="js-app-go" disabled>' + (L === 'en' ? 'Send to their app' : 'Enviar a su app') + '</button><div id="js-app-st" role="status"></div></div>' +
        '<p class="js-or">' + (L === 'en' ? 'or send the link from your phone' : 'o mande el enlace desde su teléfono') + '</p>' : '') +
      '<textarea id="js-msg" aria-label="Mensaje"></textarea>' +
      '<div class="js-gr"><a class="js-sms" data-c="sms">💬 Texto</a><a class="js-wa" data-c="whatsapp" target="_blank" rel="noopener">WhatsApp</a>' +
      '<a class="js-em" data-c="email">✉️ Email</a><button type="button" class="js-cp" data-c="copy">Copiar</button></div>' +
      (navigator.share ? '<button type="button" class="js-cp" data-c="more" style="border:0;border-radius:14px;padding:12px;font:700 14px \'Plus Jakarta Sans\',sans-serif">Más opciones…</button>' : '') +
      '<p class="js-note">El enlace lleva tu nombre y tu número (' + esc(fmtPhone(a.phone)) + '). Verás en tu Agent Hub cuántas veces lo abren.</p></div>';
    document.body.appendChild(ov);
    var ta = ov.querySelector('#js-msg'), edited = false;
    function text(){ return MSG[L][kind]({ summary: o.summary, url: buildUrl(o, a.code, sid) }, a); }
    function paint(){ if(!edited) ta.value = text(); ov.querySelectorAll('.js-lg button').forEach(function(b){ b.classList.toggle('on', b.getAttribute('data-l') === L); }); links(); }
    function links(){
      var body = ta.value, subj = MSG[L].subj[kind];
      ov.querySelector('[data-c=sms]').href = 'sms:' + toTel + '?&body=' + encodeURIComponent(body);
      ov.querySelector('[data-c=whatsapp]').href = 'https://wa.me/' + toTel.replace(/\D/g, '') + '?text=' + encodeURIComponent(body);
      ov.querySelector('[data-c=email]').href = 'mailto:' + encodeURIComponent(toMail).replace(/%40/g, '@') + '?subject=' + encodeURIComponent(subj) + '&body=' + encodeURIComponent(body);
    }
    ta.addEventListener('input', function(){ edited = true; links(); });
    ov.addEventListener('click', function(e){
      if(e.target === ov || e.target.closest('.js-x')){ ov.remove(); return; }
      var lb = e.target.closest('.js-lg button'); if(lb){ L = lb.getAttribute('data-l'); edited = false; paint(); return; }
      var c = e.target.closest('[data-c]'); if(!c) return;
      var ch = c.getAttribute('data-c');
      if(ch === 'copy'){ e.preventDefault(); var v = ta.value; (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject()).then(function(){ c.textContent = '¡Copiado!'; }, function(){ ta.select(); }); }
      if(ch === 'more'){ e.preventDefault(); navigator.share({ text: ta.value }).catch(function(){}); }
    });
    paint();
    if(kind !== 'site') appSection(o, a, L, ov, function(){ return buildUrl(o, a.code, sid); });
    // get a share id first so opens are counted; the message updates when it arrives
    (o.token ? Promise.resolve(o.token) : agentToken()).then(function(t){
      if(!t) return;
      return rpc('jag_agent_share', { p_kind: kind, p_mls: o.mls || null, p_label: o.label || o.summary || null, p_channel: 'link' }, t).then(function(j){ if(j && j.id){ sid = j.id; paint(); } });
    }).catch(function(){});
  }

  /* ---------- "A su app JAG": the home lands in the client's Mensajes ---------- */
  var clientsCache = null;
  var NOTE = { es: { listing: '¡Hola! Te comparto esta casa que creo que te va a gustar.', search: 'Te preparé esta búsqueda de casas.' },
               en: { listing: 'Hi! Here\'s a home I think you\'ll like.', search: 'I set up this home search for you.' } };
  var noteCache;
  function teamNote(){
    if(noteCache !== undefined) return Promise.resolve(noteCache);
    return agentToken().then(function(t){ return t ? rpc('jag_team_prefs', {}, t) : null; })
      .then(function(j){ noteCache = (j && j.ok && j.default_note) || null; return noteCache; }).catch(function(){ return null; });
  }
  function appSection(o, a, L, ov, urlOf){
    var kind = o.kind || 'listing', sel = ov.querySelector('#js-cl'), note = ov.querySelector('#js-note'), go = ov.querySelector('#js-app-go'), st = ov.querySelector('#js-app-st');
    var stock = (NOTE[L] || NOTE.es)[kind] || '';
    note.value = stock; note.placeholder = L === 'en' ? 'Note (optional)' : 'Nota (opcional)';
    // the agent's own default note (Agent Hub → Settings) replaces the stock one for homes
    if(kind === 'listing') teamNote().then(function(n){ if(n && note.value === stock) note.value = n; });
    var card = Object.assign({ kind: kind, mls: o.mls || null, title: o.label || o.summary || null }, o.card || {});
    // a home: fill photo, price and specs from the listing when the caller didn't pass them
    var filled = Promise.resolve();
    if(kind === 'listing' && o.mls && !card.photo){
      filled = fetch(BASE + '/functions/v1/home-search?mlsNumber=' + encodeURIComponent(o.mls)).then(function(r){ return r.ok ? r.json() : null; }).then(function(j){
        var l = j && j.listings && j.listings[0]; if(!l) return; var ad = l.address || {}, d = l.details || {};
        card.photo = (l.images || [])[0] || null; card.price = l.listPrice || null; card.beds = d.numBedrooms; card.baths = d.numBathrooms; card.sqft = d.sqft ? String(d.sqft).replace(/\D/g, '') : null; card.city = ad.city || null;
        if(ad.streetName) card.title = [ad.streetNumber, ad.streetDirectionPrefix, ad.streetName, ad.streetSuffix, ad.streetDirection].filter(Boolean).join(' ') + (ad.city ? ', ' + ad.city : '');
      }).catch(function(){});
    }
    var want = String((o.to || {}).email || '').toLowerCase();
    (clientsCache ? Promise.resolve(clientsCache) : agentToken().then(function(t){ return t ? rpc('jag_agent_clients', {}, t) : null; }).then(function(j){ clientsCache = (j && j.clients) || []; return clientsCache; }))
      .then(function(list){
        list = list.slice().sort(function(x, y){ return String(x.name || x.email || '').localeCompare(String(y.name || y.email || '')); });
        if(!list.length){ sel.innerHTML = '<option value="">' + (L === 'en' ? 'No clients with an account yet' : 'Todavía no hay clientes con cuenta') + '</option>'; return; }
        sel.innerHTML = '<option value="">' + (L === 'en' ? 'Choose a client with an account…' : 'Elija un cliente con cuenta…') + '</option>' + list.map(function(c){
          return '<option value="' + esc(c.user_id) + '"' + (want && String(c.email || '').toLowerCase() === want ? ' selected' : '') + '>' + esc(c.name || c.email) + (c.name && c.email ? ' · ' + esc(c.email) : '') + '</option>'; }).join('');
        go.disabled = !sel.value;
      }).catch(function(){ sel.innerHTML = '<option value="">' + (L === 'en' ? 'Could not load clients' : 'No se pudieron cargar los clientes') + '</option>'; });
    sel.onchange = function(){ go.disabled = !sel.value; st.textContent = ''; };
    go.onclick = function(){
      if(!sel.value) return; go.disabled = true; st.className = ''; st.textContent = L === 'en' ? 'Sending…' : 'Enviando…';
      var name = sel.options[sel.selectedIndex].text.split(' · ')[0];
      card.url = urlOf();
      // wait (up to 4 s) for the listing photo/price so the card never goes out without them
      Promise.race([filled, new Promise(function(r){ setTimeout(r, 4000); })]).then(agentToken).then(function(t){ if(!t) throw new Error('signin'); return rpc('jag_msg_share', { p_user: sel.value, p_body: note.value.trim() || null, p_card: card }, t); })
        .then(function(r){
          if(!r || !r.ok) throw new Error((r && r.reason) || 'x');
          st.className = 'js-ok'; st.textContent = (L === 'en' ? '✓ Sent to ' + name + '\'s app. They get an email now.' : '✓ Enviada a la app de ' + name + '. Le llega un correo ahora.');
          go.textContent = L === 'en' ? 'Send to another client' : 'Enviar a otro cliente'; go.disabled = false; sel.value = ''; go.disabled = true;
        })
        .catch(function(e){ go.disabled = false; st.className = 'js-bad'; st.textContent = String(e && e.message) === 'signin' ? (L === 'en' ? 'Sign in to the Agent Hub again.' : 'Vuelva a iniciar sesión en el Agent Hub.') : (L === 'en' ? 'Could not send it. Try again.' : 'No se pudo enviar. Intente de nuevo.'); });
    };
  }

  window.JagShare = { resetNote: function(){ noteCache = undefined; }, open: open, me: me, agent: function(){ return agent; }, agentCard: agentCard, onAgent: function(f){ listeners.push(f); if(agent) f(agent); }, token: agentToken, fmtPhone: fmtPhone };
})();
