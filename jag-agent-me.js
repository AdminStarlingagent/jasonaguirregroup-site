/* ============================================================
   Agent Hub → "My profile": the agent's public page (jasonaguirregroup.company/agente/<code>)
   - photo, title, bio (ES/EN), languages, areas, HAR login ID (for "homes sold"), license
   - videos: record on the phone, upload here; Jason approves them before they go public
     (on the profile and mixed into JAG Reels). Jason's own uploads go live right away.
   - Jason (approver): "Waiting for your OK" queue + edit anyone's profile
   window.JagAgentMe.init({ rpc, token, me, toast, onCount }) · .load()
   ============================================================ */
(function(){
  var BASE = 'https://nyaxywghbpphjhwcmspd.supabase.co', KEY = 'sb_publishable_a3LN_l283LN8J-bJTEO8hQ_U40t09eh', BUCKET = 'agent-videos';
  var MAX_MB = 200, MAX_SEC = 95;
  var O = {}, D = null, editCode = null, busy = false;
  var KINDS = [['intro', 'Introduce yourself'], ['tour', 'Home tour'], ['area', 'Neighborhood / area'], ['tip', 'Buying tip'], ['closing', 'Closing / keys day'], ['other', 'Other']];
  var STATUS = { pending: ['Waiting for Jason', 'pend'], approved: ['Live', 'live'], rejected: ['Not approved', 'rej'] };
  function $(id){ return document.getElementById(id); }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(m){ if(O.toast) O.toast(m); }
  function rnd(n){ var a = new Uint8Array(n), s = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789', o = ''; crypto.getRandomValues(a); for(var i = 0; i < n; i++) o += s[a[i] % s.length]; return o; }

  var css = '.am{display:flex;flex-direction:column;gap:14px;padding:14px 0 40px}' +
    '.am-card{background:var(--paper,#fff);border-radius:18px;padding:16px;box-shadow:0 1px 3px rgba(0,0,0,.05)}' +
    '.am-card h3{margin:0 0 4px;font-size:17px;font-weight:800}.am-card>p{margin:0 0 12px;color:var(--muted);font-size:14px}' +
    '.am-top{display:flex;gap:14px;align-items:center;flex-wrap:wrap}' +
    '.am-av{width:84px;height:84px;border-radius:50%;background:#2c2b33 center/cover no-repeat;display:grid;place-items:center;color:#fff;font-weight:800;font-size:30px;flex:none}' +
    '.am-top b{font-size:18px;display:block}.am-top small{color:var(--muted);font-size:13.5px}' +
    '.am-links{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}' +
    '.am-b{border:0;border-radius:99px;background:var(--red,#c8102e);color:#fff;font-weight:700;font-size:14px;padding:10px 15px;text-decoration:none;display:inline-flex;align-items:center;gap:6px;cursor:pointer}' +
    '.am-b.g{background:var(--card,#f5f5f7);color:var(--ink,#17161c)}.am-b.ok{background:#1a5c31}.am-b:disabled{opacity:.55}' +
    '.am-f{display:grid;gap:12px}.am-f label{display:flex;flex-direction:column;gap:5px;font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}' +
    '.am-f input,.am-f textarea,.am-f select{border:2px solid var(--line,#e8e8ec);border-radius:12px;padding:10px 12px;font:inherit;font-size:15px;font-weight:500;text-transform:none;letter-spacing:0;color:var(--ink,#17161c);background:var(--paper,#fff);width:100%;box-sizing:border-box}' +
    '.am-f textarea{min-height:110px;resize:vertical}.am-f small{text-transform:none;letter-spacing:0;font-weight:500;font-size:12.5px}' +
    '.am-2{display:grid;grid-template-columns:1fr 1fr;gap:10px}@media(max-width:560px){.am-2{grid-template-columns:1fr}}' +
    '.am-ck{display:flex;gap:14px;flex-wrap:wrap;text-transform:none!important;letter-spacing:0!important;font-size:14.5px!important;color:var(--ink)!important}' +
    '.am-ck span{display:flex;gap:6px;align-items:center;font-weight:600}.am-ck input{width:18px;height:18px;accent-color:var(--red,#c8102e)}' +
    '.am-vg{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px}' +
    '.am-v{border-radius:14px;overflow:hidden;background:#111;position:relative;aspect-ratio:9/16}' +
    '.am-v video,.am-v img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}' +
    '.am-v .s{position:absolute;top:6px;left:6px;font-size:11px;font-weight:800;padding:3px 8px;border-radius:99px;color:#fff;background:rgba(0,0,0,.6)}' +
    '.am-v .s.live{background:#1a5c31}.am-v .s.pend{background:#b26b00}.am-v .s.rej{background:#a30d26}' +
    '.am-v .t{position:absolute;left:0;right:0;bottom:0;padding:22px 8px 8px;background:linear-gradient(transparent,rgba(0,0,0,.8));color:#fff;font-size:12px;font-weight:700;line-height:1.25}' +
    '.am-v .x{position:absolute;top:4px;right:4px;width:28px;height:28px;border-radius:50%;border:0;background:rgba(0,0,0,.6);color:#fff;font-size:16px;line-height:1;cursor:pointer}' +
    '.am-v .n{display:block;font-weight:500;opacity:.85;margin-top:2px}' +
    '.am-q{display:grid;grid-template-columns:150px 1fr;gap:12px;align-items:start;padding:12px 0;border-top:1px solid var(--line,#e8e8ec)}' +
    '@media(max-width:560px){.am-q{grid-template-columns:110px 1fr}}' +
    '.am-q video{width:100%;aspect-ratio:9/16;object-fit:cover;border-radius:12px;background:#111}' +
    '.am-q b{display:block}.am-q small{color:var(--muted);display:block;margin:2px 0 8px}' +
    '.am-up{border:2px dashed var(--line,#e8e8ec);border-radius:16px;padding:18px;text-align:center;cursor:pointer;display:block}' +
    '.am-up b{display:block;font-size:16px}.am-up small{color:var(--muted)}' +
    '.am-prog{height:8px;border-radius:99px;background:var(--card,#f5f5f7);overflow:hidden}.am-prog i{display:block;height:100%;width:0;background:var(--red,#c8102e);transition:width .2s}' +
    '.am-warn{background:#fff4e0;border-radius:12px;padding:10px 12px;font-size:13.5px;color:#7a4a00}' +
    '.am-tips{margin:8px 0 0;padding-left:18px;color:var(--muted);font-size:13.5px}' +
    '.am-sel{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.am-sel select{border:2px solid var(--line);border-radius:12px;padding:8px 10px;font:inherit;font-weight:700}';

  function init(o){
    O = o || {};
    if(!document.getElementById('am-css')){ var s = document.createElement('style'); s.id = 'am-css'; s.textContent = css; document.head.appendChild(s); }
  }
  function load(){
    var el = $('t-profile'); if(!el) return;
    if(!D) el.innerHTML = '<div class="am"><div class="am-card">Loading your profile…</div></div>';
    return O.rpc('jag_my_profile_get', { p_code: editCode }).then(function(j){
      if(!j || !j.ok){ el.innerHTML = '<div class="am"><div class="am-card">Your profile isn’t set up yet. Ask Jason to turn it on.</div></div>'; return; }
      D = j; paint();
      if(O.onCount) O.onCount(j.approver ? (j.queue || []).length : 0);
    }).catch(function(){ el.innerHTML = '<div class="am"><div class="am-card">Could not load your profile. Check your connection.</div></div>'; });
  }

  function paint(){
    var a = D.agent, el = $('t-profile'), url = 'https://jasonaguirregroup.company/agente/' + a.code, mine = a.code === D.me;
    var who = mine ? 'Your' : esc(a.first_name) + '’s';
    var photo = /^https:\/\//.test(a.photo_url || '') ? 'style="background-image:url(\'' + esc(a.photo_url) + '\')"' : '';
    var q = D.approver ? (D.queue || []) : [];
    el.innerHTML = '<div class="am">' +
      (D.approver ? '<div class="am-card"><div class="am-sel"><b>Edit profile of</b><select id="am-who">' + (D.team || []).map(function(m){
        return '<option value="' + esc(m.code) + '"' + (m.code === a.code ? ' selected' : '') + '>' + esc(m.name) + (m.profile_on ? '' : ' (hidden)') + '</option>'; }).join('') + '</select></div></div>' : '') +
      (q.length ? '<div class="am-card"><h3>Waiting for your OK (' + q.length + ')</h3><p>Videos the team uploaded. Once you approve one it shows on their profile and in JAG Reels.</p>' + q.map(function(v){
        return '<div class="am-q" data-id="' + esc(v.id) + '"><video src="' + esc(v.url) + '" controls playsinline preload="metadata"' + (v.poster ? ' poster="' + esc(v.poster) + '"' : '') + '></video><div>' +
          '<b>' + esc(v.agent.name) + '</b><small>' + esc(kindName(v.kind)) + (v.area ? ' · ' + esc(v.area) : '') + (v.duration ? ' · ' + Math.round(v.duration) + ' s' : '') + '</small>' +
          (v.title ? '<div style="margin-bottom:10px">“' + esc(v.title) + '”</div>' : '') +
          (v.codec === 'hevc' ? '<div class="am-warn" style="margin-bottom:10px">iPhone “High Efficiency” video: check it plays here. Some Android phones may not play it.</div>' : '') +
          '<div class="am-links"><button class="am-b ok" type="button" data-rv="1">Approve</button><button class="am-b g" type="button" data-rv="0">Not this one</button></div></div></div>'; }).join('') + '</div>' : '') +
      '<div class="am-card"><div class="am-top"><div class="am-av" ' + photo + '>' + (photo ? '' : esc(String(a.first_name || 'J').charAt(0))) + '</div><div>' +
        '<b>' + esc(a.name) + '</b><small>' + esc(a.title_en || '') + ' · ' + (a.profile_on ? 'Public profile is on' : 'Profile is hidden') + ' · ' + (D.closed || 0) + ' homes sold on HAR</small>' +
        '<div class="am-links"><a class="am-b" href="' + url + '" target="_blank" rel="noopener">See ' + (mine ? 'my' : 'the') + ' profile</a>' +
        '<button class="am-b g" type="button" id="am-copy">Copy link</button><label class="am-b g" style="cursor:pointer">' + (photo ? 'Change photo' : 'Add photo') + '<input type="file" id="am-photo" accept="image/*" hidden></label></div></div></div></div>' +

      '<div class="am-card"><h3>' + who + ' videos</h3><p>Short vertical videos (up to 90 seconds) recorded on your phone: introduce yourself, tour a home, show a neighborhood, share a tip, celebrate a closing. ' +
        (D.approver ? 'Yours go live right away.' : 'Jason approves each one before it goes public.') + '</p>' +
        '<label class="am-up" id="am-drop"><b>＋ Upload a video</b><small>MP4 or MOV, vertical, up to 90 s and 200 MB</small><input type="file" id="am-file" accept="video/mp4,video/quicktime,video/webm,video/*" hidden></label>' +
        '<div id="am-new"></div>' +
        ((D.videos || []).length ? '<div class="am-vg" style="margin-top:14px">' + D.videos.map(function(v){ var st = STATUS[v.status] || [v.status, ''];
          return '<div class="am-v" data-id="' + esc(v.id) + '">' + (v.poster ? '<img src="' + esc(v.poster) + '" alt="">' : '<video src="' + esc(v.url) + '#t=0.5" muted playsinline preload="metadata"></video>') +
            '<span class="s ' + st[1] + '">' + esc(st[0]) + '</span><button class="x" type="button" data-rm title="Remove">×</button>' +
            '<div class="t">' + esc(v.title || kindName(v.kind)) + (v.status === 'approved' ? '<span class="n">' + (v.views || 0) + ' views</span>' : '') + (v.status === 'rejected' && v.note ? '<span class="n">' + esc(v.note) + '</span>' : '') + '</div></div>'; }).join('') + '</div>' : '') +
        '<ul class="am-tips"><li>Hold the phone upright and film in daylight.</li><li>Say your name and the area in the first 3 seconds.</li><li>On iPhone, set Settings › Camera › Formats › <b>Most Compatible</b> so every phone can play it.</li></ul></div>' +

      '<div class="am-card"><h3>' + who + ' public profile</h3><p>What buyers see on ' + (mine ? 'your' : 'the') + ' page. Spanish first; English is shown when the visitor picks EN.</p><form class="am-f" id="am-form">' +
        '<div class="am-2"><label>Title (Spanish)<input name="title_es" maxlength="60" value="' + esc(a.title_es) + '"></label><label>Title (English)<input name="title_en" maxlength="60" value="' + esc(a.title_en) + '"></label></div>' +
        '<label>About ' + (mine ? 'you' : esc(a.first_name)) + ' (Spanish)<textarea name="bio_es" maxlength="1200">' + esc(a.bio_es) + '</textarea></label>' +
        '<label>About ' + (mine ? 'you' : esc(a.first_name)) + ' (English)<textarea name="bio_en" maxlength="1200">' + esc(a.bio_en) + '</textarea></label>' +
        '<label>Languages<span class="am-ck">' + [['es', 'Spanish'], ['en', 'English'], ['pt', 'Portuguese'], ['fr', 'French']].map(function(l){
          return '<span><input type="checkbox" name="lang" value="' + l[0] + '"' + ((a.langs || []).indexOf(l[0]) >= 0 ? ' checked' : '') + '>' + l[1] + '</span>'; }).join('') + '</span></label>' +
        '<label>Areas ' + (mine ? 'you work' : 'they work') + ' in<input name="areas" value="' + esc((a.areas || []).join(', ')) + '" placeholder="Katy, Cypress, 77083"><small>Cities or ZIP codes, separated by commas. Homes you’ve sold add their cities automatically.</small></label>' +
        '<div class="am-2"><label>HAR login ID<input name="har_ids" value="' + esc((a.har_ids || []).join(', ')) + '" placeholder="e.g. JasonAguir" autocapitalize="off"><small>Your HAR MLS user ID. It fills “homes sold” from HAR.</small></label>' +
        '<label>TREC license #<input name="license_no" value="' + esc(a.license_no) + '" inputmode="numeric"></label></div>' +
        '<div class="am-2"><label>Licensed since (year)<input name="licensed_year" value="' + esc(a.licensed_year) + '" inputmode="numeric" maxlength="4"></label>' +
        (D.approver ? '<label>Public profile<select name="profile_on"><option value="true"' + (a.profile_on ? ' selected' : '') + '>On</option><option value="false"' + (a.profile_on ? '' : ' selected') + '>Hidden</option></select></label>' : '<span></span>') + '</div>' +
        '<div class="am-links"><button class="am-b" type="submit">Save profile</button></div></form></div>' +
      '</div>';
  }
  function kindName(k){ for(var i = 0; i < KINDS.length; i++) if(KINDS[i][0] === k) return KINDS[i][1]; return 'Video'; }

  /* ---------- save profile ---------- */
  function saveForm(f){
    var g = function(n){ return (f.elements[n] && f.elements[n].value || '').trim(); };
    var list = function(n){ return g(n).split(/[,;\n]+/).map(function(x){ return x.trim(); }).filter(Boolean); };
    var p = { title_es: g('title_es'), title_en: g('title_en'), bio_es: g('bio_es'), bio_en: g('bio_en'),
      langs: [].slice.call(f.querySelectorAll('[name=lang]:checked')).map(function(x){ return x.value; }),
      areas: list('areas'), har_ids: list('har_ids'), license_no: g('license_no'), licensed_year: g('licensed_year') };
    if(f.elements.profile_on) p.profile_on = f.elements.profile_on.value === 'true';
    var harBefore = (D.agent.har_ids || []).join(','), btn = f.querySelector('[type=submit]'); btn.disabled = true;
    O.rpc('jag_my_profile_save', { p: p, p_code: editCode }).then(function(j){
      btn.disabled = false;
      if(!j || !j.ok){ toast('Could not save. Try again.'); return; }
      toast('Profile saved ✓');
      if(p.har_ids.join(',') !== harBefore && p.har_ids.length){ toast('Saved ✓ Looking up your sales on HAR…'); syncSold().then(load); } else load();
    }).catch(function(){ btn.disabled = false; toast('Could not save. Check your connection.'); });
  }
  function syncSold(){
    return O.token().then(function(tk){
      return fetch(BASE + '/functions/v1/jag-agent-profile', { method: 'POST', headers: { Authorization: 'Bearer ' + tk, apikey: KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync_sold', code: D.agent.code }) }).then(function(r){ return r.json(); });
    }).then(function(j){ var s = j && j.stats && j.stats[D.agent.code]; toast(s ? 'Found ' + (s.buyer + s.list) + ' homes sold on HAR' : 'No sales found for that HAR ID'); }).catch(function(){});
  }

  /* ---------- uploads (straight to storage, with progress) ---------- */
  function put(path, blob, type, onProg){
    return O.token().then(function(tk){
      return new Promise(function(res, rej){
        var x = new XMLHttpRequest();
        x.open('POST', BASE + '/storage/v1/object/' + BUCKET + '/' + path);
        x.setRequestHeader('Authorization', 'Bearer ' + tk); x.setRequestHeader('apikey', KEY);
        x.setRequestHeader('Content-Type', type); x.setRequestHeader('x-upsert', 'false'); x.setRequestHeader('cache-control', 'max-age=31536000');
        if(onProg) x.upload.onprogress = function(e){ if(e.lengthComputable) onProg(e.loaded / e.total); };
        x.onload = function(){ if(x.status >= 200 && x.status < 300) res(true); else rej(new Error(x.status + ' ' + (x.responseText || '').slice(0, 160))); };
        x.onerror = function(){ rej(new Error('network')); };
        x.send(blob);
      });
    });
  }
  /* look inside the file for the video codec: iPhone "High Efficiency" = HEVC (hvc1/hev1), most phones = H.264 (avc1) */
  function sniffCodec(file){
    var slice = function(a, b){ return file.slice(a, b).arrayBuffer(); };
    var size = file.size, n = Math.min(size, 4 << 20);
    return Promise.all([slice(0, n), slice(Math.max(0, size - n), size)]).then(function(bufs){
      var s = ''; bufs.forEach(function(b){ var u = new Uint8Array(b); for(var i = 0; i < u.length; i++){ var c = u[i]; s += (c > 31 && c < 127) ? String.fromCharCode(c) : '.'; } });
      return /hvc1|hev1/.test(s) ? 'hevc' : /avc1/.test(s) ? 'h264' : /vp09|vp08|av01/.test(s) ? 'vp' : '';
    }).catch(function(){ return ''; });
  }
  /* duration, size and a cover frame (when this browser can decode the video) */
  function probe(file){
    return new Promise(function(res){
      var v = document.createElement('video'), url = URL.createObjectURL(file), done = false;
      var fin = function(o){ if(done) return; done = true; res(o); setTimeout(function(){ URL.revokeObjectURL(url); }, 2000); };
      v.preload = 'metadata'; v.muted = true; v.playsInline = true; v.src = url;
      v.onloadedmetadata = function(){
        var o = { duration: v.duration, w: v.videoWidth, h: v.videoHeight, poster: null };
        if(!v.videoWidth){ fin(o); return; }
        v.currentTime = Math.min(1, (v.duration || 2) / 3);
        v.onseeked = function(){
          try{ var W = 540, H = Math.round(W * v.videoHeight / v.videoWidth), c = document.createElement('canvas'); c.width = W; c.height = H;
            c.getContext('2d').drawImage(v, 0, 0, W, H); c.toBlob(function(b){ o.poster = b; fin(o); }, 'image/jpeg', .8); }catch(e){ fin(o); }
        };
        setTimeout(function(){ fin(o); }, 4000);
      };
      v.onerror = function(){ fin({ duration: null, w: null, h: null, poster: null, undecodable: true }); };
      setTimeout(function(){ fin({ duration: null, w: null, h: null, poster: null }); }, 8000);
    });
  }
  function chooseVideo(file){
    var box = $('am-new'); if(!file || busy) return;
    if(file.size > MAX_MB * 1048576){ box.innerHTML = '<div class="am-warn">That video is ' + Math.round(file.size / 1048576) + ' MB. The limit is ' + MAX_MB + ' MB: trim it or record a shorter one.</div>'; return; }
    box.innerHTML = '<p style="color:var(--muted);margin:12px 0 0">Checking the video…</p>';
    Promise.all([probe(file), sniffCodec(file)]).then(function(r){
      var m = r[0], codec = r[1];
      if(m.duration && m.duration > MAX_SEC){ box.innerHTML = '<div class="am-warn" style="margin-top:12px">That video is ' + Math.round(m.duration) + ' seconds. Keep it to 90 seconds or less: short videos get watched to the end.</div>'; return; }
      var wide = m.w && m.h && m.w > m.h;
      box.innerHTML = '<form class="am-f" id="am-vf" style="margin-top:14px">' +
        (codec === 'hevc' ? '<div class="am-warn">This is an iPhone “High Efficiency” (HEVC) video. iPhones play it, but some Android phones can’t. For your next videos: Settings › Camera › Formats › <b>Most Compatible</b>. You can still upload this one.</div>' : '') +
        (wide ? '<div class="am-warn">This video is horizontal. Vertical videos fill the whole phone screen; horizontal ones get cropped on the sides.</div>' : '') +
        '<div class="am-2"><label>What is it?<select name="kind">' + KINDS.map(function(k){ return '<option value="' + k[0] + '">' + k[1] + '</option>'; }).join('') + '</select></label>' +
        '<label>Language<select name="lang"><option value="es">Spanish</option><option value="en">English</option></select></label></div>' +
        '<label>Caption<input name="title" maxlength="120" placeholder="Ej: Casas nuevas en Katy desde $250K"></label>' +
        '<label>Area (city or ZIP)<input name="area" maxlength="40" placeholder="Katy"><small>Buyers searching that area see this video first in JAG Reels.</small></label>' +
        '<div class="am-prog" hidden><i></i></div><div class="am-links"><button class="am-b" type="submit">' + (D.approver ? 'Upload and publish' : 'Upload for Jason’s OK') + '</button><button class="am-b g" type="button" id="am-vx">Cancel</button></div></form>';
      $('am-vx').onclick = function(){ box.innerHTML = ''; $('am-file').value = ''; };
      $('am-vf').onsubmit = function(e){ e.preventDefault(); upload(file, m, codec, e.target); };
    });
  }
  function upload(file, m, codec, f){
    if(busy) return; busy = true;
    var code = D.agent.code, id = rnd(20), ext = /quicktime|\.mov$/i.test(file.type + ' ' + file.name) ? 'mov' : /webm/i.test(file.type) ? 'webm' : 'mp4';
    var path = code + '/' + id + '.' + ext, poster = m.poster ? code + '/' + id + '.jpg' : null;
    var prog = f.querySelector('.am-prog'), bar = prog.firstChild, btn = f.querySelector('[type=submit]'); prog.hidden = false; btn.disabled = true; btn.textContent = 'Uploading… 0%';
    var type = file.type || (ext === 'mov' ? 'video/quicktime' : 'video/mp4');
    put(path, file, type, function(p){ bar.style.width = Math.round(p * 100) + '%'; btn.textContent = 'Uploading… ' + Math.round(p * 100) + '%'; })
      .then(function(){ return poster ? put(poster, m.poster, 'image/jpeg').catch(function(){ poster = null; }) : null; })
      .then(function(){ return O.rpc('jag_video_add', { p: { path: path, poster: poster, kind: f.elements.kind.value, title: f.elements.title.value, area: f.elements.area.value,
        lang: f.elements.lang.value, codec: codec, duration: m.duration ? String(Math.round(m.duration * 10) / 10) : null, w: m.w ? String(m.w) : null, h: m.h ? String(m.h) : null, size: String(file.size) } }); })
      .then(function(j){
        busy = false;
        if(!j || !j.ok) throw new Error('save');
        $('am-new').innerHTML = ''; toast(j.status === 'approved' ? 'Video is live ✓' : 'Uploaded ✓ Jason will review it.'); load();
      })
      .catch(function(e){ busy = false; btn.disabled = false; btn.textContent = 'Try again';
        var msg = /413|too large|exceeded/i.test(String(e.message)) ? 'That file is too big for the server. Record a shorter video.' : 'The upload didn’t finish. Check your connection and try again.';
        if(!f.querySelector('.am-err')) f.insertAdjacentHTML('beforeend', '<div class="am-warn am-err">' + msg + '</div>'); });
  }
  function uploadPhoto(file){
    if(!file) return;
    var img = new Image(), url = URL.createObjectURL(file);
    img.onload = function(){
      var S = 720, s = Math.min(img.width, img.height), c = document.createElement('canvas'); c.width = S; c.height = S;
      c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, S, S);
      URL.revokeObjectURL(url);
      c.toBlob(function(b){
        var path = D.agent.code + '/photo-' + rnd(12) + '.jpg'; toast('Uploading photo…');
        put(path, b, 'image/jpeg').then(function(){ return O.rpc('jag_my_profile_photo', { p_path: path, p_code: editCode }); })
          .then(function(j){ if(!j || !j.ok) throw 0; toast('Photo updated ✓'); load(); }).catch(function(){ toast('Could not upload the photo. Try again.'); });
      }, 'image/jpeg', .86);
    };
    img.onerror = function(){ toast('That photo can’t be opened here. Try a JPG or PNG.'); };
    img.src = url;
  }

  /* ---------- clicks ---------- */
  document.addEventListener('change', function(e){
    if(e.target.id === 'am-file') chooseVideo(e.target.files && e.target.files[0]);
    else if(e.target.id === 'am-photo') uploadPhoto(e.target.files && e.target.files[0]);
    else if(e.target.id === 'am-who'){ editCode = e.target.value === D.me ? null : e.target.value; D = null; load(); }
  });
  document.addEventListener('submit', function(e){ if(e.target.id === 'am-form'){ e.preventDefault(); saveForm(e.target); } });
  document.addEventListener('click', function(e){
    if(!D) return;
    if(e.target.id === 'am-copy'){ var u = 'https://jasonaguirregroup.company/agente/' + D.agent.code;
      (navigator.clipboard ? navigator.clipboard.writeText(u) : Promise.reject()).then(function(){ toast('Link copied ✓'); }).catch(function(){ prompt('Profile link', u); }); return; }
    var rv = e.target.closest('[data-rv]');
    if(rv){ var q = rv.closest('.am-q'), ok = rv.getAttribute('data-rv') === '1', note = null;
      if(!ok){ note = prompt('Why not? (optional — the agent sees this)', ''); if(note === null) return; }
      rv.disabled = true;
      O.rpc('jag_video_review', { p_id: q.getAttribute('data-id'), p_ok: ok, p_note: note }).then(function(j){ toast(j && j.ok ? (ok ? 'Approved ✓ It’s live.' : 'Marked not approved.') : 'Could not save.'); load(); }).catch(function(){ toast('Could not save.'); }); return; }
    var rm = e.target.closest('[data-rm]');
    if(rm){ var v = rm.closest('.am-v'); if(!confirm('Remove this video from the profile and JAG Reels?')) return;
      O.rpc('jag_video_remove', { p_id: v.getAttribute('data-id') }).then(function(j){ toast(j && j.ok ? 'Removed' : 'Could not remove.'); load(); }).catch(function(){ toast('Could not remove.'); }); }
  });

  window.JagAgentMe = { init: init, load: load };
})();
