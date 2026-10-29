/* ============================================================
   JAG Today — the first tab of the Agent Hub: one agent's day in one screen, so nobody needs Follow Up Boss to know
   who to call.
     · tasks due today (and overdue), with a check box to finish them
     · new leads assigned to them that nobody has called yet (last 3 days)
     · contacts handed to them (stage hand-offs, assignments, collaborator adds; last 3 days)
     · app clients who were back online in the last 24 hours
     · saved lists (like FUB smart lists) with live counts; tap one to open it in Contacts.
       Leads and admins make team lists and can look at any teammate's day; everyone can make their own lists.
   Data: jag_today, jag_saved_list_save / _delete, jag_contact_task (supabase-today.sql).
   ============================================================ */
(function(){
  var o = null, D = null, scope = 'mine', who = '', seq = 0;
  function $(id){ return document.getElementById(id); }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function digits(p){ return String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); }
  function first(n){ return String(n || '').trim().split(/\s+/)[0] || ''; }
  function ago(iso){
    if(!iso) return '';
    var m = (Date.now() - new Date(iso).getTime()) / 60000;
    if(m < 2) return 'just now'; if(m < 60) return Math.floor(m) + ' min ago'; if(m < 1440) return Math.floor(m / 60) + ' h ago';
    var d = Math.floor(m / 1440); return d === 1 ? 'yesterday' : d + ' days ago';
  }
  function hm(iso){ return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' }); }
  function plural(n, a, b){ return n + ' ' + (n === 1 ? a : (b || a + 's')); }
  var STAGES = ['Lead', 'Attempted contact', 'Spoke with customer', 'Appointment set', 'Met with customer', 'Hot Prospect', 'Applied', 'Loan Approved',
    'Showing homes', 'Submitting offers', 'Under contract', 'Pending', 'Closed', 'Nurture', '2027 Follow-up', 'Sphere', 'Credit Lead', 'Credit Repair', 'Investor', 'Unresponsive'];

  var css = document.createElement('style');
  css.textContent = [
    '.td-hd{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:4px 0 14px}',
    '.td-hd h2{margin:0;font-size:28px;font-weight:800;letter-spacing:-.03em}.td-hd small{color:var(--muted);font-weight:700;font-size:13px}',
    '.td-hd select{height:42px;border:1px solid #d9d6d1;border-radius:14px;padding:0 10px;font-weight:700;font-size:14px;background:#f6f5f3;color:var(--ink)}',
    '.td-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}@media(max-width:820px){.td-grid{grid-template-columns:1fr}}',
    '.td-card{border:2px solid #ebe9e5;border-radius:22px;padding:14px 14px 8px;background:var(--paper);min-width:0}',
    '.td-card h3{margin:0 0 6px;font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;display:flex;align-items:center;gap:8px}',
    '.td-card h3 .n{background:var(--red);color:#fff;border-radius:99px;font-size:11px;padding:2px 8px;letter-spacing:0}.td-card h3 .n.z{background:#efedea;color:var(--muted)}',
    '.td-empty{color:var(--muted);font-size:14px;padding:10px 2px 12px}',
    '.td-r{display:flex;align-items:center;gap:8px;padding:8px 0;border-top:1px solid #f0eeea}.td-r:first-of-type{border-top:0}',
    '.td-r input[type=checkbox]{width:22px;height:22px;flex:none;accent-color:var(--red)}',
    '.td-m{flex:1;min-width:0;text-align:left;border:0;background:none;padding:2px 0;color:inherit;cursor:pointer}',
    '.td-m b{display:block;font-size:15px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.td-m small{display:block;color:var(--muted);font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.td-m small .od{color:var(--red);font-weight:800}',
    '.td-a{display:flex;gap:6px;flex:none}',
    '.td-a a{width:40px;height:40px;border-radius:50%;border:2px solid var(--red);display:grid;place-items:center;text-decoration:none;font-size:16px;background:#fff}',
    '.td-a a.c{background:var(--red)}',
    '.td-more{display:block;width:100%;border:0;background:none;color:var(--red);font-weight:800;font-size:13.5px;padding:8px 0 6px;text-align:left}',
    '.td-lh{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:22px 0 10px}.td-lh h3{margin:0;font-size:18px;font-weight:800;flex:1}',
    '.td-seg{display:inline-flex;border:2px solid var(--line);border-radius:99px;overflow:hidden}.td-seg button{border:0;background:#fff;padding:7px 13px;font-weight:800;font-size:13px;color:var(--muted)}',
    '.td-seg button[aria-pressed=true]{background:var(--ink);color:#fff}',
    '.td-new{border:2px solid var(--red);background:#fff;color:var(--red);border-radius:99px;padding:8px 14px;font-weight:800;font-size:13.5px;min-height:40px}',
    '.td-lists{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,200px),1fr));gap:10px}',
    '.ls{position:relative;border:2px solid #ebe9e5;border-radius:20px;background:#f6f5f3;padding:14px 14px 12px;text-align:left;cursor:pointer;color:inherit;display:flex;flex-direction:column;gap:4px;min-height:104px}',
    '.ls:hover{border-color:var(--ink)}.ls b{font-size:32px;font-weight:800;letter-spacing:-.04em;line-height:1}.ls span{font-weight:700;font-size:14px;line-height:1.3;padding-right:18px}',
    '.ls i{font-style:normal;font-size:10px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin-top:auto}',
    '.ls.z b{color:var(--muted)}',
    '.ls-x{position:absolute;top:6px;right:6px;border:0;background:none;width:30px;height:30px;border-radius:50%;font-size:17px;color:var(--muted)}.ls-x:hover{background:#fff;color:var(--red)}',
    '.lb-f{display:flex;flex-direction:column;gap:6px;font-weight:800;font-size:13px}.lb-f small{font-weight:600;color:var(--muted)}',
    '.lb-f input[type=text],.lb-f select,.lb-f input[type=number]{height:46px;border:1px solid #d9d6d1;border-radius:14px;background:#f6f5f3;padding:0 12px;font:inherit;font-size:16px;font-weight:600;color:var(--ink)}',
    '.lb-st{display:flex;flex-wrap:wrap;gap:6px}.lb-st button{border:2px solid var(--line);background:#fff;border-radius:99px;padding:6px 11px;font-weight:700;font-size:13px}',
    '.lb-st button[aria-pressed=true]{background:var(--ink);border-color:var(--ink);color:#fff}',
    '.lb-r{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.lb-r select{flex:1 1 220px}.lb-r input{width:90px}',
    '.lb-ck{display:flex;align-items:center;gap:10px;font-weight:700;font-size:14.5px}.lb-ck input{width:22px;height:22px;accent-color:var(--red)}',
    '.lb-err{color:var(--red);font-weight:700;font-size:14px;margin:0}'
  ].join('\n');
  document.head.appendChild(css);

  function rpc(n, a){ return o.rpc(n, a); }
  function load(){
    var s = ++seq, box = $('t-today'); if(!box) return Promise.resolve();
    if(!D) box.innerHTML = '<div class="empty">Loading your day…</div>';
    return rpc('jag_today', { p: who ? { agent: who } : {} }).then(function(j){
      if(s !== seq) return;
      if(!j || !j.ok){ box.innerHTML = '<div class="empty">Could not load your day.</div>'; return; }
      D = j; render();
      if(o.onCount && (!who || who === j.me)) o.onCount((j.counts.overdue || 0) + (j.counts.due_today || 0));
    }).catch(function(){ if(s === seq && !D) box.innerHTML = '<div class="empty">Could not load your day. Check your connection.</div>'; });
  }

  function callBtns(c){
    var ph = digits(c.phone); if(!ph) return '';
    var nm = esc(first(c.name) || 'them');
    return '<span class="td-a"><a class="c" href="tel:+1' + ph + '" aria-label="Call ' + nm + '">📞</a><a href="sms:+1' + ph + '" aria-label="Text ' + nm + '">💬</a></span>';
  }
  function row(c, why){
    return '<div class="td-r"><button type="button" class="td-m" data-prof="' + esc(c.id) + '"><b>' + esc(c.name || 'No name') + '</b><small>' + why + '</small></button>' + callBtns(c) + '</div>';
  }
  var SHOW = 6, open = {};
  function card(key, title, n, items, empty, fn){
    var list = open[key] ? items : items.slice(0, SHOW);
    return '<section class="td-card" aria-label="' + esc(title) + '"><h3>' + esc(title) + ' <span class="n' + (n ? '' : ' z') + '">' + n + '</span></h3>' +
      (items.length ? list.map(fn).join('') + (items.length > SHOW ? '<button type="button" class="td-more" data-more="' + key + '">' + (open[key] ? 'Show fewer' : 'Show all ' + items.length) + '</button>' : '') +
        (n > items.length ? '<div class="td-empty">+ ' + (n - items.length) + ' more in Contacts</div>' : '')
       : '<div class="td-empty">' + empty + '</div>') + '</section>';
  }
  function render(){
    var box = $('t-today'); if(!box || !D) return;
    var c = D.counts || {}, me = o.me, mine = !who || who === D.me;
    var hr = +new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/Chicago' });
    var hi = (hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening') + ', ' + esc(mine ? (me.first_name || first(me.name)) : first(D.name));
    var due = (c.overdue || 0) + (c.due_today || 0);
    box.innerHTML =
      '<div class="td-hd"><div><h2>' + (mine ? hi : esc(first(D.name)) + '\'s day') + '</h2><small>' + esc(D.today || '') + (mine ? '' : ' · viewing a teammate') + '</small></div>' +
        (D.sees_all && D.team ? '<select id="td-agent" aria-label="Whose day"><option value="">My day</option>' + D.team.filter(function(a){ return a.code !== D.me; }).map(function(a){
          return '<option value="' + esc(a.code) + '"' + (a.code === who ? ' selected' : '') + '>' + esc(a.name) + '</option>'; }).join('') + '</select>' : '') + '</div>' +
      '<div class="stats"><div class="stat"><b class="num">' + due + '</b><span>Tasks due' + (c.overdue ? ' · ' + c.overdue + ' late' : '') + '</span></div>' +
        '<div class="stat"><b class="num">' + (c.fresh || 0) + '</b><span>New leads to call</span></div>' +
        '<div class="stat"><b class="num">' + (c.handed || 0) + '</b><span>Handed to ' + (mine ? 'you' : first(D.name)) + '</span></div>' +
        '<div class="stat"><b class="num">' + (c.back || 0) + '</b><span>Back on the app</span></div></div>' +
      '<div class="td-grid">' +
        card('tasks', 'Tasks due today', due, D.tasks || [], c.later ? 'Nothing due today. ' + plural(c.later, 'task') + ' coming up later.' : 'Nothing due today. Add tasks from any profile.', function(t){
          var k = t.contact || {};
          return '<div class="td-r"><input type="checkbox" data-tdone="' + t.id + '" aria-label="Mark done: ' + esc(t.title) + '">' +
            '<button type="button" class="td-m" data-prof="' + esc(k.id) + '"><b>' + esc(t.title) + '</b><small>' + esc(k.name || '') + ' · ' +
            (t.overdue ? '<span class="od">Late · was due ' + esc(ago(t.due_at)) + '</span>' : 'due ' + esc(hm(t.due_at))) + '</small></button>' + callBtns(k) + '</div>';
        }) +
        card('fresh', 'New leads, not called yet', c.fresh || 0, D.fresh || [], 'No new leads waiting. 👍', function(x){
          return row(x, esc([x.stage, x.source, 'came in ' + ago(x.created_at)].filter(Boolean).join(' · ')));
        }) +
        card('handed', 'Handed to ' + (mine ? 'you' : first(D.name)), c.handed || 0, D.handed || [], 'Nobody handed over in the last 3 days.', function(x){
          return row(x, esc((x.stage ? x.stage + ' · ' : '') + (x.kind === 'collab' ? 'added as collaborator' : x.kind === 'handoff' ? 'stage hand-off' : 'assigned') + ' · ' + ago(x.at)));
        }) +
        card('back', 'Back on the app', c.back || 0, D.back || [], 'None of ' + (mine ? 'your' : 'their') + ' app clients were online in the last 24 hours.', function(x){
          return row(x, esc([x.score != null ? 'score ' + x.score : '', x.stage, 'online ' + ago(x.active_at)].filter(Boolean).join(' · ')));
        }) +
      '</div>' +
      '<div class="td-lh"><h3>Saved lists</h3>' +
        (D.sees_all ? '<div class="td-seg" role="group" aria-label="Count"><button type="button" data-scope="mine" aria-pressed="' + (scope === 'mine') + '">' + (mine ? 'Mine' : first(D.name) + '\'s') + '</button><button type="button" data-scope="team" aria-pressed="' + (scope === 'team') + '">Whole team</button></div>' : '') +
        '<button type="button" class="td-new" id="td-new">＋ New list</button></div>' +
      '<div class="td-lists">' + (D.lists || []).map(function(l){
        var n = scope === 'team' && l.n_team != null ? l.n_team : l.n;
        var canDel = l.mine_list || (l.team && D.sees_all);
        return '<div style="position:relative"><button type="button" class="ls' + (n ? '' : ' z') + '" data-list="' + l.id + '"><b class="num">' + (n || 0).toLocaleString('en-US') + '</b><span>' + esc(l.name) + '</span><i>' + (l.team ? 'Team list' : 'Your list') + '</i></button>' +
          (canDel ? '<button type="button" class="ls-x" data-ldel="' + l.id + '" aria-label="Delete list ' + esc(l.name) + '">×</button>' : '') + '</div>';
      }).join('') + '</div>' +
      '<p class="note">Your day refreshes every time you open this tab. Tap a name for their profile, 📞 to call, 💬 to text. "New leads" = assigned to you in the last 3 days and not called yet (calls in Follow Up Boss count). Lists count ' + (scope === 'team' ? 'the whole team' : 'contacts assigned to or shared with ' + (mine ? 'you' : first(D.name))) + '; tap one to work it in Contacts. Lola texts you this summary on weekday mornings (turn it off in Settings → Morning board).</p>';
  }

  function onClick(e){
    var b = e.target.closest('[data-prof],[data-more],[data-list],[data-ldel],[data-scope],#td-new'); if(!b) return;
    if(b.hasAttribute('data-ldel')){
      var l = (D.lists || []).filter(function(x){ return String(x.id) === b.getAttribute('data-ldel'); })[0]; if(!l) return;
      if(!confirm('Delete the list "' + l.name + '"' + (l.team ? ' for the whole team' : '') + '?')) return;
      rpc('jag_saved_list_delete', { p_id: l.id }).then(load).catch(function(){}); return;
    }
    if(b.hasAttribute('data-prof')){ var id = b.getAttribute('data-prof'); if(id && o.openProfile) o.openProfile(id); return; }
    if(b.hasAttribute('data-more')){ var k = b.getAttribute('data-more'); open[k] = !open[k]; render(); return; }
    if(b.hasAttribute('data-scope')){ scope = b.getAttribute('data-scope'); render(); return; }
    if(b.hasAttribute('data-list')){
      var li = (D.lists || []).filter(function(x){ return String(x.id) === b.getAttribute('data-list'); })[0];
      if(li && o.openList) o.openList({ id: li.id, name: li.name }, scope === 'team' ? 'all' : 'mine', who && who !== D.me ? who : '');
      return;
    }
    if(b.id === 'td-new') builder();
  }
  function onChange(e){
    if(e.target.id === 'td-agent'){ who = e.target.value; D = null; load(); return; }
    if(e.target.hasAttribute('data-tdone')){
      var cb = e.target; cb.disabled = true;
      rpc('jag_contact_task', { p: { id: +cb.getAttribute('data-tdone'), op: 'done' } }).then(function(){ if(o.toast) o.toast('Task done ✓'); load(); })
        .catch(function(){ cb.disabled = false; cb.checked = false; });
    }
  }

  /* ---------- new saved list ---------- */
  function builder(){
    var stages = (o.stages && o.stages().length ? o.stages() : STAGES), picked = {};
    var ov = document.createElement('div'); ov.className = 'crm-ov'; ov.id = 'lb-ov';
    ov.innerHTML = '<div class="crm-sh" role="dialog" aria-modal="true" aria-labelledby="lb-h">' +
      '<div class="crm-hd"><div><h2 id="lb-h">New saved list</h2><p>Pick stages and a rule. The list keeps itself up to date, like a smart list in Follow Up Boss.</p></div><button type="button" class="crm-close" id="lb-x" aria-label="Close">×</button></div>' +
      '<label class="lb-f">List name<input type="text" id="lb-n" maxlength="80" placeholder="Applied, no call in 3 days"></label>' +
      '<div class="lb-f">Stages <small>None picked = any stage</small><div class="lb-st" id="lb-st">' + stages.map(function(s){ return '<button type="button" data-st="' + esc(s) + '" aria-pressed="false">' + esc(s) + '</button>'; }).join('') + '</div></div>' +
      '<div class="lb-f">Rule<div class="lb-r"><select id="lb-rule" aria-label="Rule"><option value="">No rule</option>' +
        '<option value="no_call_days">Not called in the last…</option><option value="no_contact_days">No call, text or email in the last…</option>' +
        '<option value="created_days">Came in within the last…</option><option value="active_days">On the app within the last…</option><option value="never_called">Never called</option></select>' +
        '<input type="number" id="lb-d" min="1" max="365" value="3" aria-label="Days"><span id="lb-dl">days</span></div></div>' +
      '<label class="lb-ck"><input type="checkbox" id="lb-app"> Only people on the app</label>' +
      '<label class="lb-ck"><input type="checkbox" id="lb-tour"> No tour booked</label>' +
      '<label class="lb-ck"><input type="checkbox" id="lb-due"> Has late tasks</label>' +
      (D && D.sees_all ? '<label class="lb-ck"><input type="checkbox" id="lb-team" checked> Share with the whole team</label>' : '') +
      '<p class="lb-err" id="lb-err" role="alert"></p>' +
      '<div class="crm-send"><button type="button" class="p" id="lb-save">Save list</button><button type="button" id="lb-cancel">Cancel</button></div></div>';
    document.body.appendChild(ov);
    function close(){ ov.remove(); document.removeEventListener('keydown', esc1); }
    function esc1(e){ if(e.key === 'Escape') close(); }
    document.addEventListener('keydown', esc1);
    ov.addEventListener('click', function(e){ if(e.target === ov) close(); });
    $('lb-x').onclick = close; $('lb-cancel').onclick = close;
    function days(){ var r = $('lb-rule').value, on = r && r !== 'never_called'; $('lb-d').hidden = !on; $('lb-dl').hidden = !on; }
    $('lb-rule').onchange = days; days();
    $('lb-st').onclick = function(e){ var s = e.target.closest('[data-st]'); if(!s) return; var v = s.getAttribute('data-st'); picked[v] = !picked[v]; s.setAttribute('aria-pressed', String(!!picked[v])); };
    setTimeout(function(){ $('lb-n').focus(); }, 60);
    $('lb-save').onclick = function(){
      var name = $('lb-n').value.trim(), f = {}, r = $('lb-rule').value, st = Object.keys(picked).filter(function(k){ return picked[k]; });
      if(st.length) f.stages = st;
      if(r === 'never_called') f.never_called = true; else if(r){ var d = Math.max(1, Math.min(365, parseInt($('lb-d').value, 10) || 0)); if(!d){ $('lb-err').textContent = 'Type the number of days.'; return; } f[r] = d; }
      if($('lb-app').checked) f.app = true; if($('lb-tour').checked) f.no_tour = true; if($('lb-due').checked) f.tasks_due = true;
      if(!name){ $('lb-err').textContent = 'Give the list a name.'; $('lb-n').focus(); return; }
      if(!Object.keys(f).length){ $('lb-err').textContent = 'Pick at least one stage or rule.'; return; }
      var btn = this; btn.disabled = true;
      rpc('jag_saved_list_save', { p: { name: name, filter: f, team: !!($('lb-team') && $('lb-team').checked) } }).then(function(j){
        btn.disabled = false;
        if(!j || !j.ok){ $('lb-err').textContent = j && j.reason === 'team_lists' ? 'Only Leads and admins can make team lists.' : 'Could not save the list.'; return; }
        close(); if(o.toast) o.toast('List saved'); load();
      }).catch(function(){ btn.disabled = false; $('lb-err').textContent = 'Could not save the list. Check your connection.'; });
    };
  }

  window.JagToday = {
    // opts: { rpc, me, openProfile(id), openList({id,name}, view, agent), stages(), onCount(n), toast(msg) }
    init: function(opts){
      o = opts;
      var box = $('t-today');
      if(box && !box.__jt){ box.__jt = 1; box.addEventListener('click', onClick); box.addEventListener('change', onChange); }
    },
    load: load
  };
})();
