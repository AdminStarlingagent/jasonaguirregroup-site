/* JAG field helpers for the search page (/h) and the offer page (/o).
   JAGField.call(action, key, data) talks to the n8n "JAG Ops · Field API" webhook.
   The key is the code from the link the team got by text; nothing else is sent or stored.
   It posts a plain form so the browser skips the CORS preflight.

   JAGField.picker(el, opts) draws a Follow Up Boss client picker into el:
   the teammate's most recently active clients first, or a name search.
   The list only shows first name + last initial; full contact details are fetched
   server-side for the one client picked. Follow Up Boss is read-only here. */
(function(){
  'use strict';
  var URL_FIELD = 'https://toomuchtaco.app.n8n.cloud/webhook/jag-field';

  function call(action, key, data){
    var body = new URLSearchParams();
    body.set('action', action); body.set('key', key || ''); body.set('data', JSON.stringify(data || {}));
    return fetch(URL_FIELD, { method: 'POST', body: body, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' })
      .then(function(r){ if(!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function(j){ if(!j || typeof j !== 'object') throw new Error('empty answer'); return j; });
  }

  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function ago(iso){
    var t = Date.parse(iso || ''); if(!t) return '';
    var m = Math.max(0, Math.round((Date.now() - t) / 60000));
    if(m < 60) return m <= 1 ? 'active just now' : 'active ' + m + ' min ago';
    var h = Math.round(m / 60); if(h < 24) return 'active ' + h + (h === 1 ? ' hour ago' : ' hours ago');
    var d = Math.round(h / 24); if(d < 45) return 'active ' + d + (d === 1 ? ' day ago' : ' days ago');
    return 'active ' + new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  }

  var css = '' +
    '.cp-search{width:100%;font-size:16px;border:1px solid var(--hair,#dfe1e6);background:#f8f9fa;border-radius:10px;padding:11px 12px;min-height:46px}' +
    '.cp-search:focus{background:#fff;border-color:var(--ink,#17161c);outline:none;box-shadow:0 0 0 3px rgba(23,22,28,.08)}' +
    '.cp-note{font-size:12.5px;font-weight:600;color:var(--soft,#8b8a94);margin:8px 2px 6px;min-height:1em}' +
    '.cp-list{display:grid;gap:6px}' +
    '.cp-row{display:flex;gap:12px;align-items:center;width:100%;text-align:left;border:1px solid var(--hair,#dfe1e6);background:#fff;border-radius:12px;padding:10px 12px;cursor:pointer;font:inherit;color:inherit;min-height:52px}' +
    '.cp-row .cp-av{flex:0 0 34px;height:34px;border-radius:99px;background:var(--canvas,#eef0f3);display:grid;place-items:center;font-weight:800;font-size:13px;color:var(--graphite,#5d5c66)}' +
    '.cp-row b{display:block;font-size:15px;font-weight:800}' +
    '.cp-row small{display:block;font-size:12.5px;font-weight:600;color:var(--graphite,#5d5c66)}' +
    '.cp-row.on{border-color:var(--ink,#17161c);box-shadow:inset 0 0 0 1px var(--ink,#17161c)}' +
    '.cp-row.on .cp-av{background:var(--ink,#17161c);color:#fff}' +
    '.cp-row.skip b{font-weight:700;color:var(--graphite,#5d5c66)}';

  function picker(el, opts){
    opts = opts || {};
    if(!document.getElementById('cp-style')){
      var st = document.createElement('style'); st.id = 'cp-style'; st.textContent = css; document.head.appendChild(st);
    }
    var state = { sel: null, timer: null, seq: 0, list: [] };
    el.innerHTML = '<input class="cp-search" type="search" enterkeyhint="search" autocomplete="off" spellcheck="false" ' +
      'placeholder="Search Follow Up Boss by name" aria-label="Search Follow Up Boss by name">' +
      '<p class="cp-note" role="status"></p><div class="cp-list"></div>';
    var input = el.querySelector('.cp-search'), note = el.querySelector('.cp-note'), list = el.querySelector('.cp-list');

    function draw(){
      var rows = state.list.map(function(c){
        var on = state.sel && String(state.sel.id) === String(c.id);
        var initials = c.label.split(/\s+/).map(function(w){ return w.charAt(0); }).join('').slice(0, 2).toUpperCase();
        return '<button type="button" class="cp-row' + (on ? ' on' : '') + '" data-id="' + esc(c.id) + '" aria-pressed="' + !!on + '">' +
          '<span class="cp-av" aria-hidden="true">' + esc(on ? '✓' : initials) + '</span>' +
          '<span><b>' + esc(c.label) + '</b><small>' + esc([c.stage, ago(c.last)].filter(Boolean).join(', ')) + '</small></span></button>';
      });
      if(opts.allowSkip) rows.push('<button type="button" class="cp-row skip' + (state.sel === false ? ' on' : '') + '" data-id="" aria-pressed="' + (state.sel === false) + '">' +
        '<span class="cp-av" aria-hidden="true">' + (state.sel === false ? '✓' : '+') + '</span><span><b>Add the buyer later</b><small>Type the names on the offer page.</small></span></button>');
      list.innerHTML = rows.join('');
    }
    function load(q){
      var seq = ++state.seq;
      note.textContent = q ? 'Searching Follow Up Boss…' : 'Loading your recent clients…';
      call('clients', opts.key, { q: q || '' }).then(function(r){
        if(seq !== state.seq) return;
        if(!r.ok){ note.textContent = r.error || 'Follow Up Boss did not answer. Try again.'; state.list = []; draw(); return; }
        state.list = r.clients || [];
        note.textContent = state.list.length
          ? (r.scope === 'search' ? 'Matches in Follow Up Boss' : 'Your most recently active clients. Search for anyone else.')
          : (q ? 'No one in Follow Up Boss matches "' + q + '".' : 'No recent clients. Search by name.');
        draw();
      }).catch(function(){ if(seq === state.seq){ note.textContent = 'No connection to Follow Up Boss. Check your signal.'; } });
    }
    input.addEventListener('input', function(){
      clearTimeout(state.timer);
      var q = input.value.trim();
      state.timer = setTimeout(function(){ load(q.length >= 2 ? q : ''); }, q.length >= 2 ? 350 : 0);
    });
    list.addEventListener('click', function(e){
      var b = e.target.closest('.cp-row'); if(!b) return;
      var id = b.getAttribute('data-id');
      state.sel = id ? state.list.filter(function(c){ return String(c.id) === id; })[0] || null : false;
      draw();
      if(opts.onPick) opts.onPick(state.sel || null);
    });
    load('');
    return { selected: function(){ return state.sel || null; }, focus: function(){ input.focus(); } };
  }

  window.JAGField = { call: call, picker: picker, ago: ago };
})();
