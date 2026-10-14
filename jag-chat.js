/* ============================================================
   JAG chat box: any visitor can ask about the buying/selling process.
   Messages go to the Starling AI agent (n8n webhook). If the webhook answers
   with text, it shows in the chat; otherwise the client is told the assistant
   will text them. Name + phone + texting consent are asked once, before the
   first message goes out. Spanish first.
   Optional context: window.JAG_CHAT_CTX = { mls, address, price } (set by /homes).
   ============================================================ */
(function(){
  if(window.__jagChat) return; window.__jagChat = true;
  var HOOK = 'https://starlingagent.app.n8n.cloud/webhook/aecb9bc9-7228-484b-9b0e-f8d119c1d159';
  var TEAM_PHONE = '(832) 702-3574';
  var MAX_MSGS = 25;

  function ls(k, v){ try{ if(v === undefined) return JSON.parse(localStorage.getItem(k) || 'null'); localStorage.setItem(k, JSON.stringify(v)); }catch(e){ return null; } }
  function ss(k, v){ try{ if(v === undefined) return JSON.parse(sessionStorage.getItem(k) || 'null'); sessionStorage.setItem(k, JSON.stringify(v)); }catch(e){ return null; } }
  function lang(){ try{ return localStorage.getItem('jag_lang') === 'en' ? 'en' : 'es'; }catch(e){ return 'es'; } }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function digits(s){ return String(s || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); }
  function fmtPhone(d){ return d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : d; }
  function newId(){ return 'web-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }

  var T = {
    es: { bubble: '¿Preguntas?', title: 'Jason Aguirre Group', sub: 'Te contestamos aquí o por texto',
      hello: '¡Hola! 👋 Soy el asistente de Jason Aguirre Group. Pregúntame lo que quieras sobre comprar o vender casa: enganche, crédito, ITIN, cómo empezar…',
      chips: ['¿Cuánto necesito de enganche?', '¿Puedo comprar con ITIN?', '¿Cómo empiezo a comprar?', 'Quiero vender mi casa'],
      ph: 'Escribe tu pregunta…', send: 'Enviar',
      who: 'Para contestarte, ¿cómo te llamas y a qué número te escribimos?', name: 'Tu nombre', phone: 'Tu celular',
      consent: 'Acepto recibir mensajes de texto de Jason Aguirre Group sobre mi pregunta. Pueden aplicar cargos. Responde STOP para dejar de recibirlos.',
      go: 'Enviar mi pregunta', errName: 'Escribe tu nombre.', errPhone: 'Escribe un celular de 10 dígitos.', errConsent: 'Marca la casilla para que te podamos escribir.',
      typing: 'Escribiendo…', texted: function(n, p){ return '¡Gracias, ' + n + '! Ya recibimos tu pregunta. Te escribimos por texto al ' + p + ' en unos minutos.'; },
      fail: 'No pudimos enviar tu mensaje. Llámanos o escríbenos al ' + TEAM_PHONE + '.', cap: 'Seguimos por texto para atenderte mejor. ¡Gracias!',
      about: 'Sobre esta casa: ', close: 'Cerrar chat', open: 'Abrir chat' },
    en: { bubble: 'Questions?', title: 'Jason Aguirre Group', sub: 'We answer here or by text',
      hello: 'Hi! 👋 I\'m the Jason Aguirre Group assistant. Ask me anything about buying or selling a home: down payment, credit, ITIN, how to start…',
      chips: ['How much do I need for a down payment?', 'Can I buy with an ITIN?', 'How do I start buying?', 'I want to sell my home'],
      ph: 'Type your question…', send: 'Send',
      who: 'So we can answer, what\'s your name and the best number to text you?', name: 'Your name', phone: 'Your cell phone',
      consent: 'I agree to receive text messages from Jason Aguirre Group about my question. Message and data rates may apply. Reply STOP to opt out.',
      go: 'Send my question', errName: 'Enter your name.', errPhone: 'Enter a 10-digit cell number.', errConsent: 'Check the box so we can text you.',
      typing: 'Typing…', texted: function(n, p){ return 'Thanks, ' + n + '! We got your question. We\'ll text you at ' + p + ' in a few minutes.'; },
      fail: 'We couldn\'t send your message. Call or text us at ' + TEAM_PHONE + '.', cap: 'Let\'s keep going by text so we can help you better. Thanks!',
      about: 'About this home: ', close: 'Close chat', open: 'Open chat' }
  };

  var S = ss('jag_chat') || { id: newId(), log: [], sent: 0, mode: null };
  var who = ls('jag_chat_who') || null;   // { name, phone, consent }
  var pending = null;                      // a question waiting for name/phone
  function persist(){ ss('jag_chat', S); }

  var css = '.jc-b{position:fixed;right:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:9990;display:flex;align-items:center;gap:8px;border:0;border-radius:99px;background:#c8102e;color:#fff;font:700 15px/1 "Plus Jakarta Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:13px 18px 13px 14px;box-shadow:0 8px 24px rgba(200,16,46,.35);cursor:pointer;transition:transform .15s,bottom .2s}' +
    '.jc-b:hover{transform:translateY(-2px)}.jc-b svg{width:22px;height:22px;fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.jc-b.up{bottom:calc(84px + env(safe-area-inset-bottom,0px))}' +
    '.jc{position:fixed;right:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:9991;width:min(380px,calc(100vw - 32px));height:min(560px,calc(100vh - 32px));background:#fff;color:#17161c;border-radius:20px;box-shadow:0 18px 60px rgba(23,22,28,.28);display:none;flex-direction:column;overflow:hidden;font-family:"Plus Jakarta Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}' +
    '.jc.on{display:flex}@media(max-width:520px){.jc{right:0;left:0;bottom:0;width:100%;height:100%;max-height:100dvh;border-radius:0}}' +
    '.jc-h{display:flex;align-items:center;gap:10px;padding:14px 14px 12px;background:#17161c;color:#fff}.jc-av{width:38px;height:38px;border-radius:11px;background:#17161c url(apple-touch-icon.png) center/cover;border:1px solid rgba(255,255,255,.25)}' +
    '.jc-h b{display:block;font-size:15px}.jc-h small{font-size:12px;opacity:.75}.jc-x{margin-left:auto;border:0;background:rgba(255,255,255,.12);color:#fff;width:34px;height:34px;border-radius:50%;font-size:20px;cursor:pointer}' +
    '.jc-m{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px;background:#f5f5f7}' +
    '.jc-msg{max-width:84%;padding:10px 13px;border-radius:16px;font-size:14.5px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word}' +
    '.jc-ai{align-self:flex-start;background:#fff;border-bottom-left-radius:5px;box-shadow:0 1px 2px rgba(0,0,0,.06)}.jc-me{align-self:flex-end;background:#c8102e;color:#fff;border-bottom-right-radius:5px}' +
    '.jc-ctx{align-self:center;font-size:12px;color:#6a6972;background:#fff;border-radius:99px;padding:5px 10px}' +
    '.jc-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:2px}.jc-chips button{border:1.5px solid #e3e3e8;background:#fff;color:#17161c;border-radius:99px;padding:8px 11px;font:600 13px/1.2 "Plus Jakarta Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;cursor:pointer;text-align:left}' +
    '.jc-chips button:hover{border-color:#c8102e}' +
    '.jc-who{align-self:stretch;background:#fff;border-radius:14px;padding:12px;display:flex;flex-direction:column;gap:8px;box-shadow:0 1px 2px rgba(0,0,0,.06)}' +
    '.jc-who p{margin:0;font-size:14px;font-weight:600}.jc-who input[type=text],.jc-who input[type=tel]{height:44px;border:2px solid #e3e3e8;border-radius:10px;padding:0 11px;font:600 15px "Plus Jakarta Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;width:100%;box-sizing:border-box}' +
    '.jc-who label{display:flex;gap:8px;align-items:flex-start;font-size:11.5px;line-height:1.4;color:#5f5e68}.jc-who label input{margin-top:2px;flex:0 0 auto}' +
    '.jc-who .jc-err{color:#a30d26;font-size:12.5px;font-weight:700;display:none}.jc-who button{border:0;border-radius:99px;background:#c8102e;color:#fff;font:700 14.5px "Plus Jakarta Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:12px;cursor:pointer}' +
    '.jc-f{display:flex;gap:8px;padding:10px;border-top:1px solid #ececf0;background:#fff;padding-bottom:calc(10px + env(safe-area-inset-bottom,0px))}' +
    '.jc-f textarea{flex:1;resize:none;height:44px;max-height:110px;border:2px solid #e3e3e8;border-radius:14px;padding:11px 12px;font:500 15px/1.3 "Plus Jakarta Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;box-sizing:border-box}' +
    '.jc-f textarea:focus,.jc-who input:focus{outline:none;border-color:#17161c}.jc-f button{border:0;border-radius:14px;background:#c8102e;color:#fff;font:700 14px "Plus Jakarta Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:0 16px;cursor:pointer}' +
    '.jc-f button:disabled{opacity:.5}.jc-dots{display:inline-flex;gap:4px}.jc-dots i{width:6px;height:6px;border-radius:50%;background:#a9a8b0;animation:jcd 1s infinite}' +
    '.jc-dots i:nth-child(2){animation-delay:.15s}.jc-dots i:nth-child(3){animation-delay:.3s}@keyframes jcd{50%{opacity:.25}}@media(prefers-reduced-motion:reduce){.jc-dots i{animation:none}}';

  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  var L = function(){ return T[lang()]; };
  var bub = document.createElement('button');
  bub.type = 'button'; bub.className = 'jc-b';
  bub.innerHTML = '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.6A8 8 0 1 1 21 12z"/></svg><span></span>';
  var box = document.createElement('div');
  box.className = 'jc'; box.setAttribute('role', 'dialog');
  box.innerHTML = '<div class="jc-h"><div class="jc-av" aria-hidden="true"></div><div><b></b><small></small></div><button type="button" class="jc-x">×</button></div>' +
    '<div class="jc-m" aria-live="polite"></div><form class="jc-f"><textarea rows="1" id="jc-text"></textarea><button type="submit"></button></form>';
  function mount(){ document.body.appendChild(bub); document.body.appendChild(box); paintStatic(); render(); }

  var M = function(){ return box.querySelector('.jc-m'); };
  function paintStatic(){
    var l = L();
    bub.querySelector('span').textContent = l.bubble; bub.setAttribute('aria-label', l.open);
    box.setAttribute('aria-label', l.title);
    box.querySelector('.jc-h b').textContent = l.title; box.querySelector('.jc-h small').textContent = l.sub;
    box.querySelector('.jc-x').setAttribute('aria-label', l.close);
    box.querySelector('textarea').placeholder = l.ph; box.querySelector('.jc-f button').textContent = l.send;
  }
  function render(){
    var l = L(), h = '<div class="jc-msg jc-ai">' + esc(l.hello) + '</div>';
    if(!S.log.length) h += '<div class="jc-chips">' + l.chips.map(function(c){ return '<button type="button">' + esc(c) + '</button>'; }).join('') + '</div>';
    S.log.forEach(function(m){ h += m.ctx ? '<div class="jc-ctx">' + esc(m.text) + '</div>' : '<div class="jc-msg ' + (m.me ? 'jc-me' : 'jc-ai') + '">' + esc(m.text) + '</div>'; });
    if(pending) h += whoForm();
    M().innerHTML = h;
    M().scrollTop = M().scrollHeight;
  }
  function whoForm(){
    var l = L();
    return '<form class="jc-who" novalidate><p>' + esc(l.who) + '</p><input type="text" id="jc-name" autocomplete="name" placeholder="' + esc(l.name) + '" value="' + esc(who && who.name || '') + '">' +
      '<input type="tel" id="jc-phone" inputmode="tel" autocomplete="tel" placeholder="' + esc(l.phone) + '" value="' + esc(who && who.phone ? fmtPhone(who.phone) : '') + '">' +
      '<label><input type="checkbox" id="jc-ok"> <span>' + esc(l.consent) + '</span></label><span class="jc-err"></span><button type="submit">' + esc(l.go) + '</button></form>';
  }
  function add(text, me, ctx){ S.log.push({ text: text, me: !!me, ctx: !!ctx, at: Date.now() }); persist(); render(); }
  function typing(on){
    var t = M().querySelector('.jc-typing');
    if(on && !t){ var d = document.createElement('div'); d.className = 'jc-msg jc-ai jc-typing'; d.innerHTML = '<span class="jc-dots" aria-label="' + L().typing + '"><i></i><i></i><i></i></span>'; M().appendChild(d); M().scrollTop = M().scrollHeight; }
    if(!on && t) t.remove();
  }

  function open(){ box.classList.add('on'); bub.style.display = 'none'; setTimeout(function(){ var t = box.querySelector('textarea'); if(t && innerWidth > 520) t.focus(); }, 50); }
  function close(){ box.classList.remove('on'); bub.style.display = ''; }
  bub.addEventListener('click', open);
  box.querySelector('.jc-x').addEventListener('click', close);
  document.addEventListener('keydown', function(e){ if(e.key === 'Escape' && box.classList.contains('on')) close(); });
  window.JagChat = { open: open, ask: function(q){ open(); ask(q); } };

  // keep the bubble above bottom action bars (listing page buttons, install popup)
  setInterval(function(){
    var bar = document.querySelector('.mbar'), up = false;
    if(bar && bar.offsetParent !== null && innerWidth < 900){ var r = bar.getBoundingClientRect(); up = r.top < innerHeight && r.bottom > innerHeight - 4; }
    bub.classList.toggle('up', up);
  }, 800);

  box.addEventListener('click', function(e){
    var c = e.target.closest('.jc-chips button'); if(c) ask(c.textContent);
  });
  box.querySelector('.jc-f').addEventListener('submit', function(e){
    e.preventDefault(); var t = box.querySelector('textarea'), q = t.value.trim(); if(!q) return; t.value = ''; ask(q);
  });
  box.querySelector('textarea').addEventListener('keydown', function(e){
    if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); box.querySelector('.jc-f').requestSubmit ? box.querySelector('.jc-f').requestSubmit() : box.querySelector('.jc-f button').click(); }
  });
  box.addEventListener('submit', function(e){
    if(!e.target.classList.contains('jc-who')) return;
    e.preventDefault();
    var l = L(), n = box.querySelector('#jc-name').value.trim(), p = digits(box.querySelector('#jc-phone').value), ok = box.querySelector('#jc-ok').checked, er = box.querySelector('.jc-who .jc-err');
    var msg = n.length < 2 ? l.errName : p.length !== 10 ? l.errPhone : !ok ? l.errConsent : '';
    if(msg){ er.textContent = msg; er.style.display = 'block'; return; }
    who = { name: n.slice(0, 80), phone: p, consent: new Date().toISOString() }; ls('jag_chat_who', who);
    var q = pending; pending = null; render(); deliver(q);
  }, true);

  function ask(q){
    q = String(q || '').trim().slice(0, 1000); if(!q) return;
    var ctx = window.JAG_CHAT_CTX;
    if(ctx && ctx.mls && S.lastCtx !== ctx.mls){ S.lastCtx = ctx.mls; add(L().about + (ctx.address || 'MLS ' + ctx.mls), false, true); }
    add(q, true);
    if(S.sent >= MAX_MSGS){ add(L().cap); return; }
    if(!who || !who.phone || !who.consent){ pending = q; render(); var f = box.querySelector('#jc-name'); if(f) f.focus(); return; }
    deliver(q);
  }

  function replyText(data){
    if(data == null) return '';
    if(Array.isArray(data)) data = data[0] || {};
    if(typeof data === 'string') return data;
    var t = data.reply || data.output || data.text || data.answer || data.response || data.message || '';
    if(typeof t !== 'string') t = '';
    return /workflow (was|got) started/i.test(t) ? '' : t.trim();
  }

  function deliver(q){
    var l = L(), ctx = window.JAG_CHAT_CTX || null, ref = ls('jag_ref');
    var parts = who.name.split(/\s+/);
    var payload = {
      source: 'website_chat', channel: 'web', sessionId: S.id, message: q, turn: S.sent + 1,
      name: who.name, first_name: parts[0], last_name: parts.slice(1).join(' '),
      phone: who.phone, phone_e164: '+1' + who.phone, consent: true, consent_at: who.consent,
      lang: lang(), language: lang() === 'en' ? 'English' : 'Spanish',
      page: location.href.split('#')[0], listing: ctx && ctx.mls ? { mls: ctx.mls, address: ctx.address || null, price: ctx.price || null } : null,
      agent_code: ref && ref.code ? ref.code : null, site: 'jasonaguirregroup.company'
    };
    S.sent++; persist();
    // first message also lands in the team's lead list (admin page)
    if(S.sent === 1 && window.jagCapture){
      try{ window.jagCapture('chat', { __name: who.name, Phone: fmtPhone(who.phone), 'Preferred Language': payload.language, Question: q,
        Property: ctx && ctx.address || null, 'MLS #': ctx && ctx.mls || null, Agent: payload.agent_code, 'Texting consent': who.consent }); }catch(e){}
    }
    typing(true); box.querySelector('.jc-f button').disabled = true;
    var ctrl = window.AbortController ? new AbortController() : null, timer = setTimeout(function(){ if(ctrl) ctrl.abort(); }, 45000);
    fetch(HOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: ctrl ? ctrl.signal : undefined })
      .then(function(r){ if(!r.ok) throw new Error(r.status); return r.text(); })
      .then(function(body){
        var data; try{ data = JSON.parse(body); }catch(e){ data = body; }
        var t = replyText(data);
        typing(false);
        if(t){ S.mode = 'inline'; add(t); }
        else if(S.mode !== 'sms'){ S.mode = 'sms'; add(l.texted(who.name.split(/\s+/)[0], fmtPhone(who.phone))); }
      })
      .catch(function(){ typing(false); S.sent = Math.max(0, S.sent - 1); add(l.fail); })
      .then(function(){ clearTimeout(timer); box.querySelector('.jc-f button').disabled = false; persist(); });
  }

  if(document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

  // follow the page's language toggle
  document.addEventListener('click', function(e){ if(e.target.closest && e.target.closest('[data-lang],.langs button')) setTimeout(function(){ paintStatic(); render(); }, 50); });
})();
