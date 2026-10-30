/* ============================================================
   JAG CRM pieces for the Agent Hub (agent.html), phase 1.
   - "🔗 My invite link": the agent's own link (/join?a=<code>), same for everyone, no name needed (supabase-invite-link.sql)
   - "＋ Invite a client": make their profile (name, cell, email, language, note) and send their personal link
     (/join#token) by text from the agent's own phone, email (sent by JAG from the agent), WhatsApp, the phone's
     share sheet, or copy. Android Chrome can pick straight from the phone's contacts; on iPhone, Text opens Messages
     where the agent picks the contact.
   - Invited list: who hasn't joined yet, who opened the link; resend / copy / cancel.
   - 🔔 notifications: "María opened your invite", "María created her account" (Lola also texts the agent on join).
   - Journey on every contact: Account · Screened · Applied · Pre-approved · Homes · Showings · Offer,
     with the next step as one button (screen them, send the loan app, send homes, showings, offer).
   Data: supabase-crm-invites.sql (jag_invite_*, jag_notifs*, jag_client_journey). Email: jag-client-hub 'invite'.
   Needs jag-capture.js + jag-share.js. agent.html calls JagCRM.init({...}) once the agent is known.
   ============================================================ */
(function(){
  var C = window.JAG_CRM || {}, BASE = String(C.url || '').replace(/\/+$/, ''), KEY = C.anonKey;
  var SITE = 'https://jasonaguirregroup.company';
  var o = null, me = null, invites = [], notifs = [], unread = 0, overdue = 0, dueToday = 0, showAllInv = false, seenJoin = {}, booted = false;
  function $(id){ return document.getElementById(id); }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function digits(p){ return String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); }
  function fmtPhone(p){ var d = digits(p); return d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : (p || ''); }
  function ago(iso){
    if(!iso) return '';
    var m = (Date.now() - new Date(iso).getTime()) / 60000;
    if(m < 2) return 'just now'; if(m < 60) return Math.floor(m) + ' min ago'; if(m < 1440) return Math.floor(m / 60) + ' h ago';
    var d = Math.floor(m / 1440); return d === 1 ? 'yesterday' : d < 30 ? d + ' days ago' : day(iso);
  }
  function day(iso){ return iso ? new Date(String(iso).length === 10 ? iso + 'T12:00:00' : iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''; }
  function rpc(n, a){ return o.rpc(n, a); }
  function first(n){ return String(n || '').trim().split(/\s+/)[0] || ''; }
  var ua = navigator.userAgent || '', IOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document);
  var PICKER = !!(navigator.contacts && navigator.contacts.select && window.ContactsManager);

  /* ---------------- styles (one place; jag-theme.js darkens them too) ---------------- */
  var css = document.createElement('style');
  css.textContent = [
    '.crm-top{display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap}',
    '.crm-inv{border:0;border-radius:99px;background:var(--red);color:#fff;font-weight:800;font-size:15px;padding:13px 20px;min-height:48px;display:inline-flex;align-items:center;gap:8px}',
    '.crm-inv:hover{background:var(--red-d)}',
    '.crm-lnk{border:2px solid var(--ink);border-radius:99px;background:#fff;color:var(--ink);font-weight:800;font-size:15px;padding:11px 18px;min-height:48px;display:inline-flex;align-items:center;gap:8px}',
    '.crm-lnk:hover{background:#f6f5f3}',
    '@media(max-width:560px){.crm-inv,.crm-lnk{flex:1 1 100%;justify-content:center}}',
    '.crm-url{display:flex;align-items:center;gap:8px;background:#f6f5f3;border:1px solid #e6e3de;border-radius:14px;padding:12px 14px;font-weight:700;font-size:15px;word-break:break-all}',
    '.crm-url span{flex:1;min-width:0}',
    '.crm-stat{display:flex;gap:8px}.crm-stat div{flex:1;background:#f6f5f3;border-radius:14px;padding:10px 12px;text-align:center}.crm-stat b{display:block;font-size:22px;font-weight:800}.crm-stat small{color:var(--muted);font-size:12px;font-weight:700}',
    '.crm-or{display:flex;align-items:center;gap:10px;background:#f6f5f3;border-radius:14px;padding:10px 12px;font-size:13.5px}.crm-or span{flex:1}.crm-or button{border:0;background:var(--ink);color:#fff;border-radius:99px;font-weight:800;font-size:13px;padding:9px 13px;min-height:40px;white-space:nowrap}',
    '.bell{position:relative;display:inline-flex;align-items:center;gap:4px}',
    '.bell .tc{position:absolute;top:-6px;right:-6px;min-width:19px;height:19px;border-radius:99px;background:var(--red);color:#fff;font-size:11px;font-weight:800;display:flex;align-items:center;justify-content:center;padding:0 5px;margin:0}',
    '.bell .tc:empty{display:none}',
    /* journey stepper */
    '.jr{display:flex;flex-direction:column;gap:8px;background:#f6f5f3;border-radius:16px;padding:12px 12px 10px}',
    '.jr-steps{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));position:relative}',
    '.jr-s{display:flex;flex-direction:column;align-items:center;gap:5px;position:relative;min-width:0}',
    '.jr-s::before{content:"";position:absolute;top:10px;left:-50%;right:50%;height:3px;background:#dedbd6;z-index:0}',
    '.jr-s:first-child::before{display:none}',
    '.jr-s.done::before,.jr-s.now::before{background:var(--green)}',
    '.jr-d{width:23px;height:23px;border-radius:50%;background:#fff;border:3px solid #dedbd6;z-index:1;display:grid;place-items:center;color:#fff;font-size:12px;font-weight:900}',
    '.jr-s.done .jr-d{background:var(--green);border-color:var(--green)}',
    '.jr-s.now .jr-d{border-color:var(--red);background:#fff;box-shadow:0 0 0 4px var(--red-t)}',
    '.jr-s.part .jr-d{border-color:var(--green);background:#fff}',
    '.jr-l{font-size:10px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);text-align:center;line-height:1.15;overflow-wrap:anywhere}',
    '.jr-s.done .jr-l{color:var(--ink)}.jr-s.now .jr-l{color:var(--red-d)}',
    '.jr-next{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:13.5px}',
    '.jr-cap{display:none;font-size:10.5px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}.jr-cap b{color:var(--red-d)}',
    '@media(max-width:520px){.jr-l{display:none}.jr-cap{display:block}.jr-steps{margin:2px 0}}',
    '.jr-next span{flex:1 1 200px;min-width:0}.jr-next b{font-weight:800}',
    '.jr-go{border:0;border-radius:99px;background:var(--ink);color:#fff;font-weight:800;font-size:13.5px;padding:10px 15px;min-height:42px;text-decoration:none;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}',
    '.jr-go:hover{background:#000}',
    '.cl.flash{animation:crmflash 2.2s ease-out 1}',
    '@keyframes crmflash{0%,30%{box-shadow:0 0 0 4px var(--red)}100%{box-shadow:0 0 0 0 transparent}}',
    /* timeline in the profile */
    '.tl{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:0}',
    '.tl li{display:flex;gap:10px;align-items:flex-start;padding:6px 0;justify-content:flex-start!important}',
    '.tl i{flex:none;width:10px;height:10px;border-radius:50%;margin-top:6px;background:#dedbd6}',
    '.tl li.y i{background:var(--green)}',
    '.tl span{flex:1}.tl small{color:var(--muted)}',
    /* invited list */
    '.invs{background:#f6f5f3;border-radius:20px;padding:12px 14px;margin-bottom:12px}',
    '.invs h3{margin:0 0 6px;font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);display:flex;justify-content:space-between;gap:8px}',
    '.inv{display:flex;gap:10px;align-items:center;padding:9px 0;border-top:1px solid #e6e3de;flex-wrap:wrap}',
    '.inv:first-of-type{border-top:0}',
    '.inv .w{flex:1 1 180px;min-width:0}.inv .w b{display:block;font-size:15px;overflow-wrap:anywhere}.inv .w small{color:var(--muted);font-size:12.5px}',
    '.inv .st{font-size:10.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;border-radius:99px;padding:4px 9px;background:#fff;color:var(--muted);white-space:nowrap}',
    '.inv .st.op{background:var(--amber-t);color:var(--amber)}',
    '.inv .a{display:flex;gap:4px}.inv .a button{border:0;background:none;color:var(--red);font-weight:700;font-size:13px;padding:6px 8px;min-height:36px}',
    '.invs .more{border:0;background:none;color:var(--red);font-weight:700;font-size:13px;padding:6px 0}',
    /* sheet */
    '.crm-ov{position:fixed;inset:0;background:rgba(15,14,20,.55);display:flex;align-items:flex-end;justify-content:center;z-index:9800;padding:0}',
    '@media(min-width:640px){.crm-ov{align-items:center;padding:16px}}',
    '.crm-sh{background:var(--paper);width:100%;max-width:480px;border-radius:22px 22px 0 0;padding:20px 18px calc(18px + env(safe-area-inset-bottom,0px));max-height:94vh;overflow:auto;display:flex;flex-direction:column;gap:12px}',
    '@media(min-width:640px){.crm-sh{border-radius:22px}}',
    '.crm-sh h2{margin:0;font-size:21px;font-weight:800;letter-spacing:-.02em}',
    '.crm-sh p{margin:0;color:var(--muted);font-size:14px}',
    '.crm-sh .x{position:absolute}',
    '.crm-hd{display:flex;align-items:flex-start;gap:10px}.crm-hd div{flex:1}',
    '.crm-close{border:0;background:#f6f5f3;width:38px;height:38px;border-radius:50%;font-size:20px;line-height:1;color:var(--ink);flex:none}',
    '.crm-sh .fld textarea{border:1px solid #d9d6d1;border-radius:14px;background:#f6f5f3;padding:10px 12px;font:inherit;font-size:15px;min-height:64px;resize:vertical;width:100%}',
    '.crm-sh .fld input,.crm-sh .fld textarea{font-size:16px}',
    '.crm-two{display:grid;grid-template-columns:1fr 1fr;gap:10px}@media(max-width:420px){.crm-two{grid-template-columns:1fr}}',
    '.crm-pick{border:2px dashed var(--ink);background:#fff;border-radius:14px;padding:12px;font-weight:800;font-size:15px;display:flex;align-items:center;justify-content:center;gap:8px;min-height:50px}',
    '.crm-send{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
    '.crm-send button{border:2px solid var(--red);background:#fff;color:var(--red);border-radius:14px;padding:12px 10px;font-weight:800;font-size:14.5px;min-height:52px;display:flex;align-items:center;justify-content:center;gap:7px}',
    '.crm-send button.p{background:var(--red);color:#fff}',
    '.crm-send button.w{grid-column:1/-1}',
    '.crm-send button:disabled{opacity:.5}',
    '.crm-lbl{font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin-top:4px}',
    '.crm-msg{font-size:13.5px;border-radius:12px;padding:10px 12px;background:var(--amber-t);color:var(--amber);font-weight:600}',
    '.crm-msg.ok{background:var(--green-t);color:var(--green)}.crm-msg.bad{background:var(--red-t);color:var(--red-d)}',
    '.crm-hint{font-size:12.5px!important}',
    '.crm-done{text-align:center;padding:10px 0}.crm-done .big{font-size:44px;line-height:1}',
    /* notifications */
    '.nf-pan{position:fixed;z-index:9750;right:12px;top:64px;width:min(380px,calc(100vw - 24px));max-height:70vh;overflow:auto;background:var(--paper);border:1px solid var(--line);border-radius:18px;box-shadow:0 18px 50px rgba(23,22,28,.18);padding:8px}',
    '.nf-pan h3{margin:6px 10px 8px;font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}',
    '.nf{display:flex;gap:10px;width:100%;text-align:left;border:0;background:none;border-radius:12px;padding:10px;align-items:flex-start}',
    '.nf:hover{background:#f6f5f3}.nf i{flex:none;width:9px;height:9px;border-radius:50%;margin-top:7px;background:transparent}',
    '.nf.un i{background:var(--red)}.nf.un b{font-weight:800}',
    '.nf span{flex:1;min-width:0}.nf b{display:block;font-weight:600;font-size:14.5px}.nf small{display:block;color:var(--muted);font-size:12.5px}',
    '.nf-empty{padding:18px 10px;color:var(--muted);font-size:14px;text-align:center}',
    '.crm-toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);background:var(--ink);color:#fff;font-weight:700;font-size:14px;border-radius:14px;padding:12px 16px;z-index:9900;max-width:min(92vw,440px);box-shadow:0 10px 30px rgba(0,0,0,.2)}'
  ].join('\n');
  document.head.appendChild(css);

  var toastT;
  function toast(m){ var t = $('crm-toast'); if(!t){ t = document.createElement('div'); t.id = 'crm-toast'; t.className = 'crm-toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(function(){ t.hidden = true; }, 4200); }

  /* ---------------- journey ---------------- */
  var STEPS = [['acct', 'Account'], ['scr', 'Screened'], ['app', 'Applied'], ['ok', 'Approved'], ['homes', 'Homes'], ['show', 'Showings'], ['offer', 'Offer']];
  var LOAN = { received: 'App received', review: 'In review', docs: 'Needs documents', credit: 'Working on credit', paused: 'Paused', done: 'Pre-approved' };
  var LANE = { ready: 'Ready', fha: 'FHA', itin: 'ITIN', prep: 'Prep', credit: 'Credit path', cash: 'Cash' };
  var FSTAGE = { 'Applied': 1, 'Loan Approved': 2, 'Showing homes': 3, 'Submitting offers': 4, 'Under contract': 5, 'Pending': 5, 'Closed': 5, 'Past Client': 5 };
  function state(c){
    var j = c.journey || {}, L = j.looking || {}, s = j.show || {}, sent = (j.sent || {}).n || 0, lists = (j.lists || {}).n || 0;
    var loan = j.loan && j.loan.stage, pr = (c.priority || {}).proof || j.proof;
    var st = {
      acct: c.user_id || j.joined ? 'done' : '',
      scr: j.screen ? 'done' : '',
      app: j.app || loan ? 'done' : '',
      ok: pr || loan === 'done' ? 'done' : (loan && loan !== 'paused' ? 'part' : ''),
      homes: sent || lists ? 'done' : ((L.views || 0) + (L.saved || 0) > 0 ? 'part' : ''),
      show: s.done ? 'done' : (s.tours || s.req ? 'part' : ''),
      offer: j.offer && j.offer.last === 'accepted' ? 'done' : (j.offer ? 'part' : '')
    };
    // a pre-approval or an offer means the earlier money steps happened, even if we never logged them here
    if(st.ok === 'done' && !st.app) st.app = 'done';
    if(j.offer && st.ok !== 'done' && pr) st.ok = 'done';
    // the Follow Up Boss stage counts too (most of the team still moves people there)
    var fs = j.fub_stage || c.stage || '', at = FSTAGE[fs] || 0;
    if(at >= 1) st.app = 'done';
    if(at >= 2) st.ok = 'done';
    if(at === 3 && !st.show) st.show = 'part';
    if(at >= 4){ st.homes = st.homes || 'done'; st.show = 'done'; if(st.offer !== 'done') st.offer = 'part'; }
    if(at >= 5){ st.homes = 'done'; st.offer = 'done'; }
    return st;
  }
  function nextStep(c){
    var j = c.journey || {}, st = state(c), ph = digits(c.phone), nm = first(c.name) || 'them';
    var who = encodeURIComponent(JSON.stringify({ name: c.name || '', phone: c.phone || '', email: c.email || '' }));
    var key = c.id || c.user_id, app = !!c.user_id;
    var inv = app ? '' : '<button type="button" class="jr-go" data-jx="inv" data-u="' + esc(key) + '">📱 Invite to app</button>';
    var forCl = encodeURIComponent(JSON.stringify({ uid: c.user_id || null, name: c.name || c.email || '', phone: c.phone || '', email: c.email || '', lang: c.lang || 'es' }));
    if(!st.scr && !st.app && o.canScreen) return { k: 'scr', t: '<b>Next: screen ' + esc(nm) + '.</b> 5-minute call to see what they qualify for.', a: '<a class="jr-go" href="screener.html#call=' + who + '">📞 Screen now</a>' };
    if(!st.app) return { k: 'app', t: '<b>Next: loan application.</b> Send ' + esc(nm) + ' the JAG Home Loans app.', a: '<button type="button" class="jr-go" data-jx="app" data-u="' + esc(key) + '">📝 Send app link</button>' };
    if(st.ok !== 'done') return { k: 'ok', t: '<b>Loan: ' + esc(LOAN[j.loan && j.loan.stage] || 'Waiting on the lender') + '.</b> Keep them shopping while the pre-approval comes in.', a: ph ? '<a class="jr-go" href="sms:+1' + ph + '">💬 Check in</a>' : '' };
    if(st.homes !== 'done') return { k: 'homes', t: '<b>Next: send homes.</b> Build ' + esc(nm) + '\'s list in Matrix.', a: '<a class="jr-go" href="matrix.html#client=' + forCl + '">🏠 Send homes</a>' + inv };
    if(!st.show) return { k: 'show', t: '<b>Next: showings.</b> ' + ((j.looking || {}).saved ? esc(nm) + ' saved ' + j.looking.saved + ' home' + (j.looking.saved === 1 ? '' : 's') + '.' : 'Ask which homes they want to see.'),
      a: !app ? inv : o.isLead ? '<button type="button" class="jr-go" data-shw="' + esc(key) + '">👟 Set up showings</button>' : (ph ? '<a class="jr-go" href="sms:+1' + ph + '">💬 Ask for showings</a>' : '') };
    if(!j.offer) return { k: 'offer', t: '<b>Next: write the offer.</b>' + (j.show && j.show.next ? ' Tour on ' + day(j.show.next) + '.' : ''), a: '<button type="button" class="jr-go" data-lofr="' + esc(key) + '">📝 Write offer</button>' };
    if(st.offer !== 'done') return { k: 'offer', t: '<b>Offer ' + esc(j.offer.last || 'sent') + '.</b> ' + j.offer.n + ' offer' + (j.offer.n === 1 ? '' : 's') + ' so far.', a: '' };
    return { k: 'done', t: '<b>🎉 Under contract.</b> Keep them posted through closing.', a: '' };
  }
  function journey(c){
    var st = state(c), nx = nextStep(c), nowSet = false;
    var steps = STEPS.map(function(s){
      var v = st[s[0]];
      if(v !== 'done' && !nowSet && s[0] === nx.k){ v = 'now'; nowSet = true; }
      return '<div class="jr-s ' + (v || '') + '"><span class="jr-d" aria-hidden="true">' + (st[s[0]] === 'done' ? '✓' : '') + '</span><span class="jr-l">' + s[1] + '</span></div>';
    }).join('');
    var label = STEPS.map(function(s){ return s[1] + ': ' + (st[s[0]] === 'done' ? 'done' : st[s[0]] === 'part' ? 'started' : 'not yet'); }).join(', ');
    var idx = 0; STEPS.forEach(function(sx, i){ if(sx[0] === nx.k) idx = i; });
    var cap = nx.k === 'done' ? '<b>All 7 steps done</b>' : 'Step ' + (idx + 1) + ' of 7 · <b>' + STEPS[idx][1] + '</b>';
    return '<div class="jr"><div class="jr-cap" aria-hidden="true">' + cap + '</div><div class="jr-steps" role="img" aria-label="' + esc(label) + '">' + steps + '</div>' +
      '<div class="jr-next"><span>' + nx.t + '</span>' + (nx.a || '') + '</div></div>';
  }
  // the profile: every step with its date
  function timeline(c){
    var j = c.journey || {}, L = j.looking || {}, s = j.show || {};
    var rows = [];
    function r(y, txt, when){ rows.push('<li class="' + (y ? 'y' : '') + '"><i></i><span>' + txt + (when ? ' <small>· ' + esc(when) + '</small>' : '') + '</span></li>'); }
    if(j.invite) r(true, 'Invited by ' + esc(cap(j.invite.by)), day(j.invite.at));
    r(!!(j.joined || c.user_id), j.joined || c.user_id ? 'Created their app account' : 'No app account yet', j.joined ? day(j.joined) : '');
    r(!!j.screen, j.screen ? 'Screened' + (j.screen.by ? ' by ' + esc(j.screen.by) : '') + (j.screen.lane ? ' · ' + esc(LANE[j.screen.lane] || j.screen.lane) : '') + (j.screen.score != null ? ' · ' + j.screen.score + '%' : '') + (j.screen.hot ? ' 🔥' : '') : 'Not screened yet', j.screen ? day(j.screen.at) : '');
    r(!!(j.app || j.loan), j.app ? 'Loan application sent' : j.loan ? 'Loan file started by the team' : 'No loan application yet', j.app ? day(j.app.at) : '');
    if(j.loan) r(j.loan.stage === 'done', 'Loan: ' + esc(LOAN[j.loan.stage] || j.loan.stage), j.loan.set_at ? day(j.loan.set_at) : '');
    if(j.proof || (c.priority || {}).proof) r(true, 'Pre-approval / proof of funds verified', '');
    r((L.views || 0) + (L.saved || 0) > 0, 'Looking: ' + (L.views || 0) + ' homes viewed · ' + (L.saved || 0) + ' saved · ' + (L.searches || 0) + ' searches', L.last ? 'last ' + ago(L.last) : '');
    var sent = (j.sent || {}).n || 0, lists = (j.lists || {}).n || 0;
    r(sent + lists > 0, sent + lists ? 'Homes sent: ' + (lists ? lists + ' list' + (lists === 1 ? '' : 's') : '') + (lists && sent ? ' · ' : '') + (sent ? sent + ' email' + (sent === 1 ? '' : 's') + '/text' + (sent === 1 ? '' : 's') : '') : 'No homes sent yet',
      (j.sent || {}).last || (j.lists || {}).last ? 'last ' + ago((j.sent || {}).last || (j.lists || {}).last) : '');
    r(!!(s.tours || s.req), s.tours || s.req ? 'Showings: ' + (s.tours || 0) + ' tour' + (s.tours === 1 ? '' : 's') + (s.done ? ' (' + s.done + ' done)' : '') + (s.req ? ' · ' + s.req + ' request' + (s.req === 1 ? '' : 's') : '') : 'No showings yet', s.next ? 'next ' + day(s.next) : '');
    r(!!j.offer, j.offer ? j.offer.n + ' offer' + (j.offer.n === 1 ? '' : 's') + ' · last: ' + esc(j.offer.last) : 'No offers yet', j.offer ? day(j.offer.at) : '');
    return '<h4>Journey</h4><ul class="tl">' + rows.join('') + '</ul>';
  }
  function cap(s){ s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }

  /* ---------------- invite sheet ---------------- */
  var cur = null;   // { id, url, sig }
  function msgText(name, lang, url){
    var a = me || {}, af = a.first_name || first(a.name) || 'Jason', f = first(name);
    return lang === 'en'
      ? 'Hi' + (f ? ' ' + f : '') + '! It\'s ' + af + ' with Jason Aguirre Group (eXp Realty). I\'m inviting you to our app to search homes, save your favorites, see the ones I send you and request showings. Create your free account here: ' + url
      : '¡Hola' + (f ? ' ' + f : '') + '! Soy ' + af + ' de Jason Aguirre Group (eXp Realty). Te invito a nuestra app para buscar casas, guardar tus favoritas, ver las que te mando y pedir visitas. Crea tu cuenta gratis aquí: ' + url;
  }
  function closeSheet(){ var ov = $('crm-ov'); if(ov) ov.remove(); document.removeEventListener('keydown', escClose); }
  function escClose(e){ if(e.key === 'Escape') closeSheet(); }
  function openInvite(pre){
    pre = pre || {}; cur = null; pending = null; closeSheet();
    if(pre.id) cur = { id: pre.id, url: SITE + '/join#' + pre.token, sig: '' };
    var ov = document.createElement('div'); ov.className = 'crm-ov'; ov.id = 'crm-ov';
    ov.innerHTML = '<div class="crm-sh" role="dialog" aria-modal="true" aria-labelledby="crm-h">' +
      '<div class="crm-hd"><div><h2 id="crm-h">Invite a client</h2><p>Make their profile and send their personal link. You\'ll get a notification when they open it and when they join.</p></div><button type="button" class="crm-close" id="crm-x" aria-label="Close">×</button></div>' +
      '<div class="crm-or"><span><b>No name handy?</b> Send your own invite link instead. Same link for everyone.</span><button type="button" id="crm-golink">🔗 My link</button></div>' +
      (PICKER ? '<button type="button" class="crm-pick" id="crm-pick">📇 Pick from my phone contacts</button>' : '') +
      '<div class="fld"><label for="crm-n">Client name</label><input id="crm-n" autocomplete="off" value="' + esc(pre.name || '') + '" placeholder="María López"></div>' +
      '<div class="crm-two"><div class="fld"><label for="crm-p">Cell phone</label><input id="crm-p" type="tel" inputmode="tel" autocomplete="off" value="' + esc(pre.phone ? fmtPhone(pre.phone) : '') + '" placeholder="(281) 555-0142"></div>' +
      '<div class="fld"><label for="crm-e">Email</label><input id="crm-e" type="email" inputmode="email" autocomplete="off" value="' + esc(pre.email || '') + '" placeholder="maria@email.com"></div></div>' +
      '<div class="fld"><label>Their language</label><div class="seg" role="radiogroup" aria-label="Language" id="crm-l"><button type="button" role="radio" data-v="es" aria-checked="' + (pre.lang !== 'en') + '">Español</button><button type="button" role="radio" data-v="en" aria-checked="' + (pre.lang === 'en') + '">English</button></div></div>' +
      '<div class="fld"><label for="crm-note">Personal note (goes in the email, optional)</label><textarea id="crm-note" placeholder="Fue un gusto hablar contigo hoy…">' + esc(pre.note || '') + '</textarea></div>' +
      '<div id="crm-m"></div>' +
      '<div class="crm-lbl">Send it</div>' +
      '<div class="crm-send">' +
        '<button type="button" class="p" data-ch="sms">💬 Text from my phone</button>' +
        '<button type="button" class="p" data-ch="email">✉️ Email it</button>' +
        '<button type="button" data-ch="whatsapp">🟢 WhatsApp</button>' +
        (navigator.share ? '<button type="button" data-ch="share">📤 Share…</button>' : '<button type="button" data-ch="copy">🔗 Copy link</button>') +
        (navigator.share ? '<button type="button" class="w" data-ch="copy">🔗 Copy message + link</button>' : '') +
      '</div>' +
      '<p class="crm-hint">' + (IOS ? 'On iPhone: leave the cell empty and tap Text, then pick the contact in Messages.' : PICKER ? 'Tip: Pick from contacts fills everything in.' : 'Text opens your phone\'s messages with the invite ready to send.') + '</p>' +
      '</div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function(e){ if(e.target === ov) closeSheet(); });
    document.addEventListener('keydown', escClose);
    $('crm-x').onclick = closeSheet;
    $('crm-golink').onclick = openLink;
    setTimeout(function(){ (pre.name ? $('crm-p') : $('crm-n')).focus(); }, 60);
    $('crm-l').addEventListener('click', function(e){ var b = e.target.closest('[data-v]'); if(!b) return; this.querySelectorAll('[data-v]').forEach(function(x){ x.setAttribute('aria-checked', String(x === b)); }); });
    if($('crm-pick')) $('crm-pick').onclick = function(){
      navigator.contacts.select(['name', 'tel', 'email'], { multiple: false }).then(function(list){
        var c = list && list[0]; if(!c) return;
        if(c.name && c.name[0]) $('crm-n').value = c.name[0];
        if(c.tel && c.tel[0]) $('crm-p').value = fmtPhone(c.tel[0]);
        if(c.email && c.email[0]) $('crm-e').value = c.email[0];
        preMake();
      }).catch(function(){});
    };
    ov.querySelectorAll('[data-ch]').forEach(function(b){ b.onclick = function(){ send(b.getAttribute('data-ch'), b); }; });
    ['crm-n', 'crm-p', 'crm-e', 'crm-note'].forEach(function(id){ $(id).addEventListener('input', preMake); });
    $('crm-l').addEventListener('click', preMake);
    preMake();
  }
  function form(){
    var l = document.querySelector('#crm-l [aria-checked="true"]');
    return { name: $('crm-n').value.trim(), phone: $('crm-p').value.trim(), email: $('crm-e').value.trim().toLowerCase(), lang: l ? l.getAttribute('data-v') : 'es', note: $('crm-note').value.trim() };
  }
  function note(m, kind){ var el = $('crm-m'); if(el) el.innerHTML = m ? '<div class="crm-msg ' + (kind || '') + '">' + m + '</div>' : ''; }
  // one invite per person. It's made in the background as soon as there's a name + cell or email (and updated as the
  // agent edits), so a tap on Text / WhatsApp opens the phone's app right away (phones block it after a wait).
  var pending = null, preT = null;
  function sigOf(p){ return JSON.stringify(p); }
  function ensure(p){
    var sig = sigOf(p);
    if(cur && cur.sig === sig) return Promise.resolve(cur);
    if(pending && pending.sig === sig) return pending.p;
    var args = Object.assign({}, p); if(cur && cur.id) args.id = cur.id;
    var pr = rpc('jag_invite_create', { p: args }).then(function(j){
      if(!j || !j.ok) throw new Error(j && j.reason === 'email' ? 'Check the email address.' : j && j.reason === 'empty' ? 'Add their name and a cell or email.' : 'Could not make the invite.');
      cur = { id: j.id, url: j.url, sig: sig, existing: j.existing };
      if(j.existing) note('Heads up: ' + esc(j.existing.name || p.name || 'they') + ' already has an account' + (j.existing.agent_code && j.existing.agent_code !== (me || {}).code ? ' with ' + esc(cap(j.existing.agent_code)) : '') + '. The link still works; they\'ll just sign in.');
      else note('');
      return cur;
    });
    pending = { sig: sig, p: pr };
    pr.then(function(){ if(pending && pending.sig === sig) pending = null; }, function(){ if(pending && pending.sig === sig) pending = null; });
    return pr;
  }
  function preMake(){
    clearTimeout(preT);
    preT = setTimeout(function(){
      if(!$('crm-n')) return;
      var p = form(), okPhone = digits(p.phone).length === 10, okEmail = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(p.email);
      if((p.phone && !okPhone) || (p.email && !okEmail)) return;   // still typing
      if(p.name && (okPhone || okEmail)) ensure(p).catch(function(){});
    }, 700);
  }
  function send(ch, btn){
    var p = form();
    if(!p.name && !p.phone && !p.email){ $('crm-n').focus(); return note('Add their name and a cell or email.', 'bad'); }
    if(ch === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(p.email)){ $('crm-e').focus(); return note('Add their email to send it by email.', 'bad'); }
    if(cur && cur.sig === sigOf(p)) return act(ch, btn, p, cur, true);   // ready: open the app inside this tap
    btn.disabled = true;
    ensure(p).then(function(x){ btn.disabled = false; act(ch, btn, p, x, false); })
      .catch(function(e){ btn.disabled = false; note(esc(e && e.message || 'Something went wrong.'), 'bad'); });
  }
  function act(ch, btn, p, x, inTap){
    var text = msgText(p.name, p.lang, x.url), ph = digits(p.phone);
    if(ch === 'email'){
      btn.disabled = true;
      JagShare.token().then(function(t){
        return fetch(BASE + '/functions/v1/jag-client-hub', { method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'invite', invite_id: x.id }) });
      }).then(function(r){ return r.json(); }).then(function(j){
        if(!j || !j.ok) throw new Error(j && j.error || 'Email failed.');
        done('email', p);
      }).catch(function(e){ btn.disabled = false; note(esc(e && e.message || 'Email failed.'), 'bad'); });
      return;
    }
    var sms = 'sms:' + (ph ? '+1' + ph : '') + '?&body=' + encodeURIComponent(text), wa = 'https://wa.me/' + (ph ? '1' + ph : '') + '?text=' + encodeURIComponent(text);
    if(!inTap && (ch === 'sms' || ch === 'whatsapp' || ch === 'share')){
      // the invite just got made: one more tap opens the app (phones only open apps straight from a tap)
      note('Invite ready. <a href="' + esc(ch === 'whatsapp' ? wa : sms) + '"' + (ch === 'whatsapp' ? ' target="_blank" rel="noopener"' : ' target="_top"') + ' style="font-weight:800;color:inherit">Tap here to open ' + (ch === 'whatsapp' ? 'WhatsApp' : ch === 'share' ? 'Messages' : 'Messages') + ' →</a>', 'ok');
      var a = document.querySelector('#crm-m a'); if(a) a.addEventListener('click', function(){ logSent(x.id, ch === 'share' ? 'sms' : ch); setTimeout(function(){ done(ch === 'share' ? 'sms' : ch, p); }, 400); });
      return;
    }
    if(ch === 'sms'){ topGo(sms); logSent(x.id, 'sms'); setTimeout(function(){ done('sms', p); }, 400); }
    else if(ch === 'whatsapp'){ window.open(wa, '_blank', 'noopener'); logSent(x.id, 'whatsapp'); done('whatsapp', p); }
    else if(ch === 'share'){ navigator.share({ title: 'JAG app invite', text: text }).then(function(){ logSent(x.id, 'share'); done('share', p); }).catch(function(){}); }
    else if(ch === 'copy'){ copy(text).then(function(){ logSent(x.id, 'copy'); toast('Invite copied. Paste it in any chat.'); }); }
  }
  function logSent(id, ch){ rpc('jag_invite_sent', { p_id: id, p_channel: ch }).catch(function(){}); }
  function topGo(u){ try{ window.top.location.href = u; }catch(e){ location.href = u; } }
  function copy(text){
    if(navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).catch(function(){ return fallbackCopy(text); });
    return Promise.resolve(fallbackCopy(text));
  }
  function fallbackCopy(text){ var t = document.createElement('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select(); try{ document.execCommand('copy'); }catch(e){} t.remove(); }
  var CHN = { sms: 'by text', email: 'by email', whatsapp: 'on WhatsApp', share: '' };
  function done(ch, p){
    var sh = document.querySelector('#crm-ov .crm-sh'); if(!sh) return;
    var f = first(p.name) || 'they';
    sh.innerHTML = '<div class="crm-done"><div class="big">✅</div><h2 style="margin:10px 0 6px">Invite ' + (ch === 'sms' || ch === 'whatsapp' ? 'ready ' + CHN[ch] : 'sent ' + (CHN[ch] || '')) + '</h2>' +
      '<p>' + (ch === 'sms' || ch === 'whatsapp' ? 'Hit send in your messages app. ' : '') + 'We\'ll notify you here when ' + esc(f) + ' opens it and when ' + (f === 'they' ? 'they join' : 'they create their account') + '. They\'ll show up in your Contacts.</p></div>' +
      '<div class="crm-send"><button type="button" class="p" id="crm-again">＋ Invite another</button><button type="button" id="crm-ok">Done</button></div>';
    $('crm-again').onclick = function(){ openInvite(); };
    $('crm-ok').onclick = closeSheet;
    loadInvites();
  }

  /* ---------------- my invite link (same link for everyone: /join?a=<code>) ---------------- */
  function myUrl(){ var c = (me && me.code && me.code !== 'pending') ? me.code : ''; return c ? SITE + '/join?a=' + encodeURIComponent(c) : ''; }
  function linkText(lang, url){
    var a = me || {}, af = a.first_name || first(a.name) || 'Jason';
    return lang === 'en'
      ? 'Hi! It\'s ' + af + ' with Jason Aguirre Group (eXp Realty). I\'m inviting you to our app to search homes, save your favorites, see the ones I send you and request showings. Create your free account here: ' + url
      : '¡Hola! Soy ' + af + ' de Jason Aguirre Group (eXp Realty). Te invito a nuestra app para buscar casas, guardar tus favoritas, ver las que te mando y pedir visitas. Crea tu cuenta gratis aquí: ' + url;
  }
  function openLink(){
    var url = myUrl(); closeSheet();
    if(!url){ toast('Your agent profile isn\'t set up yet. Ask Jason.'); return; }
    var ov = document.createElement('div'); ov.className = 'crm-ov'; ov.id = 'crm-ov';
    ov.innerHTML = '<div class="crm-sh" role="dialog" aria-modal="true" aria-labelledby="crm-h">' +
      '<div class="crm-hd"><div><h2 id="crm-h">My invite link</h2><p>One link, always the same. Send it to as many people as you want, post it in a group chat, or paste it while you\'re texting someone. They fill in their own info, and everyone who joins becomes your client.</p></div><button type="button" class="crm-close" id="crm-x" aria-label="Close">×</button></div>' +
      '<div class="crm-url"><span id="crm-u">' + esc(url) + '</span></div>' +
      '<div class="crm-send"><button type="button" class="p w" id="crm-cl">🔗 Copy link</button></div>' +
      '<div class="crm-lbl">Or send it with a message</div>' +
      '<div class="fld"><div class="seg" role="radiogroup" aria-label="Message language" id="crm-ll"><button type="button" role="radio" data-v="es" aria-checked="true">Español</button><button type="button" role="radio" data-v="en" aria-checked="false">English</button></div></div>' +
      '<div class="crm-send">' +
        '<button type="button" class="p" data-lk="sms">💬 Text</button>' +
        '<button type="button" class="p" data-lk="whatsapp">🟢 WhatsApp</button>' +
        (navigator.share ? '<button type="button" data-lk="share">📤 Share…</button><button type="button" data-lk="copy">📋 Copy message</button>' : '<button type="button" class="w" data-lk="copy">📋 Copy message + link</button>') +
      '</div>' +
      '<div class="crm-stat" id="crm-ls" hidden></div>' +
      '<p class="crm-hint">If someone is already another agent\'s client, they stay with that agent. You\'ll get a 🔔 notification and a text each time someone joins from your link.</p>' +
      '</div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function(e){ if(e.target === ov) closeSheet(); });
    document.addEventListener('keydown', escClose);
    $('crm-x').onclick = closeSheet;
    $('crm-cl').onclick = function(){ copy(url).then(function(){ toast('Link copied. Paste it anywhere.'); }); };
    $('crm-ll').addEventListener('click', function(e){ var b = e.target.closest('[data-v]'); if(!b) return; this.querySelectorAll('[data-v]').forEach(function(x){ x.setAttribute('aria-checked', String(x === b)); }); });
    function lng(){ var l = document.querySelector('#crm-ll [aria-checked="true"]'); return l ? l.getAttribute('data-v') : 'es'; }
    ov.querySelectorAll('[data-lk]').forEach(function(b){ b.onclick = function(){
      var ch = b.getAttribute('data-lk'), text = linkText(lng(), url);
      if(ch === 'sms') topGo('sms:?&body=' + encodeURIComponent(text));
      else if(ch === 'whatsapp') window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
      else if(ch === 'share') navigator.share({ title: 'JAG app invite', text: text }).catch(function(){});
      else copy(text).then(function(){ toast('Message copied. Paste it in any chat.'); });
    }; });
    rpc('jag_my_invite_link').then(function(j){
      var el = $('crm-ls'); if(!el || !j || !j.ok) return;
      el.innerHTML = '<div><b>' + (j.opens || 0) + '</b><small>Opened</small></div><div><b>' + (j.joins || 0) + '</b><small>Joined</small></div>';
      el.hidden = false;
    }).catch(function(){});
  }

  /* ---------------- invited list ---------------- */
  function loadInvites(){
    return rpc('jag_invite_list').then(function(j){ invites = j && j.ok ? j.invites || [] : []; paintInvites(); }).catch(function(){});
  }
  function paintInvites(){
    var box = $('crm-invs'); if(!box) return;
    var open = invites.filter(function(i){ return i.status !== 'joined'; });
    if(!open.length){ box.hidden = true; box.innerHTML = ''; return; }
    var list = showAllInv ? open : open.slice(0, 4);
    box.hidden = false;
    box.innerHTML = '<h3><span>Invited · not joined yet (' + open.length + ')</span></h3>' + list.map(function(i){
      var st = i.status === 'opened' ? '<span class="st op">👀 Opened ' + esc(ago(i.last_open_at)) + '</span>' : '<span class="st">' + (i.sent_at ? 'Sent ' + esc(ago(i.sent_at)) : 'Not sent yet') + '</span>';
      return '<div class="inv"><div class="w"><b>' + esc(i.name || i.email || fmtPhone(i.phone)) + '</b><small>' + esc([fmtPhone(i.phone), i.email].filter(Boolean).join(' · ')) +
        (o.seeAll && i.agent_code !== (me || {}).code ? ' · by ' + esc(i.agent_first || i.agent_code) : '') + '</small></div>' + st +
        '<div class="a"><button type="button" data-ir="' + esc(i.id) + '">Resend</button><button type="button" data-ic="' + esc(i.id) + '">Copy</button><button type="button" data-ix="' + esc(i.id) + '" aria-label="Cancel invite for ' + esc(i.name || '') + '">✕</button></div></div>';
    }).join('') + (open.length > 4 ? '<button type="button" class="more" id="crm-more">' + (showAllInv ? 'Show fewer' : 'Show all ' + open.length) + '</button>' : '');
    if($('crm-more')) $('crm-more').onclick = function(){ showAllInv = !showAllInv; paintInvites(); };
  }
  function invClick(e){
    var b = e.target.closest('[data-ir],[data-ic],[data-ix]'); if(!b) return;
    var id = b.getAttribute('data-ir') || b.getAttribute('data-ic') || b.getAttribute('data-ix');
    var i = invites.filter(function(x){ return x.id === id; })[0]; if(!i) return;
    if(b.hasAttribute('data-ir')) openInvite(i);
    else if(b.hasAttribute('data-ic')) copy(msgText(i.name, i.lang, SITE + '/join#' + i.token)).then(function(){ logSent(i.id, 'copy'); toast('Invite copied.'); });
    else if(confirm('Cancel the invite for ' + (i.name || 'this client') + '? Their link stops working.')) rpc('jag_invite_cancel', { p_id: id }).then(loadInvites).catch(function(){});
  }

  /* ---------------- notifications ---------------- */
  function loadNotifs(){
    return rpc('jag_notifs', { p_limit: 30 }).then(function(j){
      if(!j || !j.ok) return;
      var had = unread; notifs = j.items || []; unread = j.unread || 0; overdue = j.overdue || 0; dueToday = j.due_today || 0; paintBell();
      if(unread > had && had >= 0 && $('nf-pan')) paintPanel();
      var fresh = notifs.filter(function(n){ return n.kind === 'joined' && !seenJoin[n.id]; });
      fresh.forEach(function(n){ seenJoin[n.id] = 1; });
      if(fresh.length && booted) { o.reload(); loadInvites(); }   // someone just joined: refresh Contacts
      booted = true;
    }).catch(function(){});
  }
  // the badge = new notifications + late tasks (late tasks stay counted until they're done)
  function paintBell(){ var t = unread + overdue, n = $('nf-n'); if(n) n.textContent = t ? (t > 99 ? '99+' : t) : '';
    var b = $('nf-btn'); if(b) b.setAttribute('aria-label', 'Notifications' + (unread ? ', ' + unread + ' new' : '') + (overdue ? ', ' + overdue + ' late task' + (overdue === 1 ? '' : 's') : '')); }
  function paintPanel(){
    var p = $('nf-pan'); if(!p) return;
    var due = overdue + dueToday;
    p.innerHTML = '<h3>Notifications</h3>' + (due ? '<button type="button" class="nf' + (overdue ? ' un' : '') + '" data-today="1"><i></i><span><b>⏰ ' + (overdue ? overdue + ' late task' + (overdue === 1 ? '' : 's') : '') + (overdue && dueToday ? ' · ' : '') + (dueToday ? dueToday + ' due today' : '') + '</b><small>Open Today to work them</small></span></button>' : '') + (notifs.length ? notifs.map(function(n){
      return '<button type="button" class="nf' + (n.read_at ? '' : ' un') + '" data-nu="' + esc(n.user_id || '') + '" data-ni="' + esc(n.invite_id || '') + '"><i></i><span><b>' + esc(n.title) + '</b><small>' + esc(n.body || '') + ' · ' + esc(ago(n.created_at)) + '</small></span></button>';
    }).join('') : '<div class="nf-empty">Nothing yet. Invite a client and you\'ll see here when they open it and join.</div>');
  }
  function togglePanel(){
    var p = $('nf-pan');
    if(p){ p.remove(); return; }
    p = document.createElement('div'); p.id = 'nf-pan'; p.className = 'nf-pan'; p.setAttribute('role', 'dialog'); p.setAttribute('aria-label', 'Notifications');
    var r = $('nf-btn').getBoundingClientRect(); p.style.top = Math.round(r.bottom + 8) + 'px';
    document.body.appendChild(p); paintPanel();
    p.addEventListener('click', function(e){
      var b = e.target.closest('.nf'); if(!b) return;
      if(b.hasAttribute('data-today')){ p.remove(); if(o.openToday) o.openToday(); return; }
      var u = b.getAttribute('data-nu'); p.remove();
      if(u) o.focusClient(u); else if(b.getAttribute('data-ni')) o.focusClient(null);
    });
    if(unread){ setTimeout(function(){ rpc('jag_notifs_read', { p_ids: null }).then(function(){ unread = 0; notifs.forEach(function(n){ n.read_at = n.read_at || new Date().toISOString(); }); paintBell(); }).catch(function(){}); }, 1200); }
  }
  document.addEventListener('click', function(e){
    var p = $('nf-pan'); if(p && !p.contains(e.target) && !e.target.closest('#nf-btn')) p.remove();
  });

  /* ---------------- journey buttons that aren't plain links ---------------- */
  document.addEventListener('click', function(e){
    var b = e.target.closest('[data-jx]'); if(!b) return;
    var id = b.getAttribute('data-u'), c = o.findRow(id) || (window.JagProfile && JagProfile.contact ? JagProfile.contact(id) : null); if(!c) return;
    if(b.getAttribute('data-jx') === 'inv'){ openInvite({ name: c.name || '', phone: c.phone || '', email: c.email || '', lang: c.lang || 'es' }); return; }
    if(b.getAttribute('data-jx') === 'app'){
      var es = c.lang !== 'en', f = first(c.name), af = (me && me.first_name) || 'Jason';
      var url = SITE + '/apply.html';
      var text = es ? '¡Hola' + (f ? ' ' + f : '') + '! Soy ' + af + ' de Jason Aguirre Group. El siguiente paso es la aplicación de préstamo (5 minutos, no afecta su crédito): ' + url
                    : 'Hi' + (f ? ' ' + f : '') + '! It\'s ' + af + ' with Jason Aguirre Group. The next step is the loan application (5 minutes, no hit to your credit): ' + url;
      var ph = digits(c.phone);
      if(ph) topGo('sms:+1' + ph + '?&body=' + encodeURIComponent(text));
      else if(c.email) topGo('mailto:' + encodeURIComponent(c.email) + '?subject=' + encodeURIComponent(es ? 'Su aplicación de préstamo' : 'Your loan application') + '&body=' + encodeURIComponent(text));
      else copy(text).then(function(){ toast('Message copied.'); });
    }
  });

  var timer = null;
  window.JagCRM = {
    // opts: { rpc, me, isLead, canScreen, seeAll, reload(), findRow(uid), focusClient(uid), openToday() }
    init: function(opts){
      o = opts; me = opts.me;
      // header: notifications bell
      var hd = document.querySelector('.hd .wrap');
      if(hd && !$('nf-btn')){
        var b = document.createElement('button'); b.type = 'button'; b.className = 'out bell'; b.id = 'nf-btn'; b.style.marginLeft = 'auto';
        b.innerHTML = '🔔<span class="tc" id="nf-n"></span>'; b.onclick = togglePanel;
        var first = hd.querySelector('.out'); hd.insertBefore(b, first);
        if(first) first.style.marginLeft = '0';
      }
      // contacts tab: invite button + invited list
      var sec = $('t-clients');
      if(sec && !$('crm-top')){
        var top = document.createElement('div'); top.className = 'crm-top'; top.id = 'crm-top';
        top.innerHTML = '<button type="button" class="crm-inv" id="crm-inv">＋ Invite a client</button>' + (myUrl() ? '<button type="button" class="crm-lnk" id="crm-mylink">🔗 My invite link</button>' : '');
        var inv = document.createElement('div'); inv.className = 'invs'; inv.id = 'crm-invs'; inv.hidden = true;
        inv.addEventListener('click', invClick);
        var stats = $('stats');
        sec.insertBefore(top, stats || sec.firstChild);
        sec.insertBefore(inv, stats || sec.firstChild);
        $('crm-inv').onclick = function(){ openInvite(); };
        if($('crm-mylink')) $('crm-mylink').onclick = openLink;
      }
      loadInvites(); loadNotifs();
      clearInterval(timer);
      timer = setInterval(function(){ if(!document.hidden) loadNotifs(); }, 30000);
      document.addEventListener('visibilitychange', function(){ if(!document.hidden){ loadNotifs(); loadInvites(); } });
    },
    journey: journey, timeline: timeline, invite: openInvite, inviteLink: openLink, reloadInvites: loadInvites, next: nextStep, state: state, toast: toast, copy: copy
  };
})();
