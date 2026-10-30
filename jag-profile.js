/* ============================================================
   JAG client profile — the contact's page in the Agent Hub, laid out like Follow Up Boss (what the team is used to),
   but simpler:
     left    who they are: contact info, journey, stage, assigned agent, tags, background
     middle  write: note · email · text · log call  →  Lola's summary  →  ONE history of everything
             (notes, calls, emails, texts, app messages, AI chats, homes and lists sent, alert emails, saved homes,
              screenings, loan apps, tours, offers, and Follow Up Boss notes/calls while both run)
     right   Lola: the next best step and messages ready to send · tasks · files · collaborators · tours · offers · loan · lists
             Files: team uploads (private bucket contact-files) + the client's own uploads (client-proof); supabase-contact-files.sql
   Phones: the three columns become three tabs (History · Details · Lola & tasks).
   Opened at agent.html#c/<contact id> (an app account id from older links works too). Any contact: Follow Up Boss leads
   and app accounts alike (jag_contacts). Data: jag_contact_profile (supabase-contacts-phase2.sql); stage / notes / calls /
   texts / emails are copied to Follow Up Boss by fub-sync; a stage with a default owner hands the contact to them.
   Email + FUB history: jag-client-hub ('email', 'fub_history'); Lola: jag-lola (no names, phones or emails are sent to it).
   ============================================================ */
