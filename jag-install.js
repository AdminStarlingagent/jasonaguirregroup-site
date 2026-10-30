/* ============================================================
   "Add JAG to your home screen" popup (until the real app exists).
   Shows ONLY on phones, ONLY to signed-in clients, and ONLY after they
   got value: right after they save their first home or search, or on a
   later visit once they have. Never on the first look around.
   "Ahora no" waits 14 days; at most 3 times total; never again once added.
   Spanish first (follows the language the client picked).
   Load after jag-account.js.
   ============================================================ */
(function(){
   if(window.top !== window) return;   // inside the JAG app (the site runs in a frame there): nothing to install
  var KEY = 'jag_a2hs', SNOOZE_DAYS = 14, MAX_SHOWS = 3;
  var ua = navigator.userAgent || '';
  var isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var isAndroid = /Android/i.test(ua);
  var isPhone = (isIOS || isAndroid) && Math.min(screen.width, screen.height) < 820;
  var standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  var deferred = null;

  function load(){ try{ return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; }catch(e){ return {}; } }
  function save(s){ try{ localStorage.setItem(KEY, JSON.stringify(s)); }catch(e){} }
  function lang(){ try{ return localStorage.getItem('jag_lang') === 'en' ? 'en' : 'es'; }catch(e){ return 'es'; } }
  function signedIn(){ return !!(window.JagAccount && JagAccount.user && JagAccount.user()); }

  // Opened from the home screen already: nothing to ask, ever.
  if(standalone){ var s0 = load(); if(!s0.done){ s0.done = true; save(s0); } return; }

  window.addEventListener('beforeinstallprompt', function(e){ e.preventDefault(); deferred = e; });
  window.addEventListener('appinstalled', function(){ var s = load(); s.done = true; save(s); close(); });

  function eligible(){
    var s = load();
    return isPhone && signedIn() && s.value_at && !s.done && (s.shows || 0) < MAX_SHOWS && Date.now() > (s.snooze_until || 0);
  }

  var T = {
    es: { title: 'Ten tus casas a un toque', body: 'Agrega JAG a la pantalla de inicio de tu teléfono. Abres tus casas guardadas y avisos como una app, sin descargar nada.',
      ios: ['Toca el botón <b>Compartir</b> <span class="ji-share" aria-hidden="true"></span> en la barra del navegador.', 'Baja y elige <b>Agregar a inicio</b>.', 'Toca <b>Agregar</b>. ¡Listo!'],
      and: ['Toca el menú <b>⋮</b> arriba a la derecha.', 'Elige <b>Agregar a la pantalla principal</b> o <b>Instalar app</b>.', 'Confirma con <b>Agregar</b>. ¡Listo!'],
      add: 'Agregar a mi pantalla', later: 'Ahora no', done: 'Ya la agregué', close: 'Cerrar' },
    en: { title: 'Your homes, one tap away', body: 'Add JAG to your phone\'s home screen. Open your saved homes and alerts like an app, nothing to download.',
      ios: ['Tap the <b>Share</b> button <span class="ji-share" aria-hidden="true"></span> in the browser bar.', 'Scroll down and choose <b>Add to Home Screen</b>.', 'Tap <b>Add</b>. Done!'],
      and: ['Tap the <b>⋮</b> menu at the top right.', 'Choose <b>Add to Home screen</b> or <b>Install app</b>.', 'Confirm with <b>Add</b>. Done!'],
      add: 'Add to my home screen', later: 'Not now', done: 'I added it', close: 'Close' }
  };

  var css = '.ji-wrap{position:fixed;left:0;right:0;bottom:0;z-index:9999;padding:0 12px calc(12px + env(safe-area-inset-bottom,0px));display:flex;justify-content:center;pointer-events:none}' +
    '.ji{pointer-events:auto;width:100%;max-width:440px;background:#fff;color:#17161c;border-radius:20px;box-shadow:0 -6px 40px rgba(23,22,28,.22),0 2px 8px rgba(23,22,28,.12);padding:18px 18px 14px;font-family:"Plus Jakarta Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;transform:translateY(120%);transition:transform .35s cubic-bezier(.2,.8,.2,1)}' +
    '.ji.on{transform:none}@media(prefers-reduced-motion:reduce){.ji{transition:none}}' +
    '.ji-top{display:flex;gap:12px;align-items:flex-start}.ji-ic{flex:0 0 52px;width:52px;height:52px;border-radius:13px;background:#17161c url(apple-touch-icon.png) center/cover;box-shadow:0 2px 6px rgba(0,0,0,.18)}' +
    '.ji h3{margin:0 0 3px;font-size:17px;font-weight:800;letter-spacing:-.01em}.ji p{margin:0;font-size:14px;line-height:1.45;color:#45444c}' +
    '.ji-x{margin-left:auto;flex:0 0 auto;border:0;background:#f5f5f7;width:32px;height:32px;border-radius:50%;font-size:18px;line-height:1;color:#45444c;cursor:pointer}' +
    '.ji ol{margin:14px 0 4px;padding:0;list-style:none;counter-reset:s;display:flex;flex-direction:column;gap:9px}' +
    '.ji li{counter-increment:s;display:flex;gap:10px;align-items:center;font-size:14.5px;line-height:1.4}' +
    '.ji li::before{content:counter(s);flex:0 0 24px;height:24px;border-radius:50%;background:#c8102e;color:#fff;font-weight:800;font-size:12.5px;display:grid;place-items:center}' +
    '.ji-share{display:inline-block;width:16px;height:18px;vertical-align:-3px;background:no-repeat center/contain url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 20 24%27 fill=%27none%27 stroke=%27%232653d9%27 stroke-width=%272%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27%3E%3Cpath d=%27M10 15V2M5.5 6.5L10 2l4.5 4.5M6 10H3v12h14V10h-3%27/%3E%3C/svg%3E")}' +
    '.ji-btns{display:flex;gap:8px;margin-top:14px}.ji-btns button{flex:1;border:0;border-radius:99px;padding:12px 14px;font:inherit;font-size:14.5px;font-weight:700;cursor:pointer}' +
    '.ji-go{background:#c8102e;color:#fff}.ji-no{background:#f5f5f7;color:#17161c}' +
    '.ji-arrow{position:fixed;left:50%;bottom:calc(4px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);font-size:22px;color:#c8102e;z-index:9998;animation:jib 1.2s ease-in-out infinite;pointer-events:none}' +
    '@keyframes jib{50%{transform:translate(-50%,-6px)}}@media(prefers-reduced-motion:reduce){.ji-arrow{animation:none}}';

  var root = null;
  function close(){ if(!root) return; var r = root; root = null; var c = r.querySelector('.ji'); if(c) c.classList.remove('on'); setTimeout(function(){ if(r.parentNode) r.parentNode.removeChild(r); }, 380); }

  function show(){
    if(root || !eligible()) return;
    // never on top of another dialog (sign-in, showing request...)
    var busy = [].some.call(document.querySelectorAll('[aria-modal="true"]'), function(d){ return d.offsetParent !== null; });
    if(busy){ setTimeout(show, 5000); return; }
    var L = T[lang()], s = load();
    s.shows = (s.shows || 0) + 1; s.last_shown = Date.now(); save(s);
    if(!document.getElementById('ji-css')){ var st = document.createElement('style'); st.id = 'ji-css'; st.textContent = css; document.head.appendChild(st); }
    var oneTap = !!deferred && !isIOS;
    var steps = isIOS ? L.ios : L.and;
    root = document.createElement('div');
    root.className = 'ji-wrap';
    root.innerHTML = '<div class="ji" role="dialog" aria-label="' + L.title + '"><div class="ji-top"><div class="ji-ic" aria-hidden="true"></div><div><h3>' + L.title + '</h3><p>' + L.body + '</p></div>' +
      '<button type="button" class="ji-x" aria-label="' + L.close + '">×</button></div>' +
      (oneTap ? '' : '<ol>' + steps.map(function(x){ return '<li><span>' + x + '</span></li>'; }).join('') + '</ol>') +
      '<div class="ji-btns"><button type="button" class="ji-no">' + L.later + '</button>' +
      '<button type="button" class="ji-go">' + (oneTap ? L.add : L.done) + '</button></div></div>' ;
    document.body.appendChild(root);
    requestAnimationFrame(function(){ requestAnimationFrame(function(){ var c = root && root.querySelector('.ji'); if(c) c.classList.add('on'); }); });
    function later(){ var s2 = load(); s2.snooze_until = Date.now() + SNOOZE_DAYS * 864e5; save(s2); close(); }
    root.querySelector('.ji-x').onclick = later;
    root.querySelector('.ji-no').onclick = later;
    root.querySelector('.ji-go').onclick = function(){
      if(oneTap && deferred){
        var d = deferred; deferred = null;
        d.prompt();
        (d.userChoice || Promise.resolve({})).then(function(r){ var s3 = load(); if(r && r.outcome === 'accepted') s3.done = true; else s3.snooze_until = Date.now() + SNOOZE_DAYS * 864e5; save(s3); close(); });
      } else { var s4 = load(); s4.done = true; save(s4); close(); }
    };
  }

  // The value moment: their first saved home or saved search.
  function markValue(){
    var s = load();
    var first = !s.value_at;
    if(first){ s.value_at = Date.now(); save(s); }
    if(first) setTimeout(show, 6000);   // after the "saved" toast, not on top of it
  }
  function hook(){
    var A = window.JagAccount; if(!A || A.__a2hs) return; A.__a2hs = true;
    ['addFavorite', 'addSearch'].forEach(function(fn){
      var orig = A[fn]; if(typeof orig !== 'function') return;
      A[fn] = function(){ var p = orig.apply(this, arguments); try{ Promise.resolve(p).then(markValue, function(){}); }catch(e){} return p; };
    });
  }
  hook();

  // A later visit: they already saved something before, so remind them (once per visit).
  function onLoad(){
    var s = load();
    var seen = false; try{ seen = !!sessionStorage.getItem('jag_a2hs_seen'); }catch(e){}
    if(s.value_at && !seen && Date.now() - s.value_at > 30 * 60 * 1000){
      try{ sessionStorage.setItem('jag_a2hs_seen', '1'); }catch(e){}
      setTimeout(show, 8000);
    }
  }
  if(document.readyState === 'complete') onLoad(); else window.addEventListener('load', onLoad);
})();
