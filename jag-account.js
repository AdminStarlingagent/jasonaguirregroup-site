/* ============================================================
   JAG client accounts: sign in with an emailed code or a password (clients can create one),
   favorites, saved searches, activity for recommendations.
   Talks to Supabase Auth + REST with the public key; row-level security
   means each client can only ever read or change their own rows.
   ============================================================ */
(function(){
  var URL_ = 'https://nyaxywghbpphjhwcmspd.supabase.co';
  var KEY  = 'sb_publishable_a3LN_l283LN8J-bJTEO8hQ_U40t09eh';
  var STORE = 'jag_client_session';

  var T = {
    es:{ m_cli:'Clientes', m_in:'Iniciar sesión', m_new:'Crear una cuenta', m_team:'Equipo JAG / Agentes', m_hub:'Iniciar sesión en el Agent Hub', m_adm:'Admin (CRM)', m_join:'Únase a nuestro equipo', team_go:'Usted es del equipo JAG. Abriendo el Agent Hub…', hub:'Agent Hub (equipo)', admin:'Admin', team:'Equipo JAG', signin:'Iniciar sesión', account:'Mi cuenta', invest:'Portal de inversionista', saved:'Casas guardadas', searches:'Búsquedas guardadas', signout:'Cerrar sesión',
      h1:'Inicie sesión o cree su cuenta', p1:'Guarde casas, reciba avisos de casas nuevas y vea recomendaciones para usted. Le enviamos un código a su correo, o entre con su contraseña si ya tiene una.',
      email:'Correo electrónico', send:'Enviarme el código', terms:'Al continuar acepta nuestros <a href="privacy-terms.html" target="_blank" rel="noopener">términos y privacidad</a>. Puede borrar su cuenta cuando quiera.',
      h2:'Revise su correo', p2:'Le enviamos un código a ', code:'Código del correo', verify:'Entrar', resend:'Reenviar código', other:'Usar otro correo',
      h3:'¡Bienvenido! ¿Cómo se llama?', p3:'Así sabemos cómo dirigirnos a usted. El teléfono es opcional.', name:'Nombre', phone:'Teléfono (opcional)', done:'Listo', skip:'Ahora no',
      bademail:'Escriba un correo válido.', badcode:'Ese código no funcionó o ya venció. Intente otra vez o pida uno nuevo.', wait:'Espere un momento antes de pedir otro código.', neterr:'No pudimos conectar. Intente de nuevo.',
      why_new:'Cree su cuenta gratis: guarde casas, reciba avisos de casas nuevas y escríbale a su agente.', why_offer:'Entre a su portal para ver el estado de su oferta. Le enviamos un código a su correo.', why_fav:'Inicie sesión para guardar esta casa y recibir avisos si cambia de precio.', why_search:'Inicie sesión para guardar esta búsqueda y recibir avisos de casas nuevas.', sent_again:'Código enviado otra vez.', close:'Cerrar',
      pw_link:'Entrar con contraseña', pw_h:'Inicie sesión', pw_p:'Escriba su correo y su contraseña.', pw:'Contraseña', pw_go:'Entrar', pw_code:'Mejor envíenme un código', pw_show:'Mostrar',
      badpw:'El correo o la contraseña no coinciden. Si nunca creó una contraseña, entre con un código y créela en Mi perfil.', pw_wait:'Demasiados intentos. Espere unos minutos o entre con un código.',
      newpw:'Cree una contraseña (opcional)', newpw_h:'Mínimo 8 caracteres. Así la próxima vez entra sin esperar un código.', shortpw:'La contraseña debe tener al menos 8 caracteres.',
      weakpw:'Esa contraseña es muy fácil de adivinar. Pruebe otra más larga.', reauth:'Por seguridad, cierre sesión, entre con un código y vuelva a intentarlo.', pwerr:'No pudimos guardar la contraseña. Intente de nuevo.' },
    en:{ m_cli:'Clients', m_in:'Sign in', m_new:'Create an account', m_team:'JAG team / Agents', m_hub:'Agent Hub sign in', m_adm:'Admin (CRM)', m_join:'Join our team', team_go:'You\'re on the JAG team. Opening the Agent Hub…', hub:'Agent Hub (team)', admin:'Admin', team:'JAG team', signin:'Sign in', account:'My account', invest:'Investor portal', saved:'Saved homes', searches:'Saved searches', signout:'Sign out',
      h1:'Sign in or create your account', p1:'Save homes, get alerts on new listings and see picks for you. We email you a code, or sign in with your password if you have one.',
      email:'Email', send:'Email me a code', terms:'By continuing you agree to our <a href="privacy-terms.html" target="_blank" rel="noopener">terms and privacy</a>. You can delete your account any time.',
      h2:'Check your email', p2:'We sent a code to ', code:'Code from the email', verify:'Sign in', resend:'Resend code', other:'Use a different email',
      h3:'Welcome! What is your name?', p3:'So we know how to address you. Phone is optional.', name:'Name', phone:'Phone (optional)', done:'Done', skip:'Not now',
      bademail:'Enter a valid email.', badcode:'That code did not work or expired. Try again or request a new one.', wait:'Please wait a moment before requesting another code.', neterr:'We could not connect. Please try again.',
      why_new:'Create your free account: save homes, get new-listing alerts and message your agent.', why_offer:'Open your portal to see your offer status. We will email you a code.', why_fav:'Sign in to save this home and get alerts if the price changes.', why_search:'Sign in to save this search and get alerts on new homes.', sent_again:'Code sent again.', close:'Close',
      pw_link:'Sign in with a password', pw_h:'Sign in', pw_p:'Enter your email and password.', pw:'Password', pw_go:'Sign in', pw_code:'Email me a code instead', pw_show:'Show',
      badpw:'That email and password do not match. If you never created a password, sign in with a code and create one in My profile.', pw_wait:'Too many tries. Wait a few minutes or sign in with a code.',
      newpw:'Create a password (optional)', newpw_h:'At least 8 characters. Next time you can sign in without waiting for a code.', shortpw:'The password needs at least 8 characters.',
      weakpw:'That password is too easy to guess. Try a longer one.', reauth:'For your security, sign out, sign in with a code and try again.', pwerr:'We could not save the password. Please try again.' }
  };
  function lang(){ try{ var v=localStorage.getItem('jag_lang'); if(v==='en'||v==='es') return v; }catch(e){} return 'es'; }
  function t(k){ return (T[lang()]||T.es)[k]; }
  function esc(v){ return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }

  /* ---------- session ---------- */
  var S=null, listeners=[], refreshing=null, profile=null, isInv=false;
  try{ S=JSON.parse(localStorage.getItem(STORE)||'null'); }catch(e){ S=null; }
  function save(){ try{ if(S) localStorage.setItem(STORE, JSON.stringify(S)); else localStorage.removeItem(STORE); }catch(e){} }
  function setSession(j){
    S={ access_token:j.access_token, refresh_token:j.refresh_token,
        expires_at: j.expires_at ? j.expires_at*1000 : Date.now()+(j.expires_in||3600)*1000,
        user:{ id:(j.user||{}).id, email:(j.user||{}).email } };
    save();
  }
  // keep every open tab on the same session (a refresh in one tab spends the old token for all)
  window.addEventListener('storage',function(e){ if(e.key!==STORE) return; var was=!!S, n=null; try{ n=JSON.parse(e.newValue||'null'); }catch(x){} S=n; if(was!==!!S){ if(!S) profile=null; emit(); } });
  function emit(){ listeners.forEach(function(f){ try{ f(api.user()); }catch(e){} }); paintButtons(); }
  function refresh(){
    if(refreshing) return refreshing;
    // another tab (or the installed app) may have refreshed already: the old refresh token is spent, so take the newer one
    var disk=null; try{ disk=JSON.parse(localStorage.getItem(STORE)||'null'); }catch(e){}
    if(disk&&disk.refresh_token&&S&&disk.refresh_token!==S.refresh_token){ S=disk; if(S.expires_at-Date.now()>60000) return Promise.resolve(true); }
    if(!S||!S.refresh_token) return Promise.resolve(false);
    var used=S.refresh_token;
    refreshing=fetch(URL_+'/auth/v1/token?grant_type=refresh_token',{method:'POST',headers:{apikey:KEY,'Content-Type':'application/json'},body:JSON.stringify({refresh_token:S.refresh_token})})
      .then(function(r){ return r.json().then(function(j){ return {ok:r.ok,j:j}; }); })
      .then(function(x){ refreshing=null; if(x.ok&&x.j.access_token){ setSession(x.j); return true; } if(x.j&&(x.j.error_code==='refresh_token_not_found'||x.j.error_code==='session_not_found'||x.j.error_code==='refresh_token_already_used'||x.j.code===400)){
          // only sign out if no other tab saved a newer session meanwhile
          var d2=null; try{ d2=JSON.parse(localStorage.getItem(STORE)||'null'); }catch(e){}
          if(d2&&d2.refresh_token&&d2.refresh_token!==used){ S=d2; return true; }
          S=null; profile=null; save(); emit(); } return false; })
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
  function signInPassword(email, pw){
    return fetch(URL_+'/auth/v1/token?grant_type=password',{method:'POST',headers:{apikey:KEY,'Content-Type':'application/json'},
      body:JSON.stringify({email:email,password:pw})})
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){
        if(!r.ok||!j.access_token){ var e=new Error(j.error_code||'bad_pw'); e.status=r.status; throw e; }
        setSession(j); rememberPw(); return j; }); });
  }
  /* create or change the password of the signed-in client (Supabase Auth: PUT /user) */
  function setPassword(pw){
    pw=String(pw||'');
    if(pw.length<8) return Promise.reject(new Error('short'));
    return rest('/auth/v1/user',{method:'PUT',body:JSON.stringify({password:pw})}).then(function(r){
      if(r.ok){ rememberPw(); return true; }
      return r.json().catch(function(){ return {}; }).then(function(j){
        var c=String(j.error_code||j.code||'');
        throw new Error(c==='weak_password'?'weak':c==='reauthentication_needed'||c==='reauthentication_not_valid'?'reauth':c==='same_password'?'same':'pwerr'); });
    });
  }
  function pwErrText(e){ var m=e&&e.message; return m==='short'?t('shortpw'):m==='weak'?t('weakpw'):m==='reauth'?t('reauth'):m==='same'?'':t('pwerr'); }
  function rememberPw(){ try{ localStorage.setItem('jag_signin','pw'); }catch(e){} }
  function usesPw(){ try{ return localStorage.getItem('jag_signin')==='pw'; }catch(e){ return false; } }
  function init(extra){
    extra=extra||{};
    return rpc('jag_client_init',{p_name:extra.name||null,p_phone:extra.phone||null,p_lang:lang(),p_terms:true})
      .then(function(j){ profile=(j&&j.profile)||profile; return j; });
  }
  function signOut(){
    var tk=S&&S.access_token;
    if(tk) fetch(URL_+'/auth/v1/logout?scope=local',{method:'POST',headers:{apikey:KEY,Authorization:'Bearer '+tk}}).catch(function(){});
    S=null; profile=null; isInv=false; try{ localStorage.removeItem('jag_inv'); }catch(e){} save(); emit();
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
    '.ja-menu a:hover,.ja-menu button:hover{background:#f5f5f7}.ja-av.ja-team{background:#17161c}'+
    '.ja-sbtn{display:inline-flex;align-items:center;gap:8px}.ja-car{width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:6px solid currentColor}'+
    '.ja-smenu{min-width:250px;padding:8px 10px 10px}.ja-mh{font-size:17px;font-weight:800;color:#17161c;padding:12px 10px 8px;margin-bottom:4px;border-bottom:1px solid #eee}.ja-smenu .ja-mh:not(:first-child){margin-top:10px}'+
    '.ja-smenu a,.ja-smenu button{font-weight:500;font-size:15px;color:#3d3c44}';
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
        '<div class="ja-err" id="ja-err"></div><button class="ja-btn" type="submit">'+t('send')+'</button>'+
        '<div class="ja-row"><button type="button" class="ja-link" id="ja-pwl">'+t('pw_link')+'</button></div><p class="ja-fine">'+t('terms')+'</p></form>';
      var f=b.querySelector('form'), inp=b.querySelector('#ja-e');
      b.querySelector('#ja-pwl').onclick=function(){ var v=inp.value.trim().toLowerCase(); if(v) email=v; step='pw'; render(); };
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
        '<form novalidate><label for="ja-c">'+t('code')+'</label><input id="ja-c" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8">'+
        '<div class="ja-err" id="ja-err"></div><button class="ja-btn" type="submit">'+t('verify')+'</button>'+
        '<div class="ja-row"><button type="button" class="ja-link" id="ja-re">'+t('resend')+'</button><button type="button" class="ja-link" id="ja-ot">'+t('other')+'</button></div></form>';
      var f2=b.querySelector('form'), c=b.querySelector('#ja-c');
      setTimeout(function(){ c.focus(); },50);
      c.addEventListener('input',function(){ var d=c.value.replace(/\D/g,'').slice(0,8); c.value=d; if(d.length===8) f2.requestSubmit?f2.requestSubmit():f2.onsubmit({preventDefault:function(){}}); });
      f2.onsubmit=function(e){ e.preventDefault();
        var v=c.value.replace(/\D/g,''); if(v.length<6||v.length>8) return err(t('badcode'));
        var btn=f2.querySelector('.ja-btn'); btn.disabled=true;
        verify(email,v).then(afterAuth).catch(function(){ btn.disabled=false; c.value=''; err(t('badcode')); });
      };
      b.querySelector('#ja-re').onclick=function(){
        if(Date.now()<cooldown) return err(t('wait'));
        sendCode(email).then(function(){ cooldown=Date.now()+60000; err(t('sent_again')); }).catch(function(x){ err(x.status===429?t('wait'):t('neterr')); });
      };
      b.querySelector('#ja-ot').onclick=function(){ step='email'; render(); };
    }else if(step==='pw'){
      b.innerHTML=(why?'<div class="why">'+esc(why)+'</div>':'')+'<h3>'+t('pw_h')+'</h3><p>'+t('pw_p')+'</p>'+
        '<form novalidate><label for="ja-e2">'+t('email')+'</label><input id="ja-e2" type="email" autocomplete="username" inputmode="email" value="'+esc(email)+'">'+
        '<label for="ja-pw">'+t('pw')+'</label><div style="position:relative"><input id="ja-pw" type="password" autocomplete="current-password" style="padding-right:84px">'+
        '<button type="button" class="ja-link" id="ja-sh" style="position:absolute;right:12px;top:4px">'+t('pw_show')+'</button></div>'+
        '<div class="ja-err" id="ja-err"></div><button class="ja-btn" type="submit">'+t('pw_go')+'</button>'+
        '<div class="ja-row"><button type="button" class="ja-link" id="ja-cd">'+t('pw_code')+'</button></div><p class="ja-fine">'+t('terms')+'</p></form>';
      var f4=b.querySelector('form'), e4=b.querySelector('#ja-e2'), p4=b.querySelector('#ja-pw');
      setTimeout(function(){ (email?p4:e4).focus(); },50);
      b.querySelector('#ja-sh').onclick=function(){ p4.type=p4.type==='password'?'text':'password'; };
      b.querySelector('#ja-cd').onclick=function(){ var v=e4.value.trim().toLowerCase(); if(v) email=v; step='email'; render(); };
      f4.onsubmit=function(e){ e.preventDefault();
        var v=e4.value.trim().toLowerCase(), pw=p4.value;
        if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return err(t('bademail'));
        if(!pw) return err(t('badpw'));
        var btn=f4.querySelector('.ja-btn'); btn.disabled=true; email=v;
        signInPassword(v,pw).then(afterAuth).catch(function(x){ btn.disabled=false; p4.value=''; err(x&&x.status===429?t('pw_wait'):x&&x.status>=400&&x.status<500?t('badpw'):t('neterr')); });
      };
    }else if(step==='name'){
      b.innerHTML='<h3>'+t('h3')+'</h3><p>'+t('p3')+'</p><form novalidate><label for="ja-n">'+t('name')+'</label><input id="ja-n" autocomplete="name">'+
        '<label for="ja-p">'+t('phone')+'</label><input id="ja-p" type="tel" autocomplete="tel" inputmode="tel">'+
        '<label for="ja-np">'+t('newpw')+'</label><input id="ja-np" type="password" autocomplete="new-password" minlength="8" style="margin-bottom:4px"><p class="ja-fine" style="margin:0 0 12px">'+t('newpw_h')+'</p>'+
        '<div class="ja-err" id="ja-err"></div><button class="ja-btn" type="submit">'+t('done')+'</button><div class="ja-row"><span></span><button type="button" class="ja-link" id="ja-sk">'+t('skip')+'</button></div></form>';
      var f3=b.querySelector('form');
      setTimeout(function(){ b.querySelector('#ja-n').focus(); },50);
      f3.onsubmit=function(e){ e.preventDefault();
        var n=b.querySelector('#ja-n').value.trim(), p=b.querySelector('#ja-p').value.trim(), np=b.querySelector('#ja-np').value;
        if(np&&np.length<8) return err(t('shortpw'));
        var btn=f3.querySelector('.ja-btn'); btn.disabled=true;
        (np?setPassword(np):Promise.resolve()).then(function(){
          return (n||p?init({name:n,phone:p}):Promise.resolve()).catch(function(){}).then(finish);
        }).catch(function(x){ btn.disabled=false; var m=pwErrText(x); if(m) err(m); else finish(); });
      };
      b.querySelector('#ja-sk').onclick=finish;
    }
  }
  /* after a code or password sign-in: team members go to the Agent Hub; new clients get the name (and password) step */
  function afterAuth(sess){
    return rpc('jag_agent_me').catch(function(){ return null; }).then(function(a){
      if(a&&a.ok&&a.agent){ teamHandoff(sess,a.agent,email); return 'team'; }
      return init();
    }).then(function(j){
      if(j==='team') return;
      if(j&&j.new){ step='name'; render(); } else finish();
    });
  }
  /* a team email (an agent card in Follow Up Boss) signing in on the public site: keep the same login as the
     team session the Agent Hub, Admin and "Comenzar oferta" use, skip the client account, open the Agent Hub */
  function teamHandoff(sess,a,em){
    try{ localStorage.setItem('jag_agent',JSON.stringify({t:sess.access_token,r:sess.refresh_token,x:Date.now()+(sess.expires_in||3600)*1000,
      code:a.code,name:a.name,first_name:a.first_name,phone:a.phone,photo_url:a.photo_url,e:em})); }catch(x){}
    S=null; save();
    ov.querySelector('.ja-body').innerHTML='<h3>'+t('team')+'</h3><p>'+t('team_go')+'</p>';
    setTimeout(function(){ location.href='agent'; },900);
  }
  /* team sign-out: ends the Agent Hub / Admin login on this browser */
  function teamSignOut(tm){
    if(tm&&tm.t) fetch(URL_+'/auth/v1/logout?scope=local',{method:'POST',headers:{apikey:KEY,Authorization:'Bearer '+tm.t}}).catch(function(){});
    try{ localStorage.removeItem('jag_agent'); sessionStorage.removeItem('jag_admin'); }catch(x){}
    paintButtons(); location.reload();
  }
  function teamSession(){ try{ var a=JSON.parse(localStorage.getItem('jag_agent')||'null'); if(a&&a.until&&Date.now()>a.until){ localStorage.removeItem('jag_agent'); return null; } return a&&a.r?a:null; }catch(x){ return null; } }
  function err(m){ var e=ov.querySelector('#ja-err'); if(e){ e.textContent=m; e.classList.add('on'); } }
  function finish(){
    ov.classList.remove('on');
    emit();
    if(pending){ var p=pending; pending=null; p.resolve(api.user()); }
  }
  /* open the sign-in window; resolves once signed in (rejects if closed) */
  function requireSignIn(reason, presetEmail){
    if(S) return Promise.resolve(api.user());
    ensureModal(); why=reason?t(reason)||reason:''; step=usesPw()&&reason!=='why_new'?'pw':'email';
    if(presetEmail && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(presetEmail).trim())) email=String(presetEmail).trim().toLowerCase();
    render(); ov.classList.add('on');
    return new Promise(function(res,rej){ pending={resolve:res,reject:rej}; });
  }

  /* ---------- header button ---------- */
  var mounts=[], unseen=0;
  function paintButtons(){
    mounts.forEach(function(m){
      var tm=teamSession();
      if(!S&&tm){
        m.innerHTML='<button type="button" class="ja-av ja-team" aria-label="'+t('team')+'" aria-haspopup="true">'+esc(String(tm.first_name||tm.name||'J').charAt(0).toUpperCase())+'</button>'+
          '<div class="ja-menu"><div class="em">'+esc(t('team'))+(tm.e?' · '+esc(tm.e):'')+'</div><a href="agent">'+t('hub')+'</a><a href="admin.html">'+t('admin')+'</a><button type="button" data-tout>'+t('signout')+'</button></div>';
        var tmn=m.querySelector('.ja-menu'); m.querySelector('.ja-av').onclick=function(e){ e.stopPropagation(); tmn.classList.toggle('on'); };
        m.querySelector('[data-tout]').onclick=function(){ teamSignOut(tm); };
        return;
      }
      if(!S){
        /* like HAR: one "Sign in" button, clients on top, the team below */
        m.innerHTML='<button type="button" class="ja-sbtn" aria-haspopup="true" aria-expanded="false">'+t('signin')+'<span class="ja-car" aria-hidden="true"></span></button>'+
          '<div class="ja-menu ja-smenu" role="menu"><div class="ja-mh">'+t('m_cli')+'</div>'+
          '<button type="button" role="menuitem" data-in>'+t('m_in')+'</button><button type="button" role="menuitem" data-new>'+t('m_new')+'</button>'+
          '<div class="ja-mh">'+t('m_team')+'</div>'+
          '<a role="menuitem" href="agent">'+t('m_hub')+'</a><a role="menuitem" href="admin.html">'+t('m_adm')+'</a><a role="menuitem" href="team">'+t('m_join')+'</a></div>';
        var sb=m.querySelector('.ja-sbtn'), sm=m.querySelector('.ja-smenu');
        sb.onclick=function(e){ e.stopPropagation(); var on=!sm.classList.contains('on'); document.querySelectorAll('.ja-menu.on').forEach(function(x){ x.classList.remove('on'); }); sm.classList.toggle('on',on); sb.setAttribute('aria-expanded',String(on)); };
        sm.querySelector('[data-in]').onclick=function(){ sm.classList.remove('on'); requireSignIn().catch(function(){}); };
        sm.querySelector('[data-new]').onclick=function(){ sm.classList.remove('on'); requireSignIn('why_new').catch(function(){}); };
        return;
      }
      var nm=(profile&&profile.name)||S.user.email||'?';
      try{ isInv=isInv||localStorage.getItem('jag_inv')===S.user.id; }catch(e){}
      m.innerHTML='<button type="button" class="ja-av" aria-label="'+t('account')+'" aria-haspopup="true">'+esc(nm.trim().charAt(0).toUpperCase())+'<i class="'+(unseen?'on':'')+'">'+unseen+'</i></button>'+
        '<div class="ja-menu"><div class="em">'+esc(S.user.email)+'</div><a href="account">'+t('account')+'</a>'+(isInv?'<a href="invest">'+t('invest')+'</a>':'')+'<a href="account#saved">'+t('saved')+'</a><a href="account#searches">'+t('searches')+'</a><button type="button" data-out>'+t('signout')+'</button></div>';
      var menu=m.querySelector('.ja-menu');
      m.querySelector('.ja-av').onclick=function(e){ e.stopPropagation(); menu.classList.toggle('on'); };
      m.querySelector('[data-out]').onclick=function(){ signOut(); };
    });
  }
  document.addEventListener('click',function(){ document.querySelectorAll('.ja-menu.on').forEach(function(x){ x.classList.remove('on'); }); });
  function mountButton(el){
    if(!el) return; ensureModal(); el.classList.add('ja-acct'); mounts.push(el); paintButtons();
  }

  // Pre-approved? (team-set pre-approval or loan app marked approved). Cached per account for 10 minutes, so pages can
  // stop asking pre-approved clients to apply / get an evaluation. preApproved() is the cached answer (null = not known yet).
  var loanP=null;
  function loanKey(){ return S&&S.user?'jag_pa_'+S.user.id:''; }
  function preApproved(){ var k=loanKey(); if(!k) return false; try{ var v=JSON.parse(sessionStorage.getItem(k)||'null'); return v&&Date.now()-v.at<6e5?v.pa:null; }catch(e){ return null; } }
  function loanStatus(){
    var k=loanKey(); if(!k) return Promise.resolve(null);
    var c=preApproved(); if(c!==null) return Promise.resolve(c);
    if(loanP) return loanP;
    loanP=rpc('jag_my_plan').then(function(j){
      var pa=j&&j.ok&&j.preapproved&&!j.preapproved.expired?j.preapproved:false;
      try{ sessionStorage.setItem(k,JSON.stringify({at:Date.now(),pa:pa})); }catch(e){}
      loanP=null; if(pa) document.documentElement.classList.add('jag-pa'); return pa;
    }).catch(function(){ loanP=null; return null; });
    return loanP;
  }
  if(S&&S.user&&preApproved()) document.documentElement.classList.add('jag-pa');
  var api={
    preApproved:preApproved, loanStatus:loanStatus,
    user:function(){ return S?{id:S.user.id,email:S.user.email}:null; },
    profile:function(){ return profile; },
    onChange:function(f){ listeners.push(f); },
    requireSignIn:requireSignIn, signOut:signOut, setPassword:setPassword, pwErrText:pwErrText, mountButton:mountButton, relabel:paintButtons,
    rest:rest, json:json, rpc:rpc, token:token,
    favorites:favorites, addFavorite:addFavorite, removeFavorite:removeFavorite,
    searches:searchesList, addSearch:addSearch, updateSearch:updateSearch, removeSearch:removeSearch,
    activity:activity, logActivity:logActivity, alerts:alerts, markAlertsSeen:markAlertsSeen,
    getProfile:getProfile, updateProfile:updateProfile, deleteAccount:deleteAccount, snapOf:snapOf,
    setUnseen:function(n){ unseen=n||0; paintButtons(); }
  };
  // The ES/EN switch on any page is the client's language choice: save it to their account so emails (and texts) follow it.
  document.addEventListener('click', function(e){
    var b = e.target && e.target.closest && e.target.closest('.langs [data-lang]'); if(!b || !S || !S.user) return;
    var v = b.getAttribute('data-lang'); if(v !== 'es' && v !== 'en') return;
    if(profile && profile.lang === v) return;
    updateProfile({ lang: v }).catch(function(){});
  }, true);

  window.JagAccount=api;
  /* invite-only investor portal: the menu link shows only for invited investors */
  function checkInv(){
    if(!S) return;
    rpc('jag_is_investor').then(function(v){ var u=S&&S.user&&S.user.id; isInv=v===true;
      try{ if(isInv&&u) localStorage.setItem('jag_inv',u); else localStorage.removeItem('jag_inv'); }catch(e){} paintButtons(); }).catch(function(){});
  }
  api.onChange(function(u){ if(u&&!isInv) checkInv(); });

  /* on load: refresh profile + unseen alert count when signed in */
  if(S){
    getProfile().then(function(p){
      if(!p) return init();
      rest('/rest/v1/jag_clients?user_id=eq.'+encodeURIComponent(S.user.id),{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({last_seen_at:new Date().toISOString()})}).catch(function(){});
    }).then(function(){
      checkInv();
      return json('/rest/v1/jag_client_alerts?select=id&seen_at=is.null&limit=50').then(function(r){ unseen=(r||[]).length; });
    }).catch(function(e){ if(String(e&&e.message)==='signed_out'){ S=null; save(); } })
      .then(emit);
  }
})();