(function(){
  var C = window.JAG_CRM || {}, BASE = String(C.url || '').replace(/\/+$/, ''), KEY = C.anonKey;
  var SITE = 'https://jasonaguirregroup.company';
  var o = null, me = null, P = null, uid = null, fub = {}, FILES = {}, upl = 0, tab = 'note', filt = 'all', col = 'c', busy = false, lolaAns = '', open = {};
  function $(id){ return document.getElementById(id); }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function digits(p){ return String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); }
  function fmtPhone(p){ var d = digits(p); return d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : (p || ''); }
  function money(n){ n = Number(n); return n > 0 ? '$' + Math.round(n).toLocaleString('en-US') : ''; }
  function first(n){ return String(n || '').trim().split(/\s+/)[0] || ''; }
  function cap(s){ s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
  function ago(iso){
    if(!iso) return '';
    var m = (Date.now() - new Date(iso).getTime()) / 60000;
    if(m < 0) return 'upcoming'; if(m < 2) return 'just now'; if(m < 60) return Math.floor(m) + ' min ago'; if(m < 1440) return Math.floor(m / 60) + ' h ago';
    var d = Math.floor(m / 1440); return d === 1 ? 'yesterday' : d < 30 ? d + ' days ago' : when(iso);
  }
  function when(iso){ if(!iso) return ''; var d = new Date(String(iso).length === 10 ? iso + 'T12:00:00' : iso);
    var y = d.getFullYear() !== new Date().getFullYear() ? ', ' + d.getFullYear() : '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + y + (String(iso).length > 10 ? ' · ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : ''); }
  function day(iso){ return iso ? new Date(String(iso).length === 10 ? iso + 'T12:00:00' : iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : ''; }
  function rpc(n, a){ return o.rpc(n, a); }
  function hub(action, body){
    return JagShare.token().then(function(t){
      return fetch(BASE + '/functions/v1/jag-client-hub', { method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ action: action }, body)) });
    }).then(function(r){ return r.json(); });
  }
  function toast(m){ if(window.JagCRM && JagCRM.toast) JagCRM.toast(m); }
  function topGo(u){ try{ window.top.location.href = u; }catch(e){ location.href = u; } }
  function agentName(code){ var a = ((P && P.team) || []).filter(function(x){ return x.code === code; })[0]; return a ? a.name : cap(code || ''); }
  function agentFirst(code){ var a = ((P && P.team) || []).filter(function(x){ return x.code === code; })[0]; return a ? (a.first_name || first(a.name)) : cap(code || ''); }
  function initials(n){ return String(n || '?').trim().split(/\s+/).map(function(w){ return w.charAt(0); }).slice(0, 2).join('').toUpperCase() || '?'; }
  // Follow Up Boss's own stages (the profile gets the live list in P.stages; this is only the fallback)
  var STAGES = ['Lead', 'Attempted contact', 'Spoke with customer', 'Appointment set', 'Met with customer', 'Hot Prospect', 'Applied', 'Loan Approved', 'Showing homes',
    'Submitting offers', 'Under contract', 'Pending', 'Closed', 'Past Client', 'Active Client', 'Listing agreement', 'Active listing', 'Nurture', '2027 Follow-up', 'Sphere',
    'Credit Lead', 'Credit Repair', 'Investor', 'Out Of Town', 'Unresponsive'];
  var LOAN = { received: 'App received', review: 'In review', docs: 'Needs documents', credit: 'Working on credit', paused: 'Paused', done: 'Pre-approved' };
  var LANE = { ready: 'Ready', fha: 'FHA', itin: 'ITIN', prep: 'Prep', credit: 'Credit path', cash: 'Cash' };

  /* ---------------- styles ---------------- */
  var css = document.createElement('style');
  css.textContent = [
    '.pf{position:fixed;inset:0;z-index:9000;background:#f6f5f3;overflow:auto;-webkit-overflow-scrolling:touch}',
    '.pf-top{position:sticky;top:0;z-index:5;background:var(--paper);border-bottom:1px solid var(--line)}',
    '.pf-top .in{max-width:1440px;margin:0 auto;padding:10px 16px;display:flex;align-items:center;gap:10px}',
    '.pf-back{border:0;background:#f6f5f3;border-radius:99px;padding:9px 14px;font-weight:800;font-size:14px;min-height:40px}',
    '.pf-nav{margin-left:auto;display:flex;align-items:center;gap:6px;font-size:13px;color:var(--muted);font-weight:700}',
    '.pf-nav button{border:0;background:#f6f5f3;width:38px;height:38px;border-radius:50%;font-size:18px;font-weight:800}',
    '.pf-nav button:disabled{opacity:.35}',
    '.pf-tabs{display:none;gap:4px;padding:0 12px 8px;max-width:1440px;margin:0 auto}',
    '.pf-tabs button{flex:1;border:0;background:#f6f5f3;border-radius:12px;padding:10px 6px;font-weight:800;font-size:13.5px;color:var(--muted);min-height:42px}',
    '.pf-tabs button[aria-selected="true"]{background:var(--ink);color:#fff}',
    '.pf-col{display:flex;flex-direction:column;gap:14px;min-width:0}',
    '.pf-grid{max-width:1440px;margin:0 auto;padding:16px;display:grid;grid-template-columns:310px minmax(0,1fr) 340px;gap:16px;align-items:start}',
    '@media(max-width:1180px){.pf-grid{grid-template-columns:300px minmax(0,1fr)}.pf-r{grid-column:1;grid-row:2}.pf-c{grid-column:2;grid-row:1/span 2}}',
    '@media(max-width:900px){.pf-tabs{display:flex}.pf-grid{display:block;padding:12px}.pf-col{display:none}.pf-col.on{display:flex}}',
    '.pf .jr-l{display:none}.pf .jr-cap{display:block}',
    '.pc{background:var(--paper);border:1px solid #e9e6e1;border-radius:18px;padding:16px}',
    '.pc h3{margin:0 0 10px;font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);display:flex;align-items:center;justify-content:space-between;gap:8px}',
    '.pc h3 .add{border:0;background:var(--red);color:#fff;width:30px;height:30px;border-radius:50%;font-size:18px;font-weight:800;line-height:1;letter-spacing:0}',
    '.pf-who{display:flex;gap:12px;align-items:center}',
    '.pf-av{width:56px;height:56px;border-radius:50%;background:var(--ink);color:#fff;display:grid;place-items:center;font-weight:800;font-size:19px;flex:none}',
    '.pf-who h2{margin:0;font-size:22px;font-weight:800;letter-spacing:-.02em;line-height:1.15;overflow-wrap:anywhere}',
    '.pf-who small{display:block;color:var(--muted);font-size:13px;margin-top:3px}',
    '.pf-badges{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}',
    '.pb{font-size:10.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;border-radius:99px;padding:4px 9px;background:#f6f5f3;color:var(--ink)}',
    '.pb.hot{background:var(--ink);color:#fff}.pb.ok{background:var(--green-t);color:var(--green)}',
    '.pf-qa{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:14px}',
    '.pf-qa a,.pf-qa button{border:2px solid var(--red);background:#fff;color:var(--red);border-radius:14px;padding:8px 4px;font-weight:800;font-size:12.5px;text-align:center;text-decoration:none;display:flex;flex-direction:column;align-items:center;gap:2px;min-height:54px;justify-content:center}',
    '.pf-qa a:first-child{background:var(--red);color:#fff}',
    '.pf-qa .x{opacity:.4;pointer-events:none}',
    '.kv{display:grid;grid-template-columns:96px minmax(0,1fr);gap:8px 10px;font-size:14px;align-items:center}',
    '.kv dt{color:var(--muted);font-weight:700;font-size:12.5px}.kv dd{margin:0;min-width:0;overflow-wrap:anywhere}',
    '.kv a{color:var(--red);font-weight:700;text-decoration:none}',
    '.kv select,.kv input,.pc textarea,.pc input[type=text],.pc input[type=date],.pc select{width:100%;border:1px solid #d9d6d1;border-radius:12px;background:#f6f5f3;padding:9px 11px;font:inherit;font-size:14.5px;color:var(--ink)}',
    '.pc textarea{resize:vertical;min-height:80px}',
    '.tags{display:flex;flex-wrap:wrap;gap:6px;align-items:center}',
    '.tag{display:inline-flex;align-items:center;gap:4px;background:#f6f5f3;border-radius:99px;padding:5px 6px 5px 11px;font-size:12.5px;font-weight:700}',
    '.tag button{border:0;background:none;color:var(--muted);font-size:15px;line-height:1;padding:0 4px;min-height:24px}',
    '.tags input{flex:1;min-width:110px;border:1px dashed #cfcac3!important;background:#fff!important;border-radius:99px!important;padding:6px 11px!important;font-size:13px!important}',
    /* composer */
    '.cmp-tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);margin:-4px -4px 12px;overflow-x:auto;scrollbar-width:none}',
    '.cmp-tabs button{border:0;background:none;padding:10px 12px;font-weight:800;font-size:14px;color:var(--muted);border-bottom:3px solid transparent;white-space:nowrap}',
    '.cmp-tabs button[aria-selected="true"]{color:var(--ink);border-color:var(--red)}',
    '.cmp-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px}',
    '.cmp-row .sp{flex:1}',
    '.pbtn{border:0;border-radius:99px;background:var(--red);color:#fff;font-weight:800;font-size:14px;padding:11px 18px;min-height:44px;text-decoration:none;display:inline-flex;align-items:center;gap:6px}',
    '.pbtn:hover{background:var(--red-d)}.pbtn:disabled{opacity:.5}',
    '.pbtn.g{background:#fff;color:var(--red);border:2px solid var(--red)}.pbtn.k{background:var(--ink)}',
    '.pbtn.s{padding:7px 12px;min-height:36px;font-size:13px}',
    '.chips{display:flex;flex-wrap:wrap;gap:6px}',
    '.chips button{border:2px solid #e3dfd9;background:#fff;border-radius:99px;padding:6px 11px;font-weight:700;font-size:12.5px;color:var(--ink);min-height:34px}',
    '.chips button[aria-pressed="true"]{border-color:var(--ink);background:var(--ink);color:#fff}',
    '.cmp-to{font-size:13px;color:var(--muted);margin-bottom:8px}.cmp-to b{color:var(--ink)}',
    '.cmp .msg{font-size:13px;font-weight:700;margin-top:8px}.cmp .msg.bad{color:var(--red-d)}.cmp .msg.ok{color:var(--green)}',
    /* summary + lola */
    '.sum{background:linear-gradient(180deg,#f3f0ff,#fff);border-color:#e4defc}',
    '.sum h3{color:#5b3fd1}',
    '.sum ul{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px;font-size:14px}',
    '.lola{border-color:#e4defc}',
    '.lola .nx{background:#f3f0ff;border-radius:14px;padding:12px;font-size:14px;display:flex;flex-direction:column;gap:8px}',
    '.lola .nx a,.lola .nx button{align-self:flex-start}',
    '.dr{border:1px solid #ebe8e3;border-radius:14px;padding:11px 12px;margin-top:10px;display:flex;flex-direction:column;gap:6px}',
    '.dr b{font-size:13.5px}.dr .k{font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#5b3fd1}',
    '.dr p{margin:0;font-size:13.5px;color:#3f3e47;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap}',
    '.dr .a{display:flex;gap:6px;flex-wrap:wrap}',
    '.ask{display:flex;gap:6px;margin-top:12px}.ask input{flex:1}',
    '.ans{margin-top:10px;background:#f3f0ff;border-radius:12px;padding:10px 12px;font-size:14px;white-space:pre-wrap}',
    /* timeline */
    '.flt{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;padding-bottom:4px;margin-bottom:6px}',
    '.flt button{border:0;background:#f6f5f3;border-radius:99px;padding:7px 12px;font-weight:800;font-size:12.5px;white-space:nowrap;color:var(--muted);min-height:34px}',
    '.flt button[aria-pressed="true"]{background:var(--ink);color:#fff}',
    '.flt i{font-style:normal;opacity:.7;margin-left:3px}',
    '.tln{list-style:none;margin:0;padding:0}',
    '.ev{display:flex;gap:12px;padding:12px 0;border-top:1px solid #efece7}',
    '.ev:first-child{border-top:0}',
    '.ev .ic{flex:none;width:34px;height:34px;border-radius:50%;background:#f6f5f3;display:grid;place-items:center;font-size:16px}',
    '.ev.k-note .ic,.ev.k-fubnote .ic{background:#fff4d6}.ev.k-call .ic,.ev.k-fubcall .ic{background:#e7f5ee}.ev.k-email .ic{background:#eaf0ff}',
    '.ev.k-ai .ic{background:#f3f0ff}.ev.k-app .ic,.ev.k-screen .ic{background:#fdecef}.ev.k-system .ic{background:transparent}',
    '.ev .b{flex:1;min-width:0}',
    '.ev .h{display:flex;justify-content:space-between;gap:10px;align-items:baseline}',
    '.ev .h b{font-size:14.5px;overflow-wrap:anywhere}.ev .h time{font-size:12px;color:var(--soft);white-space:nowrap}',
    '.ev .w{font-size:12.5px;color:var(--muted);margin-top:1px}',
    '.ev .t{font-size:14px;margin-top:6px;white-space:pre-wrap;overflow-wrap:anywhere;color:#2d2c33}',
    '.ev .t.cl{display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden}',
    '.ev .x{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}',
    '.ev .x a,.ev .x button{border:0;background:none;padding:0;color:var(--red);font-weight:800;font-size:13px;text-decoration:none}',
    '.ev.k-system{padding:6px 0}.ev.k-system .b{font-size:13px;color:var(--muted)}',
    '.oc{display:inline-block;font-size:10.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;border-radius:99px;padding:3px 8px;background:#e7f5ee;color:var(--green);margin-left:6px}',
    '.tr{margin-top:8px;display:flex;flex-direction:column;gap:6px}',
    '.tr div{font-size:13.5px;padding:8px 10px;border-radius:12px;max-width:90%;white-space:pre-wrap}',
    '.tr .u{background:#f6f5f3;align-self:flex-end}.tr .a{background:#f3f0ff}',
    '.empty2{color:var(--muted);font-size:14px;padding:16px 0;text-align:center}',
    /* side lists */
    '.li{display:flex;gap:10px;align-items:flex-start;padding:9px 0;border-top:1px solid #efece7;font-size:14px}',
    '.li:first-of-type{border-top:0}',
    '.li .m{flex:1;min-width:0}.li .m b{display:block;font-size:14px;overflow-wrap:anywhere}.li .m small{color:var(--muted);font-size:12.5px}',
    '.li input[type=checkbox]{width:22px;height:22px;accent-color:var(--green);margin-top:1px;flex:none}',
    '.li.done .m b{text-decoration:line-through;color:var(--muted)}',
    '.li .rm{border:0;background:none;color:var(--muted);font-size:17px;padding:0 4px;min-height:30px}',
    '.li a{color:var(--red);font-weight:800;text-decoration:none;font-size:13px}',
    '.li .due{color:var(--red-d);font-weight:700}',
    '.av2{width:34px;height:34px;border-radius:50%;background:#e9e6ef;display:grid;place-items:center;font-weight:800;font-size:12.5px;flex:none;overflow:hidden}',
    '.av2 img{width:100%;height:100%;object-fit:cover}',
    '.tadd{display:grid;grid-template-columns:1fr;gap:8px;margin-top:10px}',
    '.tadd .r2{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
    '.none{color:var(--muted);font-size:13.5px}',
    '.pc h3 label.add{display:grid;place-items:center;cursor:pointer}',
    '.fdrop{border:2px dashed #d9d6d1;border-radius:14px;padding:14px;text-align:center;color:var(--muted);font-size:13.5px;font-weight:700;cursor:pointer;display:block;margin-bottom:4px}',
    '.fdrop.on{border-color:var(--red);background:#fff5f5;color:var(--red)}',
    '.li .fo{border:0;background:#f6f5f3;border-radius:99px;padding:6px 12px;font-weight:800;font-size:13px;color:var(--ink);min-height:32px;white-space:nowrap}',
    '.fmsg{font-size:13px;font-weight:700;color:var(--muted);margin-top:6px}',
    '.pf-load{display:grid;place-items:center;min-height:60vh;color:var(--muted);font-weight:700}'
  ].join('\n');
  document.head.appendChild(css);

  /* ---------------- open / close ---------------- */
  function openProfile(u){
    if(!u) return;
    uid = u; P = null; lolaAns = ''; open = {}; filt = 'all'; tab = 'note';
    var el = $('pf');
    if(!el){ el = document.createElement('div'); el.id = 'pf'; el.className = 'pf'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Client profile'); document.body.appendChild(el);
      el.addEventListener('click', onClick); el.addEventListener('change', onChange);
      el.addEventListener('dragover', function(e){ if(!uid || !e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') < 0) return; e.preventDefault(); var d = $('pf-fdrop'); if(d) d.classList.add('on'); });
      el.addEventListener('dragleave', function(e){ if(e.target && e.target.id === 'pf-fdrop') e.target.classList.remove('on'); });
      el.addEventListener('drop', function(e){ if(!uid || !e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return; e.preventDefault(); var d = $('pf-fdrop'); if(d) d.classList.remove('on'); upload(e.dataTransfer.files); }); }
    el.hidden = false; el.scrollTop = 0; document.body.style.overflow = 'hidden';
    el.innerHTML = '<div class="pf-load">Loading profile…</div>';
    try{ if(location.hash !== '#c/' + u) history.replaceState(null, '', '#c/' + u); }catch(e){}
    load(true);
  }
  function closeProfile(){
    var el = $('pf'); if(el){ el.hidden = true; el.innerHTML = ''; }
    document.body.style.overflow = ''; uid = null; P = null;
    try{ history.replaceState(null, '', location.pathname + location.search); }catch(e){}
    if(o.onClose) o.onClose();
  }
  function load(first){
    var u = uid;
    return rpc('jag_contact_profile', { p_user: u }).then(function(j){
      if(u !== uid) return;
      if(!j || !j.ok){ $('pf').innerHTML = '<div class="pf-top"><div class="in"><button type="button" class="pf-back" data-a="close">← Contacts</button></div></div><div class="pf-load">' + (j && j.reason === 'not_found' ? 'This contact no longer exists.' : 'Could not load this profile.') + '</div>'; return; }
      // old links carry the app account id: from here on use the contact id
      if(j.contact && j.contact.id && j.contact.id !== uid){ uid = u = j.contact.id; try{ history.replaceState(null, '', '#c/' + u); }catch(e){} }
      P = j; render();
      if(first && !fub[u]) loadFub(u);
      loadFiles(u);
    }).catch(function(){ if(u === uid) $('pf').innerHTML = '<div class="pf-top"><div class="in"><button type="button" class="pf-back" data-a="close">← Contacts</button></div></div><div class="pf-load">Could not load this profile. Check your connection.</div>'; });
  }
  function loadFiles(u){
    return rpc('jag_contact_files', { p_contact: u }).then(function(j){ if(j && j.ok){ FILES[u] = j; if(u === uid && P) render(); } }).catch(function(){});
  }
  function fileIcon(n, m){ n = String(n || '').toLowerCase(); m = String(m || '');
    return /pdf/.test(m) || /\.pdf$/.test(n) ? '📄' : /^image\//.test(m) || /\.(jpe?g|png|heic|heif|webp|gif)$/.test(n) ? '🖼️' : /sheet|excel|csv/.test(m) || /\.(xlsx?|csv)$/.test(n) ? '📊' : '📎'; }
  function fsize(b){ b = +b || 0; return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b ? Math.max(1, Math.round(b / 1024)) + ' KB' : ''; }
  function upload(list){
    var u = uid, msg = function(t){ var m = $('pf-fmsg'); if(m) m.textContent = t; };
    var fl = Array.prototype.slice.call(list || []).filter(function(f){ return f && f.size; });
    if(!fl.length) return;
    var big = fl.filter(function(f){ return f.size > 26214400; }); fl = fl.filter(function(f){ return f.size <= 26214400; });
    if(big.length) toast(big.map(function(f){ return f.name; }).join(', ') + ': too big (25 MB max)');
    if(!fl.length) return;
    upl += fl.length; msg('Uploading ' + fl.length + ' file' + (fl.length === 1 ? '' : 's') + '…');
    var done = 0, bad = 0;
    fl.reduce(function(chain, f){ return chain.then(function(){
      var safe = (f.name || 'file').replace(/[^A-Za-z0-9._-]/g, '_').slice(-80), path = u + '/' + Date.now() + '-' + safe;
      return JagShare.token().then(function(t){
        return fetch(BASE + '/storage/v1/object/contact-files/' + path.split('/').map(encodeURIComponent).join('/'), { method: 'POST',
          headers: { apikey: KEY, Authorization: 'Bearer ' + t, 'Content-Type': f.type || 'application/octet-stream', 'x-upsert': 'false' }, body: f });
      }).then(function(r){ if(!r.ok) throw new Error('up');
        return rpc('jag_contact_file_add', { p_contact: u, p_path: path, p_name: f.name || safe, p_mime: f.type || null, p_size: f.size });
      }).then(function(j){ if(!j || !j.ok) throw new Error('add'); done++; }).catch(function(){ bad++; });
    }); }, Promise.resolve()).then(function(){
      upl -= fl.length;
      msg(bad ? (done ? done + ' uploaded · ' : '') + bad + ' could not upload. Try again.' : '');
      if(done) toast(done === 1 ? 'File added' : done + ' files added');
      return loadFiles(u);
    });
  }
  function openFile(bucket, path){
    var w = window.open('about:blank', '_blank');
    JagShare.token().then(function(t){
      return fetch(BASE + '/storage/v1/object/sign/' + bucket + '/' + path.split('/').map(encodeURIComponent).join('/'),
        { method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 600 }) });
    }).then(function(r){ return r.json(); }).then(function(j){ var x = j && (j.signedURL || j.signedUrl);
      if(x && w) w.location = BASE + '/storage/v1' + x; else { if(w) w.close(); toast('Could not open the file.'); } })
      .catch(function(){ if(w) w.close(); toast('Could not open the file.'); });
  }
  function loadFub(u){
    fub[u] = { loading: true };
    hub('fub_history', { contact_id: u }).then(function(j){ fub[u] = j && j.ok ? j : { error: true }; if(u === uid && P) render(); }).catch(function(){ fub[u] = { error: true }; });
  }

  /* ---------------- render ---------------- */
  function cObj(){ var c = P.contact; return { id: c.id, user_id: c.user_id, stage: c.stage, name: c.name, email: c.email, phone: c.phone, lang: c.lang, journey: P.journey, priority: P.priority, created_at: c.created_at }; }
  function render(){
    var el = $('pf'); if(!el || !P) return;
    var c = P.contact, ids = o.listIds ? o.listIds() : [], i = ids.indexOf(c.id);
    var keepScroll = el.scrollTop;
    el.innerHTML =
      '<div class="pf-top"><div class="in"><button type="button" class="pf-back" data-a="close">← Contacts</button>' +
        '<div class="pf-nav">' + (i >= 0 ? '<span>Contact ' + (i + 1) + ' of ' + ids.length + '</span>' : '') +
        '<button type="button" data-a="prev" aria-label="Previous contact"' + (i > 0 ? '' : ' disabled') + '>‹</button><button type="button" data-a="next" aria-label="Next contact"' + (i >= 0 && i < ids.length - 1 ? '' : ' disabled') + '>›</button></div></div>' +
        '<div class="pf-tabs" role="tablist">' + [['c', 'History'], ['l', 'Details'], ['r', 'Lola & tasks']].map(function(t){ return '<button type="button" role="tab" data-col="' + t[0] + '" aria-selected="' + (col === t[0]) + '">' + t[1] + '</button>'; }).join('') + '</div></div>' +
      '<div class="pf-grid"><div class="pf-col pf-l' + (col === 'l' ? ' on' : '') + '">' + left() + '</div>' +
        '<div class="pf-col pf-c' + (col === 'c' ? ' on' : '') + '">' + center() + '</div>' +
        '<div class="pf-col pf-r' + (col === 'r' ? ' on' : '') + '">' + right() + '</div></div>';
    el.scrollTop = keepScroll;
    fillComposer();
  }

  function left(){
    var c = P.contact, pr = P.priority || {}, sc = (P.score || {}).score || 0, ph = digits(c.phone);
    var last = P.last_contact ? 'Last contact ' + ago(P.last_contact) : 'No communication yet';
    var app = !!c.user_id;
    var badges = (!app ? '<span class="pb">Not on the app yet</span>' : sc >= 70 ? '<span class="pb hot">🔥 Hot · ' + sc + '</span>' : '<span class="pb">Score ' + sc + '</span>') +
      (pr.proof ? '<span class="pb ok">Verified ' + (pr.proof === 'pof' ? 'funds' : 'pre-approval') + '</span>' : '') +
      (c.stage ? '<span class="pb">' + esc(c.stage) + '</span>' : '') + (c.lang === 'en' ? '<span class="pb">English</span>' : '<span class="pb">Español</span>');
    var team = P.team || [];
    var opt = function(v, sel, label){ return '<option value="' + esc(v) + '"' + (v === sel ? ' selected' : '') + '>' + esc(label) + '</option>'; };
    return '<div class="pc"><div class="pf-who"><div class="pf-av" aria-hidden="true">' + esc(initials(c.name || c.email)) + '</div><div><h2>' + esc(c.name || c.email) + '</h2><small>' + esc(last) + (app ? ' · on the site ' + esc(ago(c.last_seen_at) || 'never') : '') + '</small></div></div>' +
        '<div class="pf-badges">' + badges + '</div>' +
        '<div class="pf-qa">' + (ph ? '<a href="tel:+1' + ph + '" data-a="callnow">📞<span>Call</span></a><a href="#" data-a="tab" data-t="text">💬<span>Text</span></a>' : '<a class="x">📞<span>Call</span></a><a class="x">💬<span>Text</span></a>') +
          (c.email ? '<a href="#" data-a="tab" data-t="email">✉️<span>Email</span></a>' : '<a class="x">✉️<span>Email</span></a>') +
          (app ? '<button type="button" data-a="msg">🗨️<span>App msg</span></button>' : '<button type="button" data-a="invite">📱<span>Invite to app</span></button>') + '</div></div>' +
      '<div class="pc"><h3>Journey</h3>' + (window.JagCRM ? JagCRM.journey(cObj()) : '') + '</div>' +
      '<div class="pc"><h3>Contact</h3><dl class="kv">' +
        '<dt>Cell</dt><dd>' + (ph ? '<a href="tel:+1' + ph + '">' + esc(fmtPhone(c.phone)) + '</a>' : '<span class="none">No phone</span>') + '</dd>' +
        '<dt>Email</dt><dd>' + (c.email ? '<a href="mailto:' + esc(c.email) + '">' + esc(c.email) + '</a>' : '<span class="none">No email</span>') + '</dd>' +
        '<dt>Language</dt><dd><select data-f="lang">' + opt('es', c.lang, 'Español') + opt('en', c.lang, 'English') + '</select></dd>' +
        (c.contact_pref || c.contact_time ? '<dt>Prefers</dt><dd>' + esc([cap(c.contact_pref || ''), c.contact_time ? c.contact_time : ''].filter(Boolean).join(', ')) + '</dd>' : '') +
        (c.buys_with ? '<dt>Buys with</dt><dd>' + esc(c.buys_with) + '</dd>' : '') +
        '<dt>Texts OK</dt><dd>' + (c.sms_ok ? 'Yes' : 'Not yet') + '</dd>' +
      '</dl></div>' +
      '<div class="pc"><h3>Details</h3><dl class="kv">' +
        // a stage with a default owner hands the contact to that teammate (they get a notification and a text from Lola)
        '<dt>Stage</dt><dd><select data-f="stage"><option value="">—</option>' + stageList(c.stage).map(function(s){ var ow = (P.stage_owners || {})[s];
          return opt(s, c.stage, s + (ow && ow !== c.agent_code && s !== c.stage ? '  → ' + agentFirst(ow) : '')); }).join('') + '</select></dd>' +
        '<dt>Assigned to</dt><dd><select data-f="agent_code"><option value="">Nobody</option>' + team.map(function(a){ return opt(a.code, c.agent_code, a.name); }).join('') + '</select></dd>' +
        '<dt>Showing</dt><dd>' + (c.showing_agent_code ? esc(agentName(c.showing_agent_code)) : '<span class="none">Not set</span>') + '</dd>' +
        '<dt>Source</dt><dd><input type="text" data-f="source" value="' + esc(c.source || (!c.user_id ? '' : P.journey && P.journey.invite ? 'Invite from ' + agentFirst(P.journey.invite.by) : 'JAG Homes website')) + '" placeholder="Where they came from"></dd>' +
        (c.pond ? '<dt>Pond</dt><dd>' + esc(c.pond) + '</dd>' : '') +
        '<dt>Added</dt><dd>' + esc(when(c.created_at)) + '</dd>' +
        '<dt>App account</dt><dd>' + (c.joined_at ? esc(when(c.joined_at)) : '<span class="none">Not yet</span>') + '</dd>' +
        '<dt>Tags</dt><dd><div class="tags">' + (c.tags || []).map(function(t){ return '<span class="tag">' + esc(t) + '<button type="button" data-a="untag" data-v="' + esc(t) + '" aria-label="Remove tag ' + esc(t) + '">×</button></span>'; }).join('') +
          '<input type="text" id="pf-tag" placeholder="+ tag" aria-label="Add a tag"></div></dd>' +
      '</dl></div>' +
      '<div class="pc"><h3>Background</h3><textarea data-f="background" placeholder="What the team should know: family, job, timeline, what they want…">' + esc(c.background || '') + '</textarea></div>' +
      '<div class="pc"><h3>Links</h3><dl class="kv">' + fubLine() +
        '<dt>Admin</dt><dd><a href="admin.html" target="_blank" rel="noopener">Open the admin client list ↗</a></dd></dl></div>';
  }
  function stageList(cur){ var l = (P.stages && P.stages.length ? P.stages : STAGES).slice(); if(cur && l.indexOf(cur) < 0) l.unshift(cur); return l; }
  function fubLine(){
    var f = fub[uid] || {}, id = P.contact.fub_person_id;
    var url = f.url || (id ? 'https://jasonhoustonrealty.followupboss.com/2/people/view/' + id : '');
    return '<dt>Follow Up Boss</dt><dd>' + (url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">Open in FUB ↗</a>' + (f.stage ? ' <small class="none">· ' + esc(f.stage) + '</small>' : '') : f.loading ? '<span class="none">Looking…</span>' : '<span class="none">Not in FUB</span>') + '</dd>';
  }

  /* ---------- center: composer, summary, history ---------- */
  function center(){
    return '<div class="pc cmp"><div class="cmp-tabs" role="tablist">' +
        [['note', '📝 Note'], ['email', '✉️ Email'], ['text', '💬 Text'], ['call', '📞 Log call']].map(function(t){ return '<button type="button" role="tab" data-a="tab" data-t="' + t[0] + '" aria-selected="' + (tab === t[0]) + '">' + t[1] + '</button>'; }).join('') +
        '</div><div id="pf-cmp"></div></div>' +
      '<div class="pc sum"><h3>✨ Lola\'s summary</h3><ul>' + summary().map(function(s){ return '<li>' + s + '</li>'; }).join('') + '</ul></div>' +
      '<div class="pc"><h3>History</h3>' + histHtml() + '</div>';
  }
  var cmpDraft = {};   // what the agent typed, kept across re-renders
  function fillComposer(){
    var box = $('pf-cmp'); if(!box) return;
    var c = P.contact, ph = digits(c.phone), notifyable = notifyList();
    var d = cmpDraft[tab] || {};
    if(tab === 'note'){
      box.innerHTML = '<textarea id="cm-body" placeholder="Add a note (only the team sees it)">' + esc(d.body || '') + '</textarea>' +
        (notifyable.length ? '<div class="cmp-to" style="margin-top:8px">Notify:</div><div class="chips" id="cm-notify">' + notifyable.map(function(a){ return '<button type="button" data-code="' + esc(a.code) + '" aria-pressed="' + (!!(d.notify || {})[a.code]) + '">' + esc(a.first) + '</button>'; }).join('') + '</div>' : '') +
        '<div class="cmp-row"><span class="sp"></span><button type="button" class="pbtn" data-a="savenote">Save note</button></div><div class="msg" id="cm-msg"></div>';
    } else if(tab === 'email'){
      box.innerHTML = c.email ? '<div class="cmp-to">To <b>' + esc(c.email) + '</b> · from your name, replies come to you</div>' +
        '<input type="text" id="cm-sub" placeholder="Subject" value="' + esc(d.subject || '') + '" style="margin-bottom:8px">' +
        '<textarea id="cm-body" placeholder="Write your email, or tap a Lola draft on the right" style="min-height:150px">' + esc(d.body || '') + '</textarea>' +
        '<div class="cmp-row"><button type="button" class="pbtn g s" data-a="lolawrite" data-k="email">✨ Lola, write it</button><span class="sp"></span><button type="button" class="pbtn" data-a="sendemail">Send email</button></div><div class="msg" id="cm-msg"></div>'
        : '<div class="none">This client has no email yet. Add it in Follow Up Boss or ask them in a text.</div>';
    } else if(tab === 'text'){
      box.innerHTML = ph ? '<div class="cmp-to">To <b>' + esc(fmtPhone(c.phone)) + '</b> · sends from your phone, saved here</div>' +
        '<textarea id="cm-body" placeholder="Write your text, or tap a Lola draft on the right">' + esc(d.body || '') + '</textarea>' +
        '<div class="cmp-row"><button type="button" class="pbtn g s" data-a="lolawrite" data-k="text">✨ Lola, write it</button><span class="sp"></span><button type="button" class="pbtn g" data-a="sendwa">WhatsApp</button><button type="button" class="pbtn" data-a="sendsms">Open in Messages</button></div><div class="msg" id="cm-msg"></div>'
        : '<div class="none">No cell phone on file.</div>';
    } else {
      var oc = d.outcome || 'talked';
      box.innerHTML = '<div class="chips" id="cm-oc" role="radiogroup" aria-label="Call outcome">' + [['talked', 'Talked'], ['voicemail', 'Left voicemail'], ['noanswer', 'No answer'], ['bad', 'Bad number']].map(function(x){ return '<button type="button" role="radio" data-v="' + x[0] + '" aria-pressed="' + (oc === x[0]) + '">' + x[1] + '</button>'; }).join('') + '</div>' +
        '<textarea id="cm-body" placeholder="What did you talk about? Next step?" style="margin-top:10px">' + esc(d.body || '') + '</textarea>' +
        '<div class="cmp-row">' + (ph ? '<a class="pbtn g" href="tel:+1' + ph + '">📞 Call ' + esc(fmtPhone(c.phone)) + '</a>' : '') + '<span class="sp"></span><button type="button" class="pbtn" data-a="logcall">Log call</button></div><div class="msg" id="cm-msg"></div>';
    }
    var b = $('cm-body'); if(b) b.addEventListener('input', function(){ (cmpDraft[tab] = cmpDraft[tab] || {}).body = b.value; });
    var s = $('cm-sub'); if(s) s.addEventListener('input', function(){ (cmpDraft[tab] = cmpDraft[tab] || {}).subject = s.value; });
  }
  function notifyList(){
    var seen = {}, out = [], add = function(code){ if(!code || seen[code] || code === (me || {}).code) return; seen[code] = 1; out.push({ code: code, first: agentFirst(code) }); };
    add(P.contact.agent_code); add(P.contact.showing_agent_code); (P.collaborators || []).forEach(function(k){ add(k.code); });
    return out;
  }
  function cmsg(m, kind){ var e = $('cm-msg'); if(e){ e.textContent = m || ''; e.className = 'msg ' + (kind || ''); } }

  function summary(){
    var c = P.contact, j = P.journey || {}, L = j.looking || {}, sc = P.score || {}, out = [], f = esc(first(c.name) || 'This client');
    if(c.user_id) out.push(f + ' joined the app ' + esc(ago(c.joined_at || c.created_at)) + (j.invite ? ' from ' + esc(agentFirst(j.invite.by)) + '\'s invite' : '') + '; last on the site ' + esc(ago(c.last_seen_at) || 'never') + '.');
    else out.push(f + ' came in ' + esc(ago(c.created_at)) + (c.source ? ' from ' + esc(c.source) : '') + (c.stage ? ' · stage <b>' + esc(c.stage) + '</b>' : '') + '. <b>Not on the app yet</b>: send the invite so they can save homes and you can see what they like.');
    out.push(j.screen ? 'Screened ' + esc(when(j.screen.at).split(' · ')[0]) + (j.screen.by ? ' by ' + esc(j.screen.by) : '') + ': ' + esc(LANE[j.screen.lane] || j.screen.lane || '') + (j.screen.score != null ? ', ' + j.screen.score + '%' : '') + (j.screen.hot ? ', hot 🔥' : '') + '.' : '<b>Not screened yet.</b>');
    out.push(j.loan ? 'Loan: <b>' + esc(LOAN[j.loan.stage] || j.loan.stage) + '</b>' + (j.app ? ' (app sent ' + esc(when(j.app.at).split(' · ')[0]) + ')' : '') + '.' : j.app ? 'Loan app sent ' + esc(when(j.app.at).split(' · ')[0]) + '.' : 'No loan application yet.');
    if((L.views || 0) + (L.saved || 0)) out.push('Looking: ' + (L.views || 0) + ' homes viewed, ' + (L.saved || 0) + ' saved' + (sc.top_zip ? ', mostly in ' + esc(sc.top_zip) : '') + (sc.best_hour != null ? '; usually online ~' + ((sc.best_hour + 11) % 12 + 1) + (sc.best_hour < 12 ? ' AM' : ' PM') : '') + '.');
    var lastTouch = (P.timeline || []).filter(function(e){ return ['call', 'email', 'text'].indexOf(e.kind) >= 0; })[0];
    out.push(lastTouch ? 'Last touch: ' + esc(lastTouch.kind) + ' by ' + esc(first(lastTouch.who) || 'the team') + ', ' + esc(ago(lastTouch.at)) + '.' : '<b>No calls, texts or emails logged here yet.</b>');
    if(window.JagCRM && JagCRM.next){ var n = JagCRM.next(cObj()); if(n.k !== 'ok') out.push(n.t); }
    return out;
  }

  var KINDS = {
    note: ['📝', 'notes'], system: ['•', 'notes'], call: ['📞', 'calls'], email: ['✉️', 'emails'], text: ['💬', 'texts'], msg: ['🗨️', 'texts'],
    ai: ['🤖', 'ai'], homes: ['🏠', 'homes'], list: ['📋', 'homes'], alert: ['🔔', 'emails'], saved: ['❤️', 'homes'], screen: ['🎧', 'loan'], app: ['📄', 'loan'],
    tour: ['👟', 'tours'], offer: ['🤝', 'offers'], account: ['👋', 'notes'], fubnote: ['📝', 'fub'], fubcall: ['📞', 'fub']
  };
  var FILTERS = [['all', 'All'], ['notes', 'Notes'], ['calls', 'Calls'], ['emails', 'Emails'], ['texts', 'Texts'], ['ai', 'AI'], ['homes', 'Homes'], ['tours', 'Tours'], ['loan', 'Loan'], ['offers', 'Offers'], ['fub', 'Follow Up Boss']];
  function events(){
    var ev = (P.timeline || []).slice(), f = fub[uid];
    if(f && f.found){
      (f.notes || []).forEach(function(n, i){ ev.push({ at: n.at, kind: 'fubnote', who: n.by, title: n.subject || 'Follow Up Boss note', body: n.body, id: 'fn' + i }); });
      (f.calls || []).forEach(function(c, i){ ev.push({ at: c.at, kind: 'fubcall', who: c.by, title: (c.incoming ? 'Incoming' : 'Outgoing') + ' call in Follow Up Boss' + (c.duration ? ' · ' + Math.round(c.duration / 60) + ' min' : ''), body: c.note, meta: { outcome: c.outcome }, id: 'fc' + i }); });
      ev.sort(function(a, b){ return new Date(b.at) - new Date(a.at); });
    }
    return ev;
  }
  function grp(e){ var k = KINDS[e.kind]; var g = k ? k[1] : 'notes'; return g; }
  function histHtml(){
    var ev = events(), counts = {};
    ev.forEach(function(e){ var g = grp(e); counts[g] = (counts[g] || 0) + 1; if(e.kind === 'fubcall') counts.calls = (counts.calls || 0) + 1; if(e.kind === 'fubnote') counts.notes = (counts.notes || 0) + 1; });
    var list = filt === 'all' ? ev : ev.filter(function(e){ return grp(e) === filt || (filt === 'calls' && e.kind === 'fubcall') || (filt === 'notes' && e.kind === 'fubnote'); });
    var f = fub[uid] || {};
    return '<div class="flt" role="group" aria-label="Filter history">' + FILTERS.filter(function(x){ return x[0] === 'all' || counts[x[0]]; }).map(function(x){
        return '<button type="button" data-a="filt" data-v="' + x[0] + '" aria-pressed="' + (filt === x[0]) + '">' + x[1] + '<i>' + (x[0] === 'all' ? ev.length : counts[x[0]]) + '</i></button>'; }).join('') + '</div>' +
      (f.loading ? '<div class="none" style="font-size:12.5px;margin:4px 0">Bringing in Follow Up Boss notes and calls…</div>' : '') +
      (list.length ? '<ul class="tln">' + list.slice(0, open.__all ? 400 : 60).map(evRow).join('') + '</ul>' + (list.length > 60 && !open.__all ? '<button type="button" class="pbtn g s" data-a="more">Show all ' + list.length + '</button>' : '') : '<div class="empty2">Nothing here yet.</div>');
  }
  function evRow(e){
    var k = KINDS[e.kind] || ['•'], m = e.meta || {}, x = '', body = e.body || '';
    if(e.kind === 'system') return '<li class="ev k-system"><span class="ic">' + k[0] + '</span><div class="b">' + esc(e.title) + ' · ' + esc(first(e.who)) + ' · ' + esc(ago(e.at)) + '</div></li>';
    var title = e.title || ({ note: 'Note', call: 'Call', email: 'Email', text: 'Text from ' + first(e.who) }[e.kind] || cap(e.kind));
    if(e.kind === 'call') title = 'Call' + (m.outcome ? '' : '');
    if(e.kind === 'text') title = 'Text sent' + (m.via === 'whatsapp' ? ' on WhatsApp' : ' from ' + (first(e.who) || 'phone'));
    if(e.kind === 'email' && e.title) title = 'Email: ' + e.title;
    if(e.kind === 'ai'){
      var msgs = m.msgs || [];
      x += '<div class="x"><button type="button" data-a="tog" data-v="' + esc(e.id) + '">' + (open[e.id] ? 'Hide conversation' : 'Show conversation (' + (m.turns || msgs.length) + ')') + '</button>' + (m.call_requested ? '<span class="oc">Asked for a call</span>' : '') + '</div>';
      if(m.summary) body = m.summary;
      if(open[e.id]) x += '<div class="tr">' + msgs.map(function(t){ return '<div class="' + (t.role === 'user' ? 'u' : 'a') + '">' + esc(t.text) + '</div>'; }).join('') + '</div>';
    }
    if(e.kind === 'homes') x += '<div class="x"><span class="none">' + ((m.mls || []).length) + ' home' + ((m.mls || []).length === 1 ? '' : 's') + (m.channel ? ' · by ' + esc(m.channel) : '') + '</span>' + (m.link ? '<a href="' + esc(m.link) + '" target="_blank" rel="noopener">Open ↗</a>' : '') + '</div>';
    if(e.kind === 'list') x += '<div class="x"><span class="none">' + (m.homes || 0) + ' homes · ❤️ ' + (m.loved || 0) + ' loved · opened ' + (m.opens || 0) + '×</span><a href="matrix.html#cart=' + esc(m.cart) + '">Open in Matrix</a></div>';
    if(e.kind === 'saved'){ var sn = m.snap || {}; body = [sn.addr, sn.city].filter(Boolean).join(', ') + (sn.price ? ' · ' + money(sn.price) : ''); x += '<div class="x"><a href="homes#' + encodeURIComponent(m.mls || '') + '" target="_blank" rel="noopener">View home ↗</a></div>'; }
    if(e.kind === 'screen') x += '<div class="x"><a href="screener.html#s=' + esc(m.id) + '">Open screening</a>' + (m.est_max ? '<span class="none">Could buy up to ~' + money(m.est_max) + '</span>' : '') + '</div>';
    if(e.kind === 'app') x += '<div class="x"><span class="none">' + esc(m.status || 'New') + (m.est ? ' · est. ' + money(m.est) : '') + '</span><a href="admin.html" target="_blank" rel="noopener">Open in Admin ↗</a></div>';
    if(e.kind === 'offer' && m.price) x += '<div class="x"><span class="none">Offer ' + money(m.price) + (m.list ? ' · list ' + money(m.list) : '') + '</span></div>';
    if(e.kind === 'tour' && m.homes != null) x += '<div class="x"><span class="none">' + m.homes + ' home' + (m.homes === 1 ? '' : 's') + '</span></div>';
    var oc = (e.kind === 'call' || e.kind === 'fubcall') && m.outcome ? '<span class="oc">' + esc({ talked: 'Talked', voicemail: 'Voicemail', noanswer: 'No answer', bad: 'Bad number' }[m.outcome] || m.outcome) + '</span>' : '';
    var who = e.kind === 'fubnote' || e.kind === 'fubcall' ? (e.who ? esc(e.who) + ' · ' : '') + 'Follow Up Boss' : esc(e.who || '');
    var long = body.length > 320 && !open[e.id];
    return '<li class="ev k-' + esc(e.kind) + '"><span class="ic" aria-hidden="true">' + k[0] + '</span><div class="b"><div class="h"><b>' + esc(title) + oc + '</b><time title="' + esc(when(e.at)) + '">' + esc(ago(e.at)) + '</time></div>' +
      (who ? '<div class="w">' + who + '</div>' : '') +
      (body ? '<div class="t' + (long ? ' cl' : '') + '">' + esc(body) + '</div>' + (body.length > 320 ? '<div class="x"><button type="button" data-a="tog" data-v="' + esc(e.id) + '">' + (open[e.id] ? 'Show less' : 'Show more') + '</button></div>' : '') : '') + x + '</div></li>';
  }

  /* ---------- right: Lola, tasks, collaborators, tours, offers, loan, lists, activity ---------- */
  function right(){
    var c = P.contact, n = window.JagCRM && JagCRM.next ? JagCRM.next(cObj()) : { t: '', a: '' };
    var lola = '<div class="pc lola"><h3>🤖 Lola · next best step</h3><div class="nx"><span>' + n.t + '</span>' + (n.a || '') + '</div>' +
      '<div style="margin-top:12px" class="crm-lbl">Ready to send</div>' + drafts().map(function(d, i){
        return '<div class="dr"><span class="k">' + (d.kind === 'email' ? '✉️ Email' : '💬 Text') + ' · ' + esc(d.label) + '</span>' + (d.subject ? '<b>' + esc(d.subject) + '</b>' : '') + '<p>' + esc(d.body) + '</p>' +
          '<div class="a"><button type="button" class="pbtn s" data-a="usedraft" data-i="' + i + '">' + (d.kind === 'email' ? 'Review & send' : 'Use this text') + '</button>' +
          (d.kind === 'text' && digits(c.phone) ? '<button type="button" class="pbtn g s" data-a="senddraft" data-i="' + i + '">Send from my phone</button>' : '') + '</div></div>';
      }).join('') +
      '<div class="ask"><input type="text" id="pf-ask" placeholder="Ask Lola about this client…" aria-label="Ask Lola"><button type="button" class="pbtn k s" data-a="ask">Ask</button></div>' +
      (lolaAns ? '<div class="ans">' + esc(lolaAns) + '</div>' : '') + '</div>';
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var tasks = '<div class="pc"><h3>Tasks <button type="button" class="add" data-a="tadd" aria-label="Add task">+</button></h3>' +
      ((P.tasks || []).length ? P.tasks.map(function(t){
        var over = !t.done_at && t.due_at && new Date(t.due_at) < new Date();
        return '<div class="li' + (t.done_at ? ' done' : '') + '"><input type="checkbox" data-a="tdone" data-id="' + t.id + '"' + (t.done_at ? ' checked' : '') + ' aria-label="Done: ' + esc(t.title) + '"><div class="m"><b>' + esc(t.title) + '</b><small>' +
          (t.due_at ? '<span class="' + (over ? 'due' : '') + '">' + (over ? 'Overdue · ' : 'Due ') + esc(day(t.due_at)) + '</span> · ' : '') + esc(agentFirst(t.agent_code)) + '</small></div><button type="button" class="rm" data-a="tdel" data-id="' + t.id + '" aria-label="Delete task">×</button></div>';
      }).join('') : '<div class="none">No tasks yet.</div>') +
      (open.__tadd ? '<div class="tadd"><input type="text" id="t-title" placeholder="Call back about paystubs"><div class="r2"><select id="t-due"><option value="0">Today</option><option value="1" selected>Tomorrow</option><option value="3">In 3 days</option><option value="7">Next week</option><option value="">No date</option></select>' +
        '<select id="t-who">' + (P.team || []).map(function(a){ return '<option value="' + esc(a.code) + '"' + (a.code === ((me || {}).code) ? ' selected' : '') + '>' + esc(a.first_name || a.name) + '</option>'; }).join('') + '</select></div><button type="button" class="pbtn s" data-a="tsave">Add task</button></div>' : '') + '</div>';
    var inTeam = {}; (P.collaborators || []).forEach(function(k){ inTeam[k.code] = 1; });
    var FL = FILES[uid] || {}, tf = FL.files || [], cf = FL.client || (P.proof || []).map(function(p){ return Object.assign({ bucket: 'client-proof' }, p); });
    var files = '<div class="pc" id="pf-files"><h3>Files' + (tf.length + cf.length ? ' (' + (tf.length + cf.length) + ')' : '') +
        ' <label class="add" aria-label="Add files">+<input type="file" multiple hidden data-a="fup"></label></h3>' +
      '<label class="fdrop" id="pf-fdrop">📎 Drop files here or tap to add<small style="display:block;font-weight:600;margin-top:2px">PDF, photos, Word, Excel · up to 25 MB · only your team can see them</small><input type="file" multiple hidden data-a="fup"></label>' +
      tf.map(function(f){ return '<div class="li"><span class="av2">' + fileIcon(f.file_name, f.mime) + '</span><div class="m"><b>' + esc(f.file_name) + '</b><small>' +
          esc([fsize(f.size), (f.uploaded_by ? agentFirst(f.uploaded_by) + ' · ' : '') + ago(f.uploaded_at)].filter(Boolean).join(' · ')) + '</small></div>' +
          '<button type="button" class="fo" data-a="fopen" data-b="contact-files" data-p="' + esc(f.path) + '">Open</button>' +
          '<button type="button" class="rm" data-a="fdel" data-id="' + f.id + '" data-n="' + esc(f.file_name) + '" aria-label="Remove ' + esc(f.file_name) + '">×</button></div>'; }).join('') +
      cf.map(function(p){ return '<div class="li"><span class="av2">📎</span><div class="m"><b>' + esc(p.kind === 'pof' ? 'Proof of funds' : 'Pre-approval letter') + '</b><small>' +
          esc([p.file_name, 'from the client', ago(p.uploaded_at), p.status].filter(Boolean).join(' · ')) + '</small></div>' +
          (p.path ? '<button type="button" class="fo" data-a="fopen" data-b="client-proof" data-p="' + esc(p.path) + '">Open</button>' : '') + '</div>'; }).join('') +
      '<div class="fmsg" id="pf-fmsg" role="status"></div></div>';
    var collab = '<div class="pc"><h3>Collaborators <button type="button" class="add" data-a="cadd" aria-label="Add collaborator">+</button></h3>' +
      '<div class="li"><span class="av2">' + esc(initials(agentName(c.agent_code) || '?')) + '</span><div class="m"><b>' + esc(c.agent_code ? agentName(c.agent_code) : 'Nobody assigned') + '</b><small>Assigned agent</small></div></div>' +
      (P.collaborators || []).map(function(k){ return '<div class="li"><span class="av2">' + (k.photo_url ? '<img src="' + esc(k.photo_url) + '" alt="">' : esc(initials(k.name))) + '</span><div class="m"><b>' + esc(k.name || k.code) + '</b><small>Added ' + esc(ago(k.at)) + (k.added_by ? ' by ' + esc(agentFirst(k.added_by)) : '') + '</small></div><button type="button" class="rm" data-a="crm" data-code="' + esc(k.code) + '" aria-label="Remove ' + esc(k.name || k.code) + '">×</button></div>'; }).join('') +
      (open.__cadd ? '<div class="tadd"><select id="c-who"><option value="">Pick a teammate…</option>' + (P.team || []).filter(function(a){ return !inTeam[a.code] && a.code !== c.agent_code; }).map(function(a){ return '<option value="' + esc(a.code) + '">' + esc(a.name) + '</option>'; }).join('') + '</select>' +
        '<button type="button" class="pbtn s" data-a="csave">Add collaborator</button><span class="none">They get a notification and a Lola text, and see the full history.</span></div>' : '') + '</div>';
    var tours = (P.tours || []), offers = (P.offers || []), apps = (P.apps || []), lists = (P.lists || []), favs = (P.favorites || []);
    var showBtn = o.isLead ? '<button type="button" class="add" data-a="shw" aria-label="Set up showings">+</button>' : '';
    var tourCard = '<div class="pc"><h3>Tours & showings ' + showBtn + '</h3>' + (tours.length ? tours.map(function(t){ return '<div class="li"><div class="m"><b>' + esc(day(t.tour_date)) + ' · ' + esc(t.time_window || '') + '</b><small>' + esc(cap(t.status)) + ' · ' + t.homes + ' home' + (t.homes === 1 ? '' : 's') + (t.showing_agent ? ' · ' + esc(agentFirst(t.showing_agent)) : '') + '</small></div></div>'; }).join('') : '<div class="none">No tours yet.' + (c.showing_agent_code ? ' Showing agent: ' + esc(agentFirst(c.showing_agent_code)) + '.' : '') + '</div>') + '</div>';
    var offerCard = '<div class="pc"><h3>Offers <button type="button" class="add" data-a="offer" aria-label="Write an offer">+</button></h3>' + (offers.length ? offers.map(function(x){ return '<div class="li"><div class="m"><b>' + esc(x.address || 'MLS ' + x.mls) + '</b><small>' + money(x.offer_price) + ' · ' + esc(window.JagOffer ? JagOffer.statusText(x.status) : x.status) + ' · ' + esc(ago(x.created_at)) + '</small></div></div>'; }).join('') : '<div class="none">No offers yet.</div>') + '</div>';
    var loanCard = '<div class="pc"><h3>Loan</h3>' + (apps.length ? apps.map(function(a){ return '<div class="li"><span class="av2">📄</span><div class="m"><b>JAG Home Loan app</b><small>' + esc(when(a.created_at).split(' · ')[0]) + ' · ' + esc(a.status || 'New') + (a.est_amount ? ' · est. ' + money(a.est_amount) : '') + '</small></div><a href="admin.html" target="_blank" rel="noopener">Open ↗</a></div>'; }).join('') : '<div class="none">No loan application yet.</div>') +
      '</div>';
    var listCard = lists.length ? '<div class="pc"><h3>Client lists (Matrix)</h3>' + lists.map(function(l){ return '<div class="li"><div class="m"><b>' + esc(l.name) + '</b><small>' + l.homes + ' homes · ❤️ ' + l.loved + ' · opened ' + l.opens + '×</small></div><a href="matrix.html#cart=' + esc(l.id) + '">Open</a></div>'; }).join('') + '</div>' : '';
    var favCard = '<div class="pc"><h3>Saved homes (' + favs.length + ')</h3>' + (favs.length ? favs.slice(0, 6).map(function(f){ var s = f.snap || {}; return '<div class="li"><div class="m"><b>' + esc(s.addr || 'MLS ' + f.mls) + '</b><small>' + esc([s.city, money(f.last_price || s.price), f.last_status && f.last_status !== 'Active' ? f.last_status : ''].filter(Boolean).join(' · ')) + '</small></div><a href="homes#' + encodeURIComponent(f.mls) + '" target="_blank" rel="noopener">View ↗</a></div>'; }).join('') : '<div class="none">Nothing saved yet.</div>') + '</div>';
    return lola + tasks + files + collab + tourCard + offerCard + loanCard + listCard + favCard;
  }

  /* ---------- Lola's ready-to-send messages (Spanish first, by where the client is) ---------- */
  function drafts(){
    var c = P.contact, es = c.lang !== 'en', f = first(c.name), a = (me && (me.first_name || first(me.name))) || 'Jason';
    var n = window.JagCRM && JagCRM.next ? JagCRM.next(cObj()).k : 'scr', j = P.journey || {}, sc = P.score || {}, L = j.looking || {};
    var hr = sc.best_hour != null ? ((sc.best_hour + 11) % 12 + 1) + (sc.best_hour < 12 ? ' AM' : ' PM') : '';
    var homes = SITE + '/homes?a=' + encodeURIComponent((me && me.code) || 'jason');
    var app = SITE + '/apply.html';
    var out = [];
    var T = function(esText, enText){ return es ? esText : enText; };
    if(n === 'scr' || n === 'app' && !j.screen){
      var acct = !!c.user_id;
      out.push({ kind: 'text', label: T('Agendar la llamada', 'Book the call'), body: T('¡Hola ' + f + '! Soy ' + a + ' de Jason Aguirre Group. ' + (acct ? 'Vi que creaste tu cuenta 🙌' : 'Vi que te interesa comprar casa 🏡') + ' ¿Tienes 5 minutos ' + (hr ? 'hoy como a las ' + hr : 'hoy') + ' para platicar de lo que buscas y ver tus opciones de préstamo?', 'Hi ' + f + '! It\'s ' + a + ' with Jason Aguirre Group. ' + (acct ? 'I saw you made your account 🙌' : 'I saw you\'re interested in buying a home 🏡') + ' Do you have 5 minutes ' + (hr ? 'today around ' + hr : 'today') + ' to talk about what you\'re looking for and your loan options?') });
      out.push({ kind: 'email', label: T(acct ? 'Bienvenida + llamada' : 'Primer paso + llamada', acct ? 'Welcome + call' : 'First step + call'), subject: T((acct ? 'Bienvenido(a), ' : 'Hola, ') + f + ': su primer paso', (acct ? 'Welcome, ' : 'Hi ') + f + ': your first step'),
        body: T('Hola ' + f + ',\n\n' + (acct ? 'Gracias por crear su cuenta. ' : 'Gracias por su interés en comprar casa. ') + 'Soy ' + a + ' y le voy a ayudar en todo el proceso.\n\nEl primer paso es una llamada de 5 minutos para entender qué busca y qué opciones de préstamo tiene (no afecta su crédito). ¿Qué día y hora le queda mejor?\n\nMientras tanto puede buscar casas y guardar sus favoritas aquí: ' + homes + '\n\nSaludos,\n' + a,
          'Hi ' + f + ',\n\n' + (acct ? 'Thanks for creating your account. ' : 'Thanks for your interest in buying a home. ') + 'I\'m ' + a + ' and I\'ll help you through the whole process.\n\nThe first step is a 5-minute call so I understand what you\'re looking for and your loan options (no hit to your credit). What day and time work best?\n\nMeanwhile you can search homes and save your favorites here: ' + homes + '\n\nBest,\n' + a) });
    }
    if(n === 'app'){
      out.push({ kind: 'text', label: T('Aplicación de préstamo', 'Loan application'), body: T('¡Hola ' + f + '! El siguiente paso es la aplicación de préstamo: toma 5 minutos y no afecta tu crédito. Aquí está: ' + app + ' Cualquier duda me dices.', 'Hi ' + f + '! The next step is the loan application: it takes 5 minutes and doesn\'t affect your credit. Here it is: ' + app + ' Any questions, let me know.') });
      out.push({ kind: 'email', label: T('Aplicación + documentos', 'Application + documents'), subject: T('Su siguiente paso: la aplicación (5 minutos)', 'Your next step: the application (5 minutes)'),
        body: T('Hola ' + f + ',\n\nEl siguiente paso es la aplicación de préstamo. Toma unos 5 minutos y no afecta su crédito:\n' + app + '\n\nTenga a la mano: sus últimos talones de pago, su W-2 o declaración de impuestos y una identificación.\n\nEn cuanto la mande, nuestro equipo la revisa y le llamamos el mismo día.\n\nSaludos,\n' + a,
          'Hi ' + f + ',\n\nThe next step is the loan application. It takes about 5 minutes and doesn\'t affect your credit:\n' + app + '\n\nHave these handy: your latest paystubs, your W-2 or tax return, and an ID.\n\nOnce you send it, our team reviews it and calls you the same day.\n\nBest,\n' + a) });
    }
    if(n === 'ok'){
      out.push({ kind: 'text', label: T('Seguimiento del préstamo', 'Loan check-in'), body: T('¡Hola ' + f + '! ¿Cómo vas con los documentos que pidió el lender? Si algo no está claro, aquí estoy para ayudarte. Mientras tanto, sigue guardando casas que te gusten en la app 🏡', 'Hi ' + f + '! How are the documents the lender asked for coming along? If anything is unclear, I\'m here to help. Meanwhile, keep saving homes you like in the app 🏡') });
      out.push({ kind: 'email', label: T('Mientras sale el préstamo', 'While the loan comes in'), subject: T('Mientras sale su pre-aprobación', 'While your pre-approval comes in'),
        body: T('Hola ' + f + ',\n\nSu préstamo va avanzando. Para que no se detenga, mande lo antes posible cualquier documento que le pida el lender (talones de pago, estados de cuenta, identificación).\n\nMientras tanto, vaya guardando las casas que le gusten aquí y así estamos listos para verlas en cuanto salga la pre-aprobación:\n' + homes + '\n\nCualquier duda, aquí estoy.\n' + a,
          'Hi ' + f + ',\n\nYour loan is moving along. To keep it moving, send the lender anything they ask for as soon as you can (paystubs, bank statements, ID).\n\nMeanwhile, save the homes you like here so we\'re ready to see them as soon as the pre-approval comes through:\n' + homes + '\n\nAny questions, I\'m here.\n' + a) });
    }
    if(n === 'homes'){
      var area = sc.top_zip ? T(' en ' + sc.top_zip, ' in ' + sc.top_zip) : '';
      out.push({ kind: 'text', label: T('Mandar casas', 'Send homes'), body: T('¡Hola ' + f + '! Te estoy armando una lista de casas' + area + ' que van con lo que buscas. ¿Algo que no sea negociable (recámaras, escuela, patio)? Te la mando hoy.', 'Hi ' + f + '! I\'m putting together a list of homes' + area + ' that fit what you want. Anything that\'s a must-have (bedrooms, school, yard)? I\'ll send it today.') });
      out.push({ kind: 'email', label: T('Casas para usted', 'Homes for you'), subject: T('Casas' + area + ' para usted, ' + f, 'Homes' + area + ' for you, ' + f),
        body: T('Hola ' + f + ',\n\nVi las casas que ha estado viendo y le preparé más opciones' + area + '. Puede verlas y guardar sus favoritas aquí:\n' + homes + '\n\nSi alguna le gusta, dígame y la agendamos para verla esta semana.\n\nSaludos,\n' + a,
          'Hi ' + f + ',\n\nI looked at the homes you\'ve been viewing and lined up more options' + area + '. See them and save your favorites here:\n' + homes + '\n\nIf one catches your eye, tell me and we\'ll see it this week.\n\nBest,\n' + a) });
    }
    if(n === 'show'){
      out.push({ kind: 'text', label: T('Agendar visitas', 'Book showings'), body: T('¡Hola ' + f + '! ' + (L.saved ? 'Vi que guardaste ' + L.saved + ' casa' + (L.saved === 1 ? '' : 's') + '. ' : '') + '¿Cuáles quieres ver primero? Tengo espacio este fin de semana.', 'Hi ' + f + '! ' + (L.saved ? 'I saw you saved ' + L.saved + ' home' + (L.saved === 1 ? '' : 's') + '. ' : '') + 'Which ones do you want to see first? I have time this weekend.') });
      out.push({ kind: 'email', label: T('Agendar visitas', 'Book showings'), subject: T('¿Vamos a ver casas este fin de semana?', 'Shall we see homes this weekend?'),
        body: T('Hola ' + f + ',\n\n' + (L.saved ? 'Vi que guardó ' + L.saved + ' casa' + (L.saved === 1 ? '' : 's') + ' en la app. ' : '') + 'Me gustaría llevarle a verlas. Respóndame con las que más le interesan y el día y la hora que le quedan mejor, y yo organizo el recorrido.\n\nSaludos,\n' + a,
          'Hi ' + f + ',\n\n' + (L.saved ? 'I saw you saved ' + L.saved + ' home' + (L.saved === 1 ? '' : 's') + ' in the app. ' : '') + 'I\'d love to take you to see them. Reply with the ones you like most and the day and time that work best, and I\'ll plan the tour.\n\nBest,\n' + a) });
    }
    if(n === 'offer'){
      out.push({ kind: 'text', label: T('Después de la visita', 'After the tour'), body: T('¡Hola ' + f + '! ¿Qué te parecieron las casas? Si una te encantó, podemos preparar la oferta hoy mismo antes de que alguien más la tome.', 'Hi ' + f + '! What did you think of the homes? If one stood out, we can write the offer today before someone else grabs it.') });
      out.push({ kind: 'email', label: T('Siguiente paso: oferta', 'Next step: the offer'), subject: T('¿Le hacemos una oferta?', 'Shall we make an offer?'),
        body: T('Hola ' + f + ',\n\nGracias por ver las casas conmigo. Si alguna le gustó, podemos preparar la oferta hoy mismo. Le explico el precio que recomiendo, el depósito y los siguientes pasos en una llamada de 10 minutos.\n\n¿A qué hora le marco?\n' + a,
          'Hi ' + f + ',\n\nThanks for touring with me. If one of the homes stood out, we can write the offer today. I\'ll walk you through the price I recommend, the earnest money and the next steps in a 10-minute call.\n\nWhat time should I call?\n' + a) });
    }
    if(n === 'done'){
      out.push({ kind: 'text', label: T('Rumbo al cierre', 'On the way to closing'), body: T('¡Hola ' + f + '! Todo va en camino para el cierre 🎉 Te aviso de cada paso. Si el lender te pide algo, mándamelo y lo revisamos juntos.', 'Hi ' + f + '! Everything is on track for closing 🎉 I\'ll keep you posted on every step. If the lender asks for anything, send it my way and we\'ll review it together.') });
    }
    var lastSeen = c.last_seen_at ? (Date.now() - new Date(c.last_seen_at)) / 864e5 : 99;
    if(lastSeen > 7) out.push({ kind: 'text', label: T('Reactivar', 'Re-engage'), body: T('¡Hola ' + f + '! Hace días que no platicamos. ¿Sigues buscando casa? Salieron opciones nuevas que te pueden gustar; te las mando si quieres.', 'Hi ' + f + '! It\'s been a few days. Are you still looking for a home? Some new ones came up that you might like; want me to send them?') });
    return out.slice(0, 3);
  }

  /* ---------------- actions ---------------- */
  function onClick(e){
    var b = e.target.closest('[data-a],[data-col],#cm-notify [data-code],#cm-oc [data-v],[data-shw],[data-lofr]');
    if(!b) return;
    if(b.hasAttribute('data-col')){ col = b.getAttribute('data-col'); render(); return; }
    if(b.closest('#cm-notify')){ var d0 = cmpDraft.note = cmpDraft.note || {}; d0.notify = d0.notify || {}; var cd = b.getAttribute('data-code'); d0.notify[cd] = !d0.notify[cd]; b.setAttribute('aria-pressed', String(!!d0.notify[cd])); return; }
    if(b.closest('#cm-oc')){ (cmpDraft.call = cmpDraft.call || {}).outcome = b.getAttribute('data-v'); b.parentNode.querySelectorAll('[data-v]').forEach(function(x){ x.setAttribute('aria-pressed', String(x === b)); }); return; }
    if(b.hasAttribute('data-shw')){ e.preventDefault(); showings(); return; }
    if(b.hasAttribute('data-lofr')){ e.preventDefault(); offer(); return; }
    var a = b.getAttribute('data-a'), c = P && P.contact;
    if(a === 'close'){ closeProfile(); return; }
    if(a === 'prev' || a === 'next'){ var ids = o.listIds(), i = ids.indexOf(uid); var to = ids[a === 'prev' ? i - 1 : i + 1]; if(to) openProfile(to); return; }
    if(a === 'tab'){ e.preventDefault(); tab = b.getAttribute('data-t'); if(window.innerWidth <= 900) col = 'c'; render(); var t = $('cm-body'); if(t) t.focus(); return; }
    if(a === 'filt'){ filt = b.getAttribute('data-v'); render(); return; }
    if(a === 'tog'){ var id = b.getAttribute('data-v'); open[id] = !open[id]; render(); return; }
    if(a === 'more'){ open.__all = true; render(); return; }
    if(a === 'msg'){ if(!c.user_id) return invite(); var tu = c.user_id; closeProfile(); if(o.openThread) o.openThread(tu); return; }
    if(a === 'invite') return invite();
    if(a === 'callnow'){ cmpDraft.call = cmpDraft.call || {}; tab = 'call'; setTimeout(render, 600); return; }   // the phone dials; the log-call form is waiting when they come back
    if(a === 'savenote') return saveNote();
    if(a === 'sendemail') return sendEmail();
    if(a === 'sendsms' || a === 'sendwa') return sendText(a === 'sendwa' ? 'whatsapp' : 'sms', ($('cm-body') || {}).value);
    if(a === 'logcall') return logCall();
    if(a === 'usedraft'){ var dr = drafts()[+b.getAttribute('data-i')]; if(!dr) return; tab = dr.kind; cmpDraft[tab] = { body: dr.body, subject: dr.subject || '' }; if(window.innerWidth <= 900) col = 'c'; render(); var tb = $('cm-body'); if(tb){ tb.focus(); tb.scrollIntoView({ block: 'center' }); } return; }
    if(a === 'senddraft'){ var d2 = drafts()[+b.getAttribute('data-i')]; if(d2) sendText('sms', d2.body, true); return; }
    if(a === 'lolawrite') return lolaWrite(b.getAttribute('data-k'), b);
    if(a === 'ask') return askLola(b);
    if(a === 'untag'){ var v = b.getAttribute('data-v'); save({ tags: (c.tags || []).filter(function(t){ return t !== v; }) }); return; }
    if(a === 'tadd'){ open.__tadd = !open.__tadd; render(); if(open.__tadd && $('t-title')) $('t-title').focus(); return; }
    if(a === 'tsave'){ var title = ($('t-title').value || '').trim(); if(!title){ $('t-title').focus(); return; }
      var dd = $('t-due').value, due = null; if(dd !== ''){ var dt = new Date(); dt.setDate(dt.getDate() + (+dd)); dt.setHours(17, 0, 0, 0); due = dt.toISOString(); }
      b.disabled = true; rpc('jag_contact_task', { p: { contact_id: uid, title: title, due_at: due, agent_code: $('t-who').value } }).then(function(){ open.__tadd = false; load(); toast('Task added'); }).catch(function(){ b.disabled = false; }); return; }
    if(a === 'tdel'){ rpc('jag_contact_task', { p: { id: +b.getAttribute('data-id'), op: 'delete' } }).then(function(){ load(); }); return; }
    if(a === 'cadd'){ open.__cadd = !open.__cadd; render(); return; }
    if(a === 'csave'){ var who = $('c-who').value; if(!who) return; b.disabled = true; rpc('jag_contact_collab', { p_user: uid, p_code: who, p_add: true }).then(function(){ open.__cadd = false; load(); toast(agentFirst(who) + ' added and notified'); }).catch(function(){ b.disabled = false; }); return; }
    if(a === 'crm'){ var cc = b.getAttribute('data-code'); if(!confirm('Remove ' + agentName(cc) + ' as a collaborator?')) return; rpc('jag_contact_collab', { p_user: uid, p_code: cc, p_add: false }).then(function(){ load(); }); return; }
    if(a === 'shw') return showings();
    if(a === 'offer') return offer();
    if(a === 'fopen'){ openFile(b.getAttribute('data-b'), b.getAttribute('data-p')); return; }
    if(a === 'fdel'){ if(!confirm('Remove ' + b.getAttribute('data-n') + ' from this contact?')) return; rpc('jag_contact_file_remove', { p_id: +b.getAttribute('data-id') }).then(function(j){ if(j && j.ok) toast('File removed'); loadFiles(uid); }); return; }
  }
  function onChange(e){
    var t = e.target;
    if(t.matches('[data-a="fup"]')){ upload(t.files); t.value = ''; return; }
    if(t.matches('[data-a="tdone"]')){ rpc('jag_contact_task', { p: { id: +t.getAttribute('data-id'), op: t.checked ? 'done' : 'reopen' } }).then(function(){ load(); }); return; }
    var f = t.getAttribute('data-f'); if(!f) return;
    var p = {}; p[f] = t.value; save(p, f === 'agent_code' && t.value ? 'Assigned to ' + agentFirst(t.value) + (t.value !== (me || {}).code ? ' · they were notified' : '') : f === 'stage' ? 'Stage saved · Follow Up Boss updated' : 'Saved');
  }
  document.addEventListener('keydown', function(e){
    if(!uid) return;
    if(e.key === 'Enter' && e.target && e.target.id === 'pf-tag'){ e.preventDefault(); var v = e.target.value.trim(); if(v) save({ tags: (P.contact.tags || []).concat([v]) }); }
    if(e.key === 'Enter' && e.target && e.target.id === 'pf-ask'){ e.preventDefault(); askLola(); }
    if(e.key === 'Escape' && !document.querySelector('.crm-ov,.pwov.on')) closeProfile();
  });
  function save(p, msg){
    return rpc('jag_contact_update', { p_user: uid, p: p }).then(function(j){
      if(!j || !j.ok){ toast(j && j.reason === 'not_yours' ? 'Only the assigned agent or a collaborator can change this contact' : 'Could not save'); return; }
      toast(j.handoff ? 'Stage saved · handed to ' + agentFirst(j.handoff) + (j.handoff !== (me || {}).code ? ' (notified)' : '') : (msg || 'Saved')); load(); if(o.reload) o.reload();
    }).catch(function(){ toast('Could not save'); });
  }
  function done(m){ cmpDraft[tab] = {}; toast(m); load(); }
  function saveNote(){
    var body = ($('cm-body').value || '').trim(); if(!body){ $('cm-body').focus(); return; }
    var nt = Object.keys((cmpDraft.note || {}).notify || {}).filter(function(k){ return cmpDraft.note.notify[k]; });
    busyBtn(true); rpc('jag_contact_note', { p_user: uid, p: { kind: 'note', body: body, notify: nt } }).then(function(j){ busyBtn(false); if(j && j.ok) done(nt.length ? 'Note saved · ' + nt.map(agentFirst).join(', ') + ' notified' : 'Note saved'); else cmsg('Could not save the note.', 'bad'); }).catch(function(){ busyBtn(false); cmsg('Could not save the note.', 'bad'); });
  }
  function sendEmail(){
    var sub = ($('cm-sub').value || '').trim(), body = ($('cm-body').value || '').trim();
    if(!sub){ $('cm-sub').focus(); return cmsg('Add a subject.', 'bad'); } if(!body){ $('cm-body').focus(); return cmsg('Write the message.', 'bad'); }
    busyBtn(true); cmsg('Sending…');
    hub('email', { contact_id: uid, subject: sub, body: body, lola: !!(cmpDraft.email || {}).lola }).then(function(j){ busyBtn(false); if(j && j.ok) done('Email sent to ' + j.to); else cmsg((j && j.error) || 'Email failed.', 'bad'); }).catch(function(){ busyBtn(false); cmsg('Email failed. Check your connection.', 'bad'); });
  }
  function sendText(via, body, fromDraft){
    body = String(body || '').trim(); var ph = digits(P.contact.phone);
    if(!body){ var t = $('cm-body'); if(t) t.focus(); return cmsg('Write the text first.', 'bad'); }
    if(via === 'whatsapp') window.open('https://wa.me/1' + ph + '?text=' + encodeURIComponent(body), '_blank', 'noopener');
    else topGo('sms:+1' + ph + '?&body=' + encodeURIComponent(body));
    rpc('jag_contact_note', { p_user: uid, p: { kind: 'text', body: body, meta: { via: via, lola: !!fromDraft } } }).then(function(){ cmpDraft.text = {}; setTimeout(function(){ toast('Saved to the history'); load(); }, 500); }).catch(function(){});
  }
  function logCall(){
    var d = cmpDraft.call || {}, body = ($('cm-body').value || '').trim();
    busyBtn(true); rpc('jag_contact_note', { p_user: uid, p: { kind: 'call', body: body, meta: { outcome: d.outcome || 'talked' } } }).then(function(j){ busyBtn(false); if(j && j.ok) done('Call logged'); else cmsg('Could not log the call.', 'bad'); }).catch(function(){ busyBtn(false); });
  }
  function busyBtn(on){ document.querySelectorAll('#pf-cmp .pbtn').forEach(function(x){ x.disabled = on; }); }

  /* ---------- Lola (jag-lola): never sees names, phones or emails ---------- */
  function lolaCtx(){
    var j = P.journey || {}, L = j.looking || {}, sc = P.score || {}, c = P.contact;
    var st = window.JagCRM && JagCRM.state ? JagCRM.state(cObj()) : {};
    return { answers: { stage: c.stage || '', journey: st, next_step: window.JagCRM ? JagCRM.next(cObj()).k : '', screened: !!j.screen, lane: j.screen ? j.screen.lane : '',
      screen_score: j.screen ? j.screen.score : null, loan: j.loan ? j.loan.stage : '', applied: !!j.app, homes_viewed: L.views || 0, homes_saved: L.saved || 0,
      top_zip: sc.top_zip || '', days_since_on_site: c.last_seen_at ? Math.round((Date.now() - new Date(c.last_seen_at)) / 864e5) : null,
      tours: (j.show || {}).tours || 0, offers: j.offer ? j.offer.n : 0, last_offer: j.offer ? j.offer.last : '', language: c.lang === 'en' ? 'English' : 'Spanish',
      tags: (c.tags || []).join(', '), background: '' } };
  }
  function lola(question){
    return JagShare.token().then(function(t){
      return fetch(BASE + '/functions/v1/jag-lola', { method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: question, lang: P.contact.lang === 'en' ? 'en' : 'es', step: 'agent hub client profile', context: lolaCtx() }) });
    }).then(function(r){ return r.json(); }).then(function(j){ if(!j || !j.answer) throw new Error(j && j.error || 'lola'); return j.answer; });
  }
  function lolaWrite(kind, btn){
    var c = P.contact, es = c.lang !== 'en', goal = window.JagCRM ? JagCRM.next(cObj()).t.replace(/<[^>]+>/g, '') : '';
    var q = 'Write a short, warm ' + (kind === 'email' ? 'email (first line "Subject: …", then the body)' : 'text message (under 300 characters)') + ' in ' + (es ? 'Spanish' : 'English') +
      ' from a Houston real estate agent to a home-buyer client. Goal: ' + goal + ' Use {nombre} where the client\'s first name goes and {agente} for the agent\'s name. No placeholders other than those two. Plain text.';
    btn.disabled = true; cmsg('Lola is writing…');
    lola(q).then(function(ans){
      btn.disabled = false; cmsg('');
      var f = first(c.name), a = (me && (me.first_name || first(me.name))) || '';
      ans = ans.replace(/\{nombre\}|\{name\}/gi, f).replace(/\{agente\}|\{agent\}/gi, a).trim();
      var d = cmpDraft[kind] = cmpDraft[kind] || {};
      if(kind === 'email'){ var m = ans.match(/^\s*(?:subject|asunto)\s*:\s*(.+)\n+/i); if(m){ d.subject = m[1].trim(); ans = ans.slice(m[0].length); } }
      d.body = ans.trim(); d.lola = true; fillComposer();
    }).catch(function(){ btn.disabled = false; cmsg('Lola is busy right now. Try a ready-to-send draft instead.', 'bad'); });
  }
  function askLola(btn){
    var i = $('pf-ask'), q = i ? i.value.trim() : ''; if(!q){ if(i) i.focus(); return; }
    if(btn) btn.disabled = true; lolaAns = '…';
    var box = document.querySelector('.lola .ans'); if(box) box.textContent = 'Lola is thinking…'; else render();
    lola(q + ' (About one client in the agent hub; context has their journey.)').then(function(ans){ lolaAns = ans; render(); }).catch(function(){ lolaAns = 'Lola is busy right now. Try again in a minute.'; render(); });
  }
  // showings and app messages need the client's app account
  function showings(){
    var pc = P.contact; if(!pc.user_id){ toast(first(pc.name) + ' needs the app for showings: send the invite first'); return invite(); }
    var c = o.findRow(uid) || { user_id: pc.user_id, name: pc.name, showing_agent_code: pc.showing_agent_code }; c.user_id = pc.user_id;
    if(o.handoff) o.handoff(c, function(){ load(); });
  }
  function invite(){ var c = P.contact; if(window.JagCRM) JagCRM.invite({ name: c.name || '', phone: c.phone || '', email: c.email || '', lang: c.lang || 'es' }); }
  function offer(){
    var hs = (P.favorites || []).map(function(f){ var s = f.snap || {}; return { mls: f.mls, addr: s.addr || '', price: f.last_price || s.price }; })
      .concat(((P.score || {}).homes || []).map(function(h){ return { mls: h.mls, addr: h.addr || '', price: h.price }; }));
    var seen = {}; hs = hs.filter(function(h){ if(!h.mls || seen[h.mls]) return false; seen[h.mls] = 1; return true; });
    if(window.JagLolaOffer) JagLolaOffer.open({ client: { name: P.contact.name, email: P.contact.email, phone: P.contact.phone, user_id: P.contact.user_id || null }, homes: hs });
  }

  window.JagProfile = {
    // opts: { rpc, me, isLead, listIds(), findRow(uid), handoff(row, cb), openThread(uid), reload(), onClose() }
    init: function(opts){ o = opts; me = opts.me; },
    open: openProfile, close: closeProfile, isOpen: function(){ return !!uid; }, current: function(){ return uid; },
    contact: function(id){ return P && P.contact && (P.contact.id === id || P.contact.user_id === id) ? P.contact : null; }
  };
})();
