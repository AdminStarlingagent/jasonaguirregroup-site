/* ============================================================
   JAG client accounts: sign in with a 6-digit email code (no password),
   favorites, saved searches, activity for recommendations.
   Talks to Supabase Auth + REST with the public key; row-level security
   means each client can only ever read or change their own rows.
   ============================================================ */
(function(){
  var URL_ = 'https://nyaxywghbpphjhwcmspd.supabase.co';
  var KEY  = 'sb_publishable_a3LN_l283LN8J-bJTEO8hQ_U40t09eh';
  var STORE = 'jag_client_session';

  var T = {
    es:{ signin:'Iniciar sesión', account:'Mi cuenta', saved:'Casas guardadas', searches:'Búsquedas guardadas', signout:'Cerrar sesión',
      h1:'Inicie sesión o cree su cuenta', p1:'Guarde casas, reciba avisos de casas nuevas y vea recomendaciones para usted. Sin contraseña: le enviamos un código a su correo.',
      email:'Correo electrónico', send:'Enviarme el código', terms:'Al continuar acepta nuestros <a href="privacy-terms.html" target="_blank" rel="noopener">términos y privacidad</a>. Puede borrar su cuenta cuando quiera.',
      h2:'Revise su correo', p2:'Escribimos un código de 6 dígitos a ', code:'Código de 6 dígitos', verify:'Entrar', resend:'Reenviar código', other:'Usar otro correo',
      h3:'¡Bienvenido! ¿Cómo se llama?', p3:'Así sabemos cómo dirigirnos a usted. El teléfono es opcional.', name:'Nombre', phone:'Teléfono (opcional)', done:'Listo', skip:'Ahora no',
      bademail:'Escriba un correo válido.', badcode:'Ese código no funcionó o ya venció. Intente otra vez o pida uno nuevo.', wait:'Espere un momento antes de pedir otro código.', neterr:'No pudimos conectar. Intente de nuevo.',
      why_fav:'Inicie sesión para guardar esta casa y recibir avisos si cambia de precio.', why_search:'Inicie sesión para guardar esta búsqueda y recibir avisos de casas nuevas.', sent_again:'Código enviado otra vez.', close:'Cerrar' },
    en:{ signin:'Sign in', account:'My account', saved:'Saved homes', searches:'Saved searches', signout:'Sign out',
      h1:'Sign in or create your account', p1:'Save homes, get alerts on new listings and see picks for you. No password: we email you a code.',
      email:'Email', send:'Email me a code', terms:'By continuing you agree to our <a href="privacy-terms.html" target="_blank" rel="noopener">terms and privacy</a>. You can delete your account any time.',
      h2:'Check your email', p2:'We sent a 6-digit code to ', code:'6-digit code', verify:'Sign in', resend:'Resend code', other:'Use a different email',
      h3:'Welcome! What is your name?', p3:'So we know how to address you. Phone is optional.', name:'Name', phone:'Phone (optional)', done:'Done', skip:'Not now',
      bademail:'Enter a valid email.', badcode:'That code did not work or expired. Try again or request a new one.', wait:'Please wait a moment before requesting another code.', neterr:'We could not connect. Please try again.',
      why_fav:'Sign in to save this home and get alerts if the price changes.', why_search:'Sign in to save this search and get alerts on new homes.', sent_again:'Code sent again.', close:'Close' }
  };
  function lang(){ try{ var v=localStorage.getItem('jag_lang'); if(v==='en'||v==='es') return v; }catch(e){} return 'es'; }
  function t(k){ return (T[lang()]||T.es)[k]; }
  function esc(v){ return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }

  /* ---------- session ---------- */
  var S=null, listeners=[], refreshing=null, profile=null;
  try{ S=JSON.parse(localStorage.getItem(STORE)||'null'); }catch(e){ S=null; }
  function save(){ try{ if(S) localStorage.setItem(STORE, JSON.stringify(S)); else localStorage.removeItem(STORE); }catch(e){} }
  function setSession(j){
    S={ access_token:j.access_token, refresh_token:j.refresh_token,
        expires_at: j.expires_at ? j.expires_at*1000 : Date.now()+(j.expires_in||3600)*1000,
        user:{ id:(j.user||{}).id, email:(j.user||{}).email } };
    save();
  }
  function emit(){ listeners.forEach(function(f){ try{ f(api.user()); }catch(e){} }); paintButtons(); }
  function refresh(){
    if(refreshing) return refreshing;
    if(!S||!S.refresh_token) return Promise.resolve(false);
    refreshing=fetch(URL_+'/auth/v1/token?grant_type=refresh_token',{method:'POST',headers:{apikey:KEY,'Content-Type':'application/json'},body:JSON.stringify({refresh_token:S.refresh_token})})
      .then(function(r){ return r.json().then(function(j){ return {ok:r.ok,j:j}; }); })
      .then(function(x){ refreshing=null; if(x.ok&&x.j.access_token){ setSession(x.j); return true; } if(x.j&&(x.j.error_code==='refresh_token_not_found'||x.j.error_code==='session_not_found'||x.j.code===400)){ S=null; profile=null; save(); emit(); } return false; })
      .catch(function(){ refreshing=null; return false; });
    return refreshing;
  }
  function token(){
    if(!S) return Promise.resolve(null);
    if(S.expires_at-Date.now()>60000) return Promise.resolve(S.access_token);
    return refresh().then(function(){ return S?S.access_token:null; });
  }
  function rest(path, opts){
    opts=opts||{};
    return token().then(function(tk){
      if(!tk) return Promise.reject(new Error('signed_out'));
      return fetch(URL_+path,{method:opts.method||'GET',body:opts.body,
        headers:Object.assign({apikey:KEY,Authorization:'Bearer '+tk,'Content-Type':'application/json'},opts.headers||{})});
    }).then(function(r){
      if(r.status===401) return refresh().then(function(ok){ if(!ok) throw new Error('signed_out'); return rest(path,opts); });
      return r;
    });
  }
  function json(path, opts){ return rest(path,opts).then(function(r){ if(!r.ok) return r.text().then(function(x){ throw new Error(x||r.status); }); return r.status===204?null:r.json(); }); }
  function rpc(name, args){ return json('/rest/v1/rpc/'+name,{method:'POST',body:JSON.stringify(args||{})}); }

  /* ---------- auth calls ---------- */
  function sendCode(email){
    return fetch(URL_+'/auth/v1/otp',{method:'POST',headers:{apikey:KEY,'Content-Type':'application/json'},
      body:JSON.stringify({email:email,create_user:true,data:{lang:lang()}})})
      .then(function(r){ if(r.ok) return true; return r.json().catch(function(){return {};}).then(function(j){ var e=new Error(j.error_code||j.msg||'send_failed'); e.status=r.status; throw e; }); });
  }
  function verify(email, code){
    return fetch(URL_+'/auth/v1/verify',{method:'POST',headers:{apikey:KEY,'Content-Type':'application/json'},
      body:JSON.stringify({type:'email',email:email,token:code})})
      .then(function(r){ return r.json().then(function(j){ if(!r.ok||!j.access_token) throw new Error('bad_code'); setSession(j); return j; }); });
  }
  function init(extra){
    extra=extra||{};
    return rpc('jag_client_init',{p_name:extra.name||null,p_phone:extra.phone||null,p_lang:lang(),p_terms:true})
      .then(function(j){ profile=(j&&j.profile)||profile; return j; });
  }
  function signOut(){
    var tk=S&&S.access_token;
    if(tk) fetch(URL_+'/auth/v1/logout',{method:'POST',headers:{apikey:KEY,Authorization:'Bearer '+tk}}).catch(function(){});
    S=null; profile=null; save(); emit();
  }

  /* ---------- data helpers ---------- */
  function favorites(){ return json('/rest/v1/jag_client_favorites?select=*&order=saved_at.desc'); }
  function addFavorite(l){
    var snap=snapOf(l);
    return json('/rest/v1/jag_client_favorites?on_conflict=user_id,mls',{method:'POST',
      headers:{Prefer:'resolution=ignore-duplicates,return=minimal'},
      body:JSON.stringify({mls:String(l.mlsNumber),snap:snap,last_price:l.listPrice||null,last_status:'Active'})});
  }
  function removeFavorite(mls){ return json('/rest/v1/jag_client_favorites?mls=eq.'+encodeURIComponent(mls),{method:'DELETE'}); }
  function searchesList(){ return json('/rest/v1/jag_client_searches?select=*&order=created_at.desc'); }
  function addSearch(label, params){
    return json('/rest/v1/jag_client_searches',{method:'POST',headers:{Prefer:'return=representation'},
      body:JSON.stringify({label:String(label||'').slice(0,160),params:params})});
  }
  function updateSearch(id, patch){ return json('/rest/v1/jag_client_searches?id=eq.'+encodeURIComponent(id),{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify(patch)}); }
  function removeSearch(id){ return json('/rest/v1/jag_client_searches?id=eq.'+encodeURIComponent(id),{method:'DELETE'}); }
  function activity(limit){ return json('/rest/v1/jag_client_activity?select=*&order=created_at.desc&limit='+(limit||200)); }
  function logActivity(row){ if(!S) return; rest('/rest/v1/jag_client_activity',{method:'POST',headers:{Prefer:'return=minimal'},body:JSON.stringify(row)}).catch(function(){}); }
  function alerts(){ return json('/rest/v1/jag_client_alerts?select=*&order=created_at.desc&limit=100'); }
  function markAlertsSeen(){ return json('/rest/v1/jag_client_alerts?seen_at=is.null',{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({seen_at:new Date().toISOString()})}); }
  function getProfile(){ return json('/rest/v1/jag_clients?select=*&limit=1').then(function(r){ profile=(r&&r[0])||null; return profile; }); }
  function updateProfile(patch){ return json('/rest/v1/jag_clients?user_id=eq.'+encodeURIComponent(S.user.id),{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify(patch)}).then(function(r){ profile=(r&&r[0])||profile; return profile; }); }
  function deleteAccount(){ return rpc('jag_delete_my_account').then(function(j){ S=null; profile=null; save(); emit(); return j; }); }

  function snapOf(l){
    var a=l.address||{}, d=l.details||{};
    return { price:l.listPrice||null, beds:d.numBedrooms!=null?d.numBedrooms:null, baths:d.numBathrooms!=null?d.numBathrooms:null,
      sqft:d.sqft||null, photo:(l.images||[])[0]||null, zip:a.zip||null, city:a.city||null,
      addr:[a.streetNumber,a.streetDirectionPrefix,a.streetName,a.streetSuffix,a.streetDirection].filter(Boolean).join(' ')+(a.unitNumber?' #'+a.unitNumber:''),
      type:l.type||null, ptype:d.propertyType||null };
  }

  /* ---------- sign-in modal ---------- */
  var css='.ja-ov{position:fixed;inset:0;background:rgba(15,14,20,.55);z-index:9000;display:none;align-items:center;justify-content:center;padding:16px}'+
    '.ja-ov.on{display:flex}.ja-box{background:#fff;color:#17161c;border-radius:16px;width:100%;max-width:420px;padding:26px 22px 22px;position:relative;box-shadow:0 20px 60px rgba(0,0,0,.25);font-family:inherit}'+
    '.ja-box h3{font-size:21px;font-weight:800;margin:0 0 6px;line-height:1.2}.ja-box p{color:#5f5e68;margin:0 0 14px;font-size:14px}.ja-box .why{background:#fdecef;color:#a30d26;border-radius:10px;padding:9px 12px;font-weight:700;font-size:13px;margin:0 0 12px}'+
    '.ja-box label{display:block;font-weight:700;font-size:13px;margin:0 0 5px}.ja-box input{width:100%;border:1.5px solid #c9c8d0;border-radius:10px;padding:12px;font-size:16px;margin:0 0 12px;font-family:inherit}'+
    '.ja-box input:focus{outline:none;border-color:#17161c}.ja-box input.code{letter-spacing:.4em;text-align:center;font-size:22px;font-weight:800}'+
    '.ja-btn{width:100%;border:0;border-radius:10px;background:#c8102e;color:#fff;font-weight:800;font-size:15.5px;padding:13px;cursor:pointer;font-family:inherit}.ja-btn:hover{background:#a30d26}.ja-btn[disabled]{opacity:.6;cursor:default}'+
    '.ja-link{border:0;background:none;color:#2653d9;font-weight:700;padding:8px 0;cursor:pointer;font-family:inherit;font-size:13.5px}.ja-row{display:flex;justify-content:space-between;gap:10px;margin-top:6px}'+
    '.ja-fine{font-size:12px;color:#85848d;margin:12px 0 0}.ja-fine a{color:inherit}.ja-err{color:#a30d26;font-weight:700;font-size:13px;margin:-4px 0 10px;display:none}.ja-err.on{display:block}'+
    '.ja-x{position:absolute;top:8px;right:10px;border:0;background:none;font-size:26px;line-height:1;color:#5f5e68;cursor:pointer;padding:6px}'+
    '.ja-acct{position:relative;display:inline-flex}.ja-sbtn{border:1.5px solid #17161c;background:#fff;border-radius:8px;font-weight:800;font-size:13px;padding:7px 12px;cursor:pointer;white-space:nowrap;font-family:inherit;color:#17161c}'+
    '.ja-av{width:34px;height:34px;border-radius:50%;border:0;background:#17161c;color:#fff;font-weight:800;font-size:14px;cursor:pointer;font-family:inherit;position:relative}'+
    '.ja-av i{position:absolute;top:-3px;right:-3px;min-width:16px;height:16px;border-radius:8px;background:#c8102e;color:#fff;font-size:10px;font-style:normal;line-height:16px;padding:0 4px;display:none}.ja-av i.on{display:block}'+
    '.ja-menu{position:absolute;right:0;top:42px;background:#fff;border:1px solid #dddde3;border-radius:12px;box-shadow:0 12px 30px rgba(0,0,0,.14);min-width:210px;padding:6px;display:none;z-index:8000}.ja-menu.on{display:block}'+
    '.ja-menu .em{font-size:12px;color:#85848d;padding:8px 10px 6px;word-break:break-all}.ja-menu a,.ja-menu button{display:block;width:100%;text-align:left;border:0;background:none;padding:10px;border-radius:8px;font-weight:700;font-size:14px;color:#17161c;text-decoration:none;cursor:pointer;font-family:inherit}'+
    '.ja-menu a:hover,.ja-menu button:hover{background:#f5f5f7}';
  var ov=null, step='email', email='', why='', pending=null, cooldown=0;
  function ensureModal(){
    if(ov) return;
    var st=document.createElement('style'); st.textContent=css; document.head.appendChild(st);
    ov=document.createElement('div'); ov.className='ja-ov'; ov.setAttribute('role','dialog'); ov.setAttribute('aria-modal','true');
    ov.innerHTML='<div class="ja-box"><button type="button" class="ja-x">×</button><div class="ja-body"></div></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click',function(e){ if(e.target===ov) close(); });
    ov.querySelector('.ja-x').onclick=close;
    document.addEventListener('keydown',function(e){ if(e.key==='Escape'&&ov.classList.contains('on')) close(); });
  }
  function close(){ if(ov) ov.classList.remove('on'); if(pending&&pending.reject){ var p=pending; pending=null; p.reject(new Error('cancelled')); } }
  function render(){
    var b=ov.querySelector('.ja-body'); ov.querySelector('.ja-x').setAttribute('aria-label',t('close'));
    if(step==='email'){
      b.innerHTML=(why?'<div class="why">'+esc(why)+'</div>':'')+'<h3>'+t('h1')+'</h3><p>'+t('p1')+'</p>'+
        '<form novalidate><label for="ja-e">'+t('email')+'</label><input id="ja-e" type="email" autocomplete="email" inputmode="email" value="'+esc(email)+'">'+
        '<div class="ja-err" id="ja-err"></div><button class="ja-btn" type="submit">'+t('send')+'</button><p class="ja-fine">'+t('terms')+'</p></form>';
      var f=b.querySelector('form'), inp=b.querySelector('#ja-e');
      setTimeout(function(){ inp.focus(); },50);
      f.onsubmit=function(e){ e.preventDefault();
        var v=inp.value.trim().toLowerCase();
        if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return err(t('bademail'));
        var btn=f.querySelector('button'); btn.disabled=true;
        sendCode(v).then(function(){ email=v; step='code'; cooldown=Date.now()+60000; render(); })
          .catch(function(x){ btn.disabled=false; err(x.status===429?t('wait'):t('neterr')); });
      };
    }else if(step==='code'){
      b.innerHTML='<h3>'+t('h2')+'</h3><p>'+t('p2')+'<b>'+esc(email)+'</b></p>'+
        '<form novalidate><label for="ja-c">'+t('code')+'</label><input id="ja-c" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="10">'+
        '<div class="ja-err" id="ja-err"></div><button class="ja-btn" type="submit">'+t('verify')+'</button>'+
        '<div class="ja-row"><button type="button" class="ja-link" id="ja-re">'+t('resend')+'</button><button type="button" class="ja-link" id="ja-ot">'+t('other')+'</button></div></form>';
      var f2=b.querySelector('form'), c=b.querySelector('#ja-c');
      setTimeout(function(){ c.focus(); },50);
      c.addEventListener('input',function(){ var d=c.value.replace(/\D/g,''); c.value=d; if(d.length===6) f2.requestSubmit?f2.requestSubmit():f2.onsubmit({preventDefault:function(){}}); });
      f2.onsubmit=function(e){ e.preventDefault();
        var v=c.value.replace(/\D/g,''); if(v.length<6) return err(t('badcode'));
        var btn=f2.querySelector('.ja-btn'); btn.disabled=true;
        verify(email,v).then(function(){ return init(); }).then(function(j){
          if(j&&j.new){ step='name'; render(); } else finish();
        }).catch(function(){ btn.disabled=false; c.value=''; err(t('badcode')); });
      };
      b.querySelector('#ja-re').onclick=function(){
        if(Date.now()<cooldown) return err(t('wait'));
        sendCode(email).then(function(){ cooldown=Date.now()+60000; err(t('sent_again')); }).catch(function(x){ err(x.status===429?t('wait'):t('neterr')); });
      };
      b.querySelector('#ja-ot').onclick=function(){ step='email'; render(); };
    }else if(step==='name'){
      b.innerHTML='<h3>'+t('h3')+'</h3><p>'+t('p3')+'</p><form novalidate><label for="ja-n">'+t('name')+'</label><input id="ja-n" autocomplete="name">'+
        '<label for="ja-p">'+t('phone')+'</label><input id="ja-p" type="tel" autocomplete="tel" inputmode="tel">'+
        '<button class="ja-btn" type="submit">'+t('done')+'</button><div class="ja-row"><span></span><button type="button" class="ja-link" id="ja-sk">'+t('skip')+'</button></div></form>';
      var f3=b.querySelector('form');
      setTimeout(function(){ b.querySelector('#ja-n').focus(); },50);
      f3.onsubmit=function(e){ e.preventDefault();
        var n=b.querySelector('#ja-n').value.trim(), p=b.querySelector('#ja-p').value.trim();
        var btn=f3.querySelector('.ja-btn'); btn.disabled=true;
        (n||p?init({name:n,phone:p}):Promise.resolve()).catch(function(){}).then(finish);
      };
      b.querySelector('#ja-sk').onclick=finish;
    }
  }
  function err(m){ var e=ov.querySelector('#ja-err'); if(e){ e.textContent=m; e.classList.add('on'); } }
  function finish(){
    ov.classList.remove('on');
    emit();
    if(pending){ var p=pending; pending=null; p.resolve(api.user()); }
  }
  /* open the sign-in window; resolves once signed in (rejects if closed) */
  function requireSignIn(reason){
    if(S) return Promise.resolve(api.user());
    ensureModal(); why=reason?t(reason)||reason:''; step='email'; render(); ov.classList.add('on');
    return new Promise(function(res,rej){ pending={resolve:res,reject:rej}; });
  }

  /* ---------- header button ---------- */
  var mounts=[], unseen=0;
  function paintButtons(){
    mounts.forEach(function(m){
      if(!S){ m.innerHTML='<button type="button" class="ja-sbtn">'+t('signin')+'</button>'; m.querySelector('button').onclick=function(){ requireSignIn().catch(function(){}); }; return; }
      var nm=(profile&&profile.name)||S.user.email||'?';
      m.innerHTML='<button type="button" class="ja-av" aria-label="'+t('account')+'" aria-haspopup="true">'+esc(nm.trim().charAt(0).toUpperCase())+'<i class="'+(unseen?'on':'')+'">'+unseen+'</i></button>'+
        '<div class="ja-menu"><div class="em">'+esc(S.user.email)+'</div><a href="account">'+t('account')+'</a><a href="account#saved">'+t('saved')+'</a><a href="account#searches">'+t('searches')+'</a><button type="button" data-out>'+t('signout')+'</button></div>';
      var menu=m.querySelector('.ja-menu');
      m.querySelector('.ja-av').onclick=function(e){ e.stopPropagation(); menu.classList.toggle('on'); };
      m.querySelector('[data-out]').onclick=function(){ signOut(); };
    });
  }
  document.addEventListener('click',function(){ document.querySelectorAll('.ja-menu.on').forEach(function(x){ x.classList.remove('on'); }); });
  function mountButton(el){
    if(!el) return; ensureModal(); el.classList.add('ja-acct'); mounts.push(el); paintButtons();
  }

  var api={
    user:function(){ return S?{id:S.user.id,email:S.user.email}:null; },
    profile:function(){ return profile; },
    onChange:function(f){ listeners.push(f); },
    requireSignIn:requireSignIn, signOut:signOut, mountButton:mountButton, relabel:paintButtons,
    rest:rest, json:json, rpc:rpc, token:token,
    favorites:favorites, addFavorite:addFavorite, removeFavorite:removeFavorite,
    searches:searchesList, addSearch:addSearch, updateSearch:updateSearch, removeSearch:removeSearch,
    activity:activity, logActivity:logActivity, alerts:alerts, markAlertsSeen:markAlertsSeen,
    getProfile:getProfile, updateProfile:updateProfile, deleteAccount:deleteAccount, snapOf:snapOf,
    setUnseen:function(n){ unseen=n||0; paintButtons(); }
  };
  window.JagAccount=api;

  /* on load: refresh profile + unseen alert count when signed in */
  if(S){
    getProfile().then(function(p){
      if(!p) return init();
      rest('/rest/v1/jag_clients?user_id=eq.'+encodeURIComponent(S.user.id),{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({last_seen_at:new Date().toISOString()})}).catch(function(){});
    }).then(function(){
      return json('/rest/v1/jag_client_alerts?select=id&seen_at=is.null&limit=50').then(function(r){ unseen=(r||[]).length; });
    }).catch(function(e){ if(String(e&&e.message)==='signed_out'){ S=null; save(); } })
      .then(emit);
  }
})();
