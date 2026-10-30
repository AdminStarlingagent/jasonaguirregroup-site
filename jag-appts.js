/* ============================================================
   JAG Appointments — every client appointment in one list (Agent Hub tab "Appointments"), so nobody has to go day by day
   through the Follow Up Boss calendar.
     · No follow-up (default): past appointments where nobody called, texted or wrote a note after — hot clients first
     · Outcome missing: the last 7 days without an outcome (showed / no-show)
     · Upcoming: with Lola's call brief
     · All: the last 60 days + what's booked
   Each row: when, client (🔥 hot), Lola's read of where they are + the next step, what the team did after
   (calls / texts / notes from FUB), the owner. Log outcome (showed / no-show + note) writes FUB too.
   Also used by the client profile (jag-profile.js): JagAppts.cardHtml(list), .outcome(row, done), .book(contact, done).
   Data: jag_appts_list / jag_appts_for_contact (supabase-appointments.sql), edge fn jag-appointments (outcome / create / refresh).
   ============================================================ */
(function(){
  var o = null, rows = [], view = 'none', mine = false, who = '', hotOnly = false, q = '', loaded = false, seq = 0;
  var C = window.JAG_CRM || {}, BASE = String(C.url || '').replace(/\/+$/, ''), KEY = C.anonKey;
  var FUB = 'https://jasonhoustonrealty.followupboss.com/2/people/view/';
  function $(id){ return document.getElementById(id); }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function digits(p){ return String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); }
  function ago(iso){ if(!iso) return ''; var m = (Date.now() - new Date(iso).getTime()) / 60000;
    if(m < 2) return 'just now'; if(m < 60) return Math.floor(m) + ' min ago'; if(m < 1440) return Math.floor(m / 60) + ' h ago';
    var d = Math.floor(m / 1440); return d === 1 ? 'yesterday' : d + ' days ago'; }
  var TZ = { timeZone: 'America/Chicago' };
  function dkey(d){ return new Date(d).toLocaleDateString('en-CA', TZ); }
  function when(r){
    var d = new Date(r.start_at), today = dkey(Date.now()), tm = dkey(Date.now() + 864e5), ys = dkey(Date.now() - 864e5), k = dkey(d);
    var day = k === today ? 'Today' : k === tm ? 'Tomorrow' : k === ys ? 'Yesterday' : d.toLocaleDateString('en-US', Object.assign({ weekday: 'short', month: 'short', day: 'numeric' }, TZ));
    return r.all_day ? day + ' · all day' : day + ' · ' + d.toLocaleTimeString('en-US', Object.assign({ hour: 'numeric', minute: '2-digit' }, TZ));
  }
  var ST = {
    upcoming: ['Upcoming', 'up'], needs_outcome: ['Needs outcome', 'wa'], no_followup: ['No follow-up', 'bad'],
    followed: ['Followed up · log outcome', 'mid'], no_show: ['No-show', 'gr'], done: ['Done', 'ok']
  };
  var OUT = [[2, '✓ Showed · working with buyers'], [4, '✓ Showed · application submitted'], [3, '✓ Showed · listing obtained'], [1, '✗ No-show']];

  var css = document.createElement('style');
  css.textContent = [
    '.ap-hd{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:4px 0 12px}',
    '.ap-hd h2{margin:0;font-size:28px;font-weight:800;letter-spacing:-.03em}.ap-hd small{display:block;color:var(--muted);font-weight:600;font-size:13px;margin-top:2px}',
    '.ap-tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:12px}@media(max-width:720px){.ap-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}}',
    '.ap-tile{border:2px solid #ebe9e5;border-radius:18px;background:var(--paper);padding:12px 14px;text-align:left;cursor:pointer;color:var(--ink)}',
    '.ap-tile b{display:block;font-size:28px;font-weight:800;letter-spacing:-.03em;line-height:1.1}.ap-tile span{font-size:12.5px;font-weight:700;color:var(--muted)}',
    '.ap-tile.on{border-color:var(--ink)}.ap-tile.bad b{color:var(--red)}.ap-tile small{display:block;font-size:11.5px;font-weight:700;color:var(--red);margin-top:2px}',
    '.ap-bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}',
    '.ap-bar input,.ap-bar select{height:42px;border:1px solid #d9d6d1;border-radius:14px;padding:0 12px;font-size:15px;background:#f6f5f3;color:var(--ink)}',
    '.ap-bar input{flex:1 1 200px;min-width:0}',
    '.ap-tg{height:42px;border-radius:99px;border:1.5px solid #d9d6d1;background:var(--paper);font-weight:800;font-size:13.5px;padding:0 14px;color:var(--ink)}',
    '.ap-tg[aria-pressed="true"]{background:var(--ink);border-color:var(--ink);color:#fff}',
    '.ap-day{font-size:11px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:16px 2px 6px}',
    '.ap-r{border:2px solid #ebe9e5;border-radius:20px;background:var(--paper);padding:12px 14px;margin-bottom:10px;display:flex;flex-direction:column;gap:6px}',
    '.ap-r.hot{border-color:#ffd0d6;box-shadow:0 0 0 3px #fff1f3}',
    '.ap-top{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap}',
    '.ap-top .w{flex:1 1 220px;min-width:0}.ap-top b{font-size:16.5px;font-weight:800}.ap-top b a{color:inherit;text-decoration:none}',
    '.ap-top small{display:block;color:var(--muted);font-size:13px;font-weight:600}',
    '.ap-st{font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;border-radius:99px;padding:5px 10px;white-space:nowrap}',
    '.ap-st.up{background:#e8efff;color:#1d47c4}.ap-st.wa{background:#fff3d6;color:#8a5a00}.ap-st.bad{background:#fde7ea;color:#a81c2b}',
    '.ap-st.mid{background:#eaf6ef;color:#1a6b3c}.ap-st.ok{background:#1f8a4c;color:#fff}.ap-st.gr{background:#efedea;color:#6b6873}',
    '.ap-hot{font-size:11px;font-weight:800;background:var(--red);color:#fff;border-radius:99px;padding:3px 8px;margin-left:6px;vertical-align:2px}',
    '.ap-lola{background:#f6f5f3;border-radius:14px;padding:9px 12px;font-size:13.5px;line-height:1.4}',
    '.ap-lola b{font-weight:800}.ap-lola .nx{display:block;margin-top:2px}.ap-lola .why{display:block;color:var(--muted);font-size:12.5px;margin-top:3px}',
    '.ap-steps{display:inline-flex;gap:3px;vertical-align:1px;margin-left:6px}.ap-steps i{width:14px;height:5px;border-radius:3px;background:#dedbd6}.ap-steps i.y{background:var(--green)}',
    '.ap-aft{font-size:13.5px}.ap-aft.none{color:var(--red);font-weight:700}.ap-aft.yes{color:#1a6b3c;font-weight:700}',
    '.ap-brief{font-size:13px;color:#45444c;white-space:pre-line;border-left:3px solid #e8efff;padding-left:10px}',
    '.ap-act{display:flex;gap:6px;flex-wrap:wrap;margin-top:2px}',
    '.ap-act button,.ap-act a{height:38px;border-radius:12px;border:1.5px solid #d9d6d1;background:var(--paper);color:var(--ink);font-weight:800;font-size:13px;padding:0 12px;text-decoration:none;display:inline-flex;align-items:center;gap:5px}',
    '.ap-act .p{background:var(--red);border-color:var(--red);color:#fff}',
    '.ap-empty{color:var(--muted);padding:30px 6px;text-align:center;font-weight:600}',
    '.ap-ov{position:fixed;inset:0;background:rgba(15,14,20,.55);display:flex;align-items:flex-end;justify-content:center;z-index:9850}',
    '@media(min-width:640px){.ap-ov{align-items:center;padding:16px}}',
    '.ap-sh{background:var(--paper);width:100%;max-width:470px;border-radius:22px 22px 0 0;padding:20px 18px calc(18px + env(safe-area-inset-bottom,0px));max-height:94vh;overflow:auto;display:flex;flex-direction:column;gap:10px}',
    '@media(min-width:640px){.ap-sh{border-radius:22px}}',
    '.ap-sh h2{margin:0;font-size:20px;font-weight:800}.ap-sh p{margin:0;color:var(--muted);font-size:13.5px}',
    '.ap-opt{display:flex;flex-direction:column;gap:8px}',
    '.ap-opt button{min-height:50px;border-radius:14px;border:2px solid #d9d6d1;background:var(--paper);font-weight:800;font-size:15px;text-align:left;padding:0 14px;color:var(--ink)}',
    '.ap-opt button[aria-pressed="true"]{border-color:var(--ink);background:var(--ink);color:#fff}',
    '.ap-sh textarea,.ap-sh input,.ap-sh select{box-sizing:border-box;width:100%;border:1.5px solid #d9d6d1;border-radius:14px;padding:10px 12px;font:inherit;font-size:16px;background:#f6f5f3;color:var(--ink)}',
    '.ap-sh textarea{min-height:80px;resize:vertical}',
    '.ap-sh label{font-size:12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);display:block}',
    '.ap-two{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
    '.ap-go{height:52px;border:0;border-radius:99px;background:var(--red);color:#fff;font-weight:800;font-size:16px}',
    '.ap-go:disabled{opacity:.5}.ap-x{border:0;background:none;color:var(--muted);font-weight:700;padding:8px}',
    '.ap-err{color:var(--red);font-weight:700;font-size:13.5px}',
    '.ap-chk{display:flex;gap:10px;align-items:center;font-weight:700;font-size:14.5px;text-transform:none;letter-spacing:0;color:var(--ink)}.ap-chk input{width:22px;height:22px;accent-color:var(--red)}'
  ].join('\n');
  document.head.appendChild(css);

  function token(){ return window.JagShare ? JagShare.token() : Promise.resolve(null); }
  function fn(body){
    return token().then(function(t){
      return fetch(BASE + '/functions/v1/jag-appointments', { method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }).then(function(r){ return r.json().catch(function(){ return { ok: false, error: 'Network error' }; }); });
  }

  function lolaHtml(L){
    if(!L) return '';
    var steps = ''; for(var i = 1; i <= 7; i++) steps += '<i class="' + (i <= (L.step || 0) ? 'y' : '') + '"></i>';
    return '<div class="ap-lola">Lola: <b>' + esc(L.label) + '</b><span class="ap-steps" aria-hidden="true">' + steps + '</span>' +
      '<span class="nx">→ ' + esc(L.next) + '</span>' + ((L.why || []).length ? '<span class="why">' + esc((L.why || []).join(' · ')) + '</span>' : '') + '</div>';
  }
  function afterHtml(r){
    var f = r.follow;
    if(r.status === 'upcoming') return '';
    if(!f) return '<div class="ap-aft">Checking Follow Up Boss for calls and texts…</div>';
    var at = f.attend ? '<span style="color:#1a6b3c">📞 Talked ' + f.attend.min + ' min at appointment time' + (f.attend.by ? ' (' + esc(f.attend.by.split(' ')[0]) + ')' : '') + '.</span> ' : '';
    var bits = [];
    if(f.calls) bits.push(f.calls + ' call' + (f.calls === 1 ? '' : 's') + (f.talked ? ' (' + f.talked + ' talked)' : ''));
    if(f.texts) bits.push(f.texts + ' text' + (f.texts === 1 ? '' : 's'));
    if(f.notes) bits.push(f.notes + ' note' + (f.notes === 1 ? '' : 's'));
    if(!bits.length) return '<div class="ap-aft">' + at + '<span' + (r.outcome ? '' : ' style="color:var(--red);font-weight:700"') + '>' + (r.outcome ? 'No calls or texts since.' : 'Nothing since: no call, text or note after it.') + '</span></div>';
    return '<div class="ap-aft yes">' + at + 'After: ' + esc(bits.join(' · ')) + (f.last_at ? ' · last ' + esc(f.last_kind || '') + (f.last_by ? ' by ' + esc(String(f.last_by).split(' ')[0]) : '') + ', ' + esc(ago(f.last_at)) : '') + '</div>';
  }
  function rowHtml(r, compact){
    var L = r.lola || null, st = ST[r.status] || ['', ''], hot = L && L.hot;
    var label = r.status === 'done' ? '✓ ' + (r.outcome || 'Done') : st[0];
    var nm = esc(r.person_name || r.title || 'Client'), ph = digits(r.phone);
    var meta = [r.type, r.location, r.owner ? 'Owner: ' + r.owner.first + ((r.team || []).length > 1 ? ' (+' + ((r.team || []).length - 1) + ' invited)' : '') : ''].filter(Boolean).join(' · ');
    return '<div class="ap-r' + (hot && !compact ? ' hot' : '') + '" data-id="' + r.id + '">' +
      '<div class="ap-top"><div class="w"><b>' + (r.contact_id && !compact ? '<a href="#c/' + esc(r.contact_id) + '" data-ap="prof">' + nm + '</a>' : compact ? esc(when(r)) : nm) + '</b>' +
        (hot && !compact ? '<span class="ap-hot">🔥 Hot</span>' : '') +
        '<small>' + esc(compact ? meta : when(r) + (meta ? ' · ' + meta : '')) + '</small>' +
        (compact && r.title ? '<small>' + esc(r.title) + '</small>' : '') + '</div>' +
        '<span class="ap-st ' + st[1] + '">' + esc(label) + '</span></div>' +
      (!compact ? lolaHtml(L) : '') +
      (r.status === 'upcoming' && r.brief && !compact ? '<div class="ap-brief">' + esc(r.brief) + '</div>' : '') +
      afterHtml(r) +
      (r.outcome && (r.outcome_by || r.note) ? '<div class="ap-aft">' + esc([r.outcome_by ? 'Logged by ' + r.outcome_by + (r.outcome_at ? ' ' + ago(r.outcome_at) : '') : '', r.note].filter(Boolean).join(' · ')) + '</div>' : '') +
      '<div class="ap-act">' +
        (r.status !== 'upcoming' && !r.outcome ? '<button type="button" class="p" data-ap="out">Log outcome</button>' : '') +
        (r.status !== 'upcoming' && r.outcome ? '<button type="button" data-ap="out">Change outcome</button>' : '') +
        (ph && !compact ? '<a href="tel:+1' + ph + '">📞 Call</a>' : '') +
        (r.contact_id && !compact ? '<button type="button" data-ap="prof">Profile</button>' : '') +
        (r.fub_person_id ? '<a href="' + FUB + r.fub_person_id + '" target="_blank" rel="noopener">FUB ↗</a>' : '') +
        (r.status !== 'upcoming' ? '<button type="button" data-ap="ref" title="Check FUB again for calls and texts">↻</button>' : '') +
      '</div></div>';
  }

  function counts(){
    var now = Date.now(), wk = now + 7 * 864e5, today = dkey(now), c = { today: 0, week: 0, need: 0, none: 0, noneHot: 0, hot: 0 };
    var wkAgo = now - 7 * 864e5;
    rows.forEach(function(r){
      var t = new Date(r.start_at).getTime();
      if(dkey(t) === today) c.today++;
      if(t > now && t < wk) c.week++;
      if((r.status === 'needs_outcome' || r.status === 'followed' || r.status === 'no_followup') && t > wkAgo) c.need++;
      if(r.status === 'no_followup'){ c.none++; if(r.lola && r.lola.hot) c.noneHot++; }
    });
    return c;
  }
  function filtered(){
    var k = q.trim().toLowerCase();
    return rows.filter(function(r){
      if(who && String((r.owner || {}).fub_user_id || '') !== who) return false;
      if(hotOnly && !(r.lola && r.lola.hot)) return false;
      if(k && String(r.person_name || r.title || '').toLowerCase().indexOf(k) < 0) return false;
      if(view === 'none') return r.status === 'no_followup';
      if(view === 'recent') return (r.status === 'needs_outcome' || r.status === 'followed' || r.status === 'no_followup') && new Date(r.start_at).getTime() > Date.now() - 7 * 864e5;
      if(view === 'upcoming') return r.status === 'upcoming';
      if(view === 'today') return dkey(r.start_at) === dkey(Date.now());
      return true;
    });
  }
  function paint(){
    var el = $('t-appts'); if(!el) return;
    var c = counts(), list = filtered();
    if(o && o.onCount) o.onCount(c.none || '');
    if(view === 'upcoming' || view === 'today') list.sort(function(a, b){ return new Date(a.start_at) - new Date(b.start_at); });
    else if(view === 'none' || view === 'recent') list.sort(function(a, b){
      var h = ((b.lola && b.lola.hot) ? 1 : 0) - ((a.lola && a.lola.hot) ? 1 : 0); if(h) return h;
      var n = (b.status === 'no_followup' ? 1 : 0) - (a.status === 'no_followup' ? 1 : 0); if(n) return n;
      return new Date(b.start_at) - new Date(a.start_at); });
    else list.sort(function(a, b){ return new Date(b.start_at) - new Date(a.start_at); });
    var owners = {}; rows.forEach(function(r){ if(r.owner) owners[r.owner.fub_user_id] = r.owner.first; });
    var body = '', lastDay = '';
    list.slice(0, 250).forEach(function(r){
      if(view !== 'none'){ var d = dkey(r.start_at); if(d !== lastDay){ lastDay = d; body += '<div class="ap-day">' + esc(when(r).split(' · ')[0]) + '</div>'; } }
      body += rowHtml(r);
    });
    el.innerHTML =
      '<div class="ap-hd"><div><h2>Appointments</h2><small>Every client appointment from Follow Up Boss and the hub · last 60 days and what\'s booked · updated every 10 min</small></div></div>' +
      '<div class="ap-tiles">' +
        '<button type="button" class="ap-tile' + (view === 'today' ? ' on' : '') + '" data-v="today"><b>' + c.today + '</b><span>Today</span></button>' +
        '<button type="button" class="ap-tile' + (view === 'upcoming' ? ' on' : '') + '" data-v="upcoming"><b>' + c.week + '</b><span>Next 7 days</span></button>' +
        '<button type="button" class="ap-tile bad' + (view === 'none' ? ' on' : '') + '" data-v="none"><b>' + c.none + '</b><span>No follow-up after</span>' + (c.noneHot ? '<small>🔥 ' + c.noneHot + ' hot</small>' : '') + '</button>' +
        '<button type="button" class="ap-tile' + (view === 'recent' ? ' on' : '') + '" data-v="recent"><b>' + c.need + '</b><span>Outcome missing · last 7 days</span></button>' +
      '</div>' +
      '<div class="ap-bar"><input type="search" id="ap-q" placeholder="Search a client…" value="' + esc(q) + '" aria-label="Search appointments">' +
        '<select id="ap-who" aria-label="Agent"><option value="">Whole team</option>' + Object.keys(owners).map(function(k){ return '<option value="' + esc(k) + '"' + (who === k ? ' selected' : '') + '>' + esc(owners[k]) + '</option>'; }).join('') + '</select>' +
        '<button type="button" class="ap-tg" data-tg="hot" aria-pressed="' + hotOnly + '">🔥 Hot only</button>' +
        '<button type="button" class="ap-tg" data-tg="all" aria-pressed="' + (view === 'all') + '">All 60 days</button></div>' +
      (loaded ? (body || '<div class="ap-empty">' + (view === 'none' ? 'Nobody left hanging: every past appointment got a call, text or note after 🎉' : view === 'recent' ? 'Every appointment from the last 7 days has an outcome 🎉' : 'No appointments here.') + '</div>') : '<div class="ap-empty">Loading appointments…</div>');
  }
  function load(){
    var mineSeq = ++seq;
    if(!loaded) paint();
    return o.rpc('jag_appts_list', { p_view: 'all', p_days: 60, p_mine: mine }).then(function(j){
      if(mineSeq !== seq) return;
      rows = j && j.ok ? j.rows || [] : []; loaded = true; paint();
    }).catch(function(){ loaded = true; rows = []; paint(); });
  }
  var extra = {};
  function find(id){ return rows.filter(function(r){ return String(r.id) === String(id); })[0] || extra[String(id)]; }

  /* ---------- log outcome ---------- */
  function close(){ var x = $('ap-ov'); if(x) x.remove(); }
  function outcome(r, done){
    close(); var pick = r.outcome_id || null;
    var ov = document.createElement('div'); ov.className = 'ap-ov'; ov.id = 'ap-ov';
    ov.innerHTML = '<div class="ap-sh" role="dialog" aria-modal="true" aria-labelledby="ap-h"><h2 id="ap-h">How did it go?</h2>' +
      '<p>' + esc((r.person_name || 'Client') + ' · ' + when(r)) + '. This sets the outcome in Follow Up Boss and adds your note there.</p>' +
      '<div class="ap-opt">' + OUT.map(function(x){ return '<button type="button" data-o="' + x[0] + '" aria-pressed="' + (pick === x[0]) + '">' + x[1] + '</button>'; }).join('') + '</div>' +
      '<label for="ap-note">Note (what happened, next step)</label><textarea id="ap-note" placeholder="Talked 20 min, pre-approved with Aron, wants 3/2 in Katy under $280K. Sending homes today.">' + esc(r.note || '') + '</textarea>' +
      '<div class="ap-err" id="ap-err"></div><button type="button" class="ap-go" id="ap-save"' + (pick ? '' : ' disabled') + '>Save outcome</button><button type="button" class="ap-x" id="ap-cancel">Cancel</button></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function(e){
      if(e.target === ov || e.target.id === 'ap-cancel'){ close(); return; }
      var b = e.target.closest('[data-o]'); if(b){ pick = +b.getAttribute('data-o'); ov.querySelectorAll('[data-o]').forEach(function(x){ x.setAttribute('aria-pressed', String(x === b)); }); $('ap-save').disabled = false; return; }
      if(e.target.id === 'ap-save'){
        var s = $('ap-save'); s.disabled = true; s.textContent = 'Saving…';
        fn({ action: 'outcome', id: r.id, outcome_id: pick, note: $('ap-note').value }).then(function(j){
          if(!j || !j.ok){ s.disabled = false; s.textContent = 'Save outcome'; $('ap-err').textContent = (j && j.error) || 'Could not save. Try again.'; return; }
          r.outcome = j.outcome; r.outcome_id = pick; r.outcome_by = (o && o.me && (o.me.first_name || o.me.name)) || 'you'; r.outcome_at = new Date().toISOString();
          r.note = $('ap-note').value || r.note; r.status = pick === 1 ? 'no_show' : 'done';
          close(); toast('Saved in Follow Up Boss ✓'); if(done) done(r); paint();
        });
      }
    });
  }
  function toast(m){ if(o && o.toast) o.toast(m); else if(window.JagCRM) JagCRM.toast(m); }

  /* ---------- book an appointment (from a client's profile) ---------- */
  function book(c, done){
    close();
    var d = new Date(Date.now() + 864e5), ds = d.toLocaleDateString('en-CA', TZ);
    var ov = document.createElement('div'); ov.className = 'ap-ov'; ov.id = 'ap-ov';
    ov.innerHTML = '<div class="ap-sh" role="dialog" aria-modal="true" aria-labelledby="ap-h"><h2 id="ap-h">Book an appointment</h2>' +
      '<p>With ' + esc(c.name || 'this client') + '. It goes on the Follow Up Boss calendar with a note, Lola reminds you, and the client gets a reminder.</p>' +
      '<div class="ap-two"><div><label for="ap-d">Day</label><input type="date" id="ap-d" value="' + ds + '"></div><div><label for="ap-t">Time</label><input type="time" id="ap-t" value="10:00" step="900"></div></div>' +
      '<div class="ap-two"><div><label for="ap-ty">Type</label><select id="ap-ty"><option value="1">Buyer consultation</option><option value="2">Listing</option></select></div>' +
        '<div><label for="ap-m">Length</label><select id="ap-m"><option value="15">15 min</option><option value="30" selected>30 min</option><option value="60">1 hour</option><option value="90">1.5 hours</option><option value="120">2 hours</option></select></div></div>' +
      '<div><label for="ap-l">Where</label><input id="ap-l" placeholder="Phone call · Zoom · office · home address"></div>' +
      '<div><label for="ap-n">Note</label><textarea id="ap-n" placeholder="What it\'s about, what to bring…"></textarea></div>' +
      '<label class="ap-chk"><input type="checkbox" id="ap-team"> Invite the whole team (shows on everyone\'s calendar)</label>' +
      '<div class="ap-err" id="ap-err"></div><button type="button" class="ap-go" id="ap-save">Book it</button><button type="button" class="ap-x" id="ap-cancel">Cancel</button></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function(e){
      if(e.target === ov || e.target.id === 'ap-cancel'){ close(); return; }
      if(e.target.id !== 'ap-save') return;
      var dv = $('ap-d').value, tv = $('ap-t').value;
      if(!dv || !tv){ $('ap-err').textContent = 'Pick a day and time.'; return; }
      // the time typed is Houston time
      var probe = new Date(dv + 'T' + tv + ':00Z'), off = (new Date(probe.toLocaleString('en-US', TZ)) - new Date(probe.toLocaleString('en-US', { timeZone: 'UTC' }))) / 60000;
      var start = new Date(probe.getTime() - off * 60000);
      var s = $('ap-save'); s.disabled = true; s.textContent = 'Booking…';
      fn({ action: 'create', contact_id: c.id, start: start.toISOString(), minutes: +$('ap-m').value, type_id: +$('ap-ty').value,
           location: $('ap-l').value, note: $('ap-n').value, invite: $('ap-team').checked ? 'team' : 'owner' }).then(function(j){
        if(!j || !j.ok){ s.disabled = false; s.textContent = 'Book it'; $('ap-err').textContent = (j && j.error) || 'Could not book it. Try again.'; return; }
        close(); toast('Booked in Follow Up Boss ✓'); if(done) done(j); if(loaded) load();
      });
    });
  }

  /* ---------- the client profile card ---------- */
  function cardHtml(list, L){
    list = list || [];
    var up = list.filter(function(r){ return r.status === 'upcoming'; }).sort(function(a, b){ return new Date(a.start_at) - new Date(b.start_at); });
    var past = list.filter(function(r){ return r.status !== 'upcoming'; });
    return '<div class="pc" id="pf-appts"><h3>Appointments' + (list.length ? ' (' + list.length + ')' : '') + ' <button type="button" class="add" data-a="apbook" aria-label="Book an appointment">+</button></h3>' +
      (L ? lolaHtml(L) : '') +
      (list.length ? up.concat(past).slice(0, 8).map(function(r){ return rowHtml(r, true); }).join('') : '<div class="none">No appointments in the last 60 days. Tap + to book one: it goes on the FUB calendar too.</div>') + '</div>';
  }

  document.addEventListener('click', function(e){
    var b = e.target.closest('[data-ap]'); if(!b) return;
    var row = b.closest('.ap-r'), r = row ? find(row.getAttribute('data-id')) : null;
    var k = b.getAttribute('data-ap');
    if(k === 'prof'){ e.preventDefault(); if(r && r.contact_id && o && o.openProfile) o.openProfile(r.contact_id); return; }
    if(!r) return;
    if(k === 'out') outcome(r, function(x){ if(o && o.onChange) o.onChange(x); });
    if(k === 'ref'){ b.disabled = true; b.textContent = '…'; fn({ action: 'refresh', id: r.id }).then(function(j){ if(j && j.ok){ r.follow = j.follow; if(!r.outcome) r.status = j.follow && j.follow.last_at ? 'followed' : r.status; } paint(); if(o && o.onChange) o.onChange(r); }); }
  });
  document.addEventListener('click', function(e){
    var t = e.target.closest('.ap-tile'); if(t && $('t-appts') && $('t-appts').contains(t)){
      view = t.getAttribute('data-v'); paint(); return; }
    var g = e.target.closest('.ap-tg'); if(g && $('t-appts') && $('t-appts').contains(g)){
      if(g.getAttribute('data-tg') === 'hot') hotOnly = !hotOnly; else view = view === 'all' ? 'none' : 'all'; paint(); }
  });
  document.addEventListener('input', function(e){ if(e.target && e.target.id === 'ap-q'){ q = e.target.value; var pos = e.target.selectionStart; paint(); var i = $('ap-q'); if(i){ i.focus(); try{ i.setSelectionRange(pos, pos); }catch(x){} } } });
  document.addEventListener('change', function(e){ if(e.target && e.target.id === 'ap-who'){ who = e.target.value; paint(); } });

  window.JagAppts = {
    // opts: { rpc, me, openProfile(id), onCount(n), toast(m), onChange(row) }
    init: function(opts){ o = opts; },
    load: load, outcome: outcome, book: book, cardHtml: cardHtml, rowHtml: rowHtml,
    remember: function(list){ (list || []).forEach(function(r){ extra[String(r.id)] = r; }); }
  };
})();
