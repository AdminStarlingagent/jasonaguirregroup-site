/* ============================================================
   JAG team: "Comenzar oferta" on a listing (signed-in team only, via the Agent Hub sign-in).
   A short set of questions → the usual offer draft (jasonaguirregroup.company/o#code), already
   filled with what HAR knows (legal description, county, HOA, MUD, listing agent + brokerage)
   and the answers. Optionally hands it to the TC (René): JAG-branded email with step-by-step
   prep instructions + a Follow Up Boss task (edge function jag-offer-tc).
   JagTeamOffer.box(listing) → HTML for the side panel; JagTeamOffer.bind(root, listing, lang)
   ============================================================ */
(function () {
  'use strict';
  var C = window.JAG_CRM || {}, BASE = String(C.url || '').replace(/\/+$/, ''), KEY = C.anonKey;
  var API = BASE + '/functions/v1/home-search';
  var lang = 'es', ov = null, clients = null;
  var T = {
    es: {
      team: 'Solo equipo JAG', h: 'Comenzar oferta', p: 'Contestas unas preguntas y queda el contrato TREC listo con los datos de HAR. René lo prepara para firmar.',
      go: 'Comenzar oferta', title: 'Oferta para ', har: 'De HAR (ya va en el contrato)', buyer: 'Comprador', pick: 'Cliente con cuenta (opcional)', pick0: 'Elegir…',
      names: 'Nombre(s) legal(es) completo(s)', names_h: 'Como van a firmar. Varios: "Ana López y Juan López".', email: 'Correo', phone: 'Teléfono',
      money: 'Precio y préstamo', price: 'Precio de la oferta', loan: 'Tipo de préstamo', down: 'Enganche (%)', conc: 'Concesión del vendedor ($)', conc_h: 'Para gastos de cierre del comprador. Vacío = ninguna.',
      earn: 'Earnest money ($)', ofee: 'Option fee ($)', odays: 'Días de opción', close: 'Fecha de cierre', titleco: 'Compañía de título', warr: 'Garantía de casa hasta ($)',
      tc: 'Mandar a René para preparar', tc_h: 'Le llega un correo JAG con todo y los pasos, y una tarea en Follow Up Boss.', note: 'Notas para René (opcional)',
      note_ph: 'Ej. el cliente firma el martes; agregar la pre-aprobación de Aron.', make: 'Crear la oferta', making: 'Creando…', cancel: 'Cancelar',
      done: 'Oferta creada', open: 'Abrir el borrador', left: 'Falta llenar:', none: 'No falta nada obligatorio.', sent: '✓ Enviada a ', sent2: '. Le llegó el correo con los pasos.',
      need: 'Escribe el nombre del comprador y el precio.', err: 'No se pudo crear. Revisa tu sesión del Agent Hub e intenta de nuevo.', yes: 'Sí', no: 'No',
      legal: 'Legal', county: 'Condado', hoa: 'HOA', mud: 'MUD / distrito', la: 'Agente del vendedor', bk: 'Brokerage', unknown: 'no aparece en HAR',
    },
    en: {
      team: 'JAG team only', h: 'Begin offer', p: 'Answer a few questions and the TREC contract is filled in with the HAR data. René prepares it for signing.',
      go: 'Begin offer', title: 'Offer for ', har: 'From HAR (already in the contract)', buyer: 'Buyer', pick: 'Client with an account (optional)', pick0: 'Choose…',
      names: 'Full legal name(s)', names_h: 'Exactly as they will sign. Several: "Ana López and Juan López".', email: 'Email', phone: 'Phone',
      money: 'Price and loan', price: 'Offer price', loan: 'Loan type', down: 'Down payment (%)', conc: 'Seller concession ($)', conc_h: 'Toward the buyer\'s closing costs. Blank = none.',
      earn: 'Earnest money ($)', ofee: 'Option fee ($)', odays: 'Option days', close: 'Closing date', titleco: 'Title company', warr: 'Home warranty up to ($)',
      tc: 'Send to René to prepare', tc_h: 'He gets a JAG email with everything and the steps, plus a Follow Up Boss task.', note: 'Notes for René (optional)',
      note_ph: 'E.g. client signs Tuesday; add the pre-approval from Aron.', make: 'Create the offer', making: 'Creating…', cancel: 'Cancel',
      done: 'Offer created', open: 'Open the draft', left: 'Still needed:', none: 'Nothing required is missing.', sent: '✓ Sent to ', sent2: '. The email with the steps is on its way.',
      need: 'Type the buyer\'s name and the price.', err: 'Could not create it. Check your Agent Hub sign-in and try again.', yes: 'Yes', no: 'No',
      legal: 'Legal', county: 'County', hoa: 'HOA', mud: 'MUD / district', la: 'Listing agent', bk: 'Brokerage', unknown: 'not on HAR',
    }
  };
  function t(k) { return (T[lang] || T.es)[k]; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function digits(p) { return String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); }
  function phone(p) { var d = digits(p); return d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : String(p || ''); }
  function me() { return window.JagShare && JagShare.me && JagShare.me(); }
  function rpc(name, args) {
    return JagShare.token().then(function (tk) {
      if (!tk) throw new Error('signin');
      return fetch(BASE + '/rest/v1/rpc/' + name, { method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' }, body: JSON.stringify(args || {}) });
    }).then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); });
  }
  function css() {
    if (document.getElementById('jto-css')) return;
    var s = document.createElement('style'); s.id = 'jto-css';
    s.textContent = '.jto-box{border:2px dashed #17161c;border-radius:18px;padding:16px;margin-bottom:14px;background:#fff}' +
      '.jto-box small{display:inline-block;font-size:10px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;background:#17161c;color:#fff;border-radius:99px;padding:4px 9px}' +
      '.jto-box h4{margin:10px 0 4px;font-size:17px}.jto-box p{margin:0 0 12px;font-size:13.5px;color:#5f5e68}' +
      '.jto-btn{display:block;width:100%;border:0;border-radius:12px;background:#17161c;color:#fff;font:inherit;font-weight:800;font-size:15px;padding:13px 12px;cursor:pointer}' +
      '.jto-ov{position:fixed;inset:0;background:rgba(15,14,20,.6);display:none;align-items:flex-start;justify-content:center;padding:14px;z-index:9600;overflow-y:auto}.jto-ov.on{display:flex}' +
      '.jto-m{background:#fff;border-radius:18px;width:100%;max-width:620px;margin:auto 0;position:relative;font-size:15px;color:#17161c}' +
      '.jto-hd{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:16px 20px;border-bottom:1px solid #e8e8ec;position:sticky;top:0;background:#fff;border-radius:18px 18px 0 0;z-index:2}' +
      '.jto-hd b{font-size:18px}.jto-x{border:0;background:#f5f5f7;width:38px;height:38px;border-radius:50%;font-size:20px;cursor:pointer;flex:none}' +
      '.jto-bd{padding:6px 20px 20px}.jto-bd h5{margin:18px 0 8px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#5f5e68}' +
      '.jto-har{background:#f6f5f3;border-radius:14px;padding:10px 14px;font-size:13.5px}.jto-har div{display:flex;gap:10px;padding:4px 0;border-bottom:1px solid #ebe9e5}.jto-har div:last-child{border:0}' +
      '.jto-har span{color:#5f5e68;flex:0 0 120px}.jto-har em{font-style:normal;color:#a30d26}' +
      '.jto-g{display:grid;grid-template-columns:1fr 1fr;gap:10px}.jto-g .full{grid-column:1/-1}' +
      '.jto-f label{display:block;font-size:13px;font-weight:700;margin:0 0 4px}.jto-f input,.jto-f select,.jto-f textarea{width:100%;box-sizing:border-box;border:1px solid #c9c8d0;border-radius:10px;padding:10px 12px;font:inherit;font-size:16px;background:#fff}' +
      '.jto-f textarea{min-height:70px;resize:vertical}.jto-f small{display:block;color:#85848d;font-size:12px;margin-top:3px}' +
      '.jto-chk{display:flex;gap:10px;align-items:flex-start;background:#fdecef;border-radius:12px;padding:12px;margin-top:14px;cursor:pointer}.jto-chk input{width:20px;height:20px;margin:2px 0 0;accent-color:#c8102e}.jto-chk small{display:block;color:#5f5e68}' +
      '.jto-ft{display:flex;gap:10px;justify-content:flex-end;padding:14px 20px;border-top:1px solid #e8e8ec;position:sticky;bottom:0;background:#fff;border-radius:0 0 18px 18px}' +
      '.jto-ft button,.jto-ft a{border:2px solid #c8102e;border-radius:12px;padding:11px 16px;font:inherit;font-weight:800;cursor:pointer;text-decoration:none;text-align:center}' +
      '.jto-ft .pri{background:#c8102e;color:#fff}.jto-ft .sec{background:#fff;color:#c8102e}' +
      '.jto-err{color:#a30d26;font-weight:700;margin:10px 0 0;font-size:14px}.jto-err:empty{display:none}' +
      '.jto-ok{text-align:center;padding:10px 0}.jto-ok h3{margin:6px 0;font-size:22px}.jto-ok ul{text-align:left;color:#a30d26;font-weight:700;margin:8px auto;max-width:420px}' +
      '@media(max-width:560px){.jto-g{grid-template-columns:1fr}.jto-ov{padding:0}.jto-m{border-radius:0;min-height:100%}.jto-har span{flex-basis:100px}}';
    document.head.appendChild(s);
  }

  /* what HAR gives us for the contract */
  function legal(desc, sub) {
    var s = String(desc || ''), out = { lot: '', block: '', addition: '' };
    var m = s.match(/\bL(?:O)?TS?\s*[:#]?\s*([0-9A-Z][0-9A-Z&,\- ]*?)\s*,?\s+B(?:LK|LOCK)\s*[:#]?\s*([0-9A-Z]+)\b,?\s*(.*)$/i);
    if (m) { out.lot = m[1].trim(); out.block = m[2].trim(); out.addition = m[3].trim(); }
    if (!out.addition && sub) out.addition = String(sub).trim();
    return out;
  }
  function facts(l, f) {
    f = f || {}; var a = l.address || {}, d = (f.details || l.details || {}), o = f.offer || {}, ag = ((f.agents || l.agents || [])[0]) || {};
    var lg = legal((f.lot || {}).legalDescription, o.subdivision || a.neighborhood);
    var br = ag.brokerage || {}, ba = br.address || {};
    var mud = (o.disclosures || []).some(function (x) { return /mud|pid|district/i.test(x); });
    return {
      address: [a.streetNumber, a.streetDirectionPrefix, a.streetName, a.streetSuffix, a.streetDirection].filter(Boolean).join(' ') + (a.unitNumber && a.unitNumber !== '0' ? ' #' + a.unitNumber : ''),
      city: a.city || '', zip: a.zip || '', county: o.county || a.area || '', year_built: d.yearBuilt || '',
      lot: lg.lot, block: lg.block, addition: lg.addition, legal_raw: (f.lot || {}).legalDescription || '',
      hoa: o.hoa === true ? 'true' : o.hoa === false ? 'false' : (parseFloat(d.HOAFee) > 0 ? 'true' : ''),
      hoa_name: o.hoaName || '', hoa_phone: o.hoaPhone ? phone(o.hoaPhone) : '', hoa_fee: o.hoaFee ? '$' + Math.round(o.hoaFee).toLocaleString('en-US') + (o.hoaFreq ? ' ' + freq(o.hoaFreq) : '') : '',
      district_notices: mud ? 'MUD' : '',
      listing_agent: o.agent || ag.name || '', listing_agent_email: o.agentEmail || ag.email || '',
      listing_agent_phone: phone(o.agentPhone || (ag.phones || [])[0] || ''), listing_agent_license: o.agentLicense || '',
      listing_firm: o.office || br.name || (l.office || {}).brokerageName || '',
      listing_agent_address: [ba.address1, ba.address2, ba.city, [ba.state, ba.postal].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    };
  }
  /* closing date suggestion: n days out, moved off weekends and the days title companies close */
  function holiday(d) {
    var m = d.getMonth() + 1, day = d.getDate(), wd = d.getDay(), md = m + '-' + day;
    if (['1-1', '7-4', '12-24', '12-25', '12-31'].indexOf(md) > -1) return true;
    if (m === 11 && wd === 4 && day >= 22 && day <= 28) return true;           // Thanksgiving
    if (m === 11 && wd === 5 && day >= 23 && day <= 29) return true;           // the day after
    if (m === 5 && wd === 1 && day >= 25) return true;                         // Memorial Day
    if (m === 9 && wd === 1 && day <= 7) return true;                          // Labor Day
    return false;
  }
  function freq(f) { var k = String(f || '').toLowerCase(), es = lang === 'es'; var M = { annually: es ? 'al año' : 'a year', monthly: es ? 'al mes' : 'a month', quarterly: es ? 'por trimestre' : 'a quarter', 'semi-annually': es ? 'cada 6 meses' : 'twice a year' }; return M[k] || ('/ ' + k); }
  function addDays(n) { var d = new Date(); d.setDate(d.getDate() + n); while (d.getDay() === 0 || d.getDay() === 6 || holiday(d)) d.setDate(d.getDate() + 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

  function box() {
    if (!me()) return '';
    css();
    return '<div class="jto-box"><small>' + esc(t('team')) + '</small><h4>' + esc(t('h')) + '</h4><p>' + esc(t('p')) + '</p><button type="button" class="jto-btn" data-jto>' + esc(t('go')) + '</button></div>';
  }
  function bind(root, l, lg) {
    lang = lg === 'en' ? 'en' : 'es';
    var b = root && root.querySelector('[data-jto]'); if (b) b.onclick = function () { open(l); };
  }

  function open(l) {
    css();
    if (!ov) { ov = document.createElement('div'); ov.className = 'jto-ov'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); document.body.appendChild(ov);
      ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && ov.classList.contains('on')) { e.stopPropagation(); close(); } }, true); }
    var price = Math.round(l.listPrice || 0);
    ov.innerHTML = '<div class="jto-m"><div class="jto-hd"><b>' + esc(t('title')) + esc(facts(l).address) + '</b><button type="button" class="jto-x" data-x aria-label="' + esc(t('cancel')) + '">×</button></div>' +
      '<div class="jto-bd" id="jto-bd"><h5>' + esc(t('har')) + '</h5><div class="jto-har" id="jto-har">…</div>' +
      '<h5>' + esc(t('buyer')) + '</h5><div class="jto-g jto-f">' +
        '<div class="full"><label for="jto-c">' + esc(t('pick')) + '</label><select id="jto-c"><option value="">' + esc(t('pick0')) + '</option></select></div>' +
        '<div class="full"><label for="jto-n">' + esc(t('names')) + '</label><input id="jto-n" autocomplete="off"><small>' + esc(t('names_h')) + '</small></div>' +
        '<div><label for="jto-e">' + esc(t('email')) + '</label><input id="jto-e" type="email" autocomplete="off"></div>' +
        '<div><label for="jto-p">' + esc(t('phone')) + '</label><input id="jto-p" type="tel" autocomplete="off"></div></div>' +
      '<h5>' + esc(t('money')) + '</h5><div class="jto-g jto-f">' +
        '<div><label for="jto-pr">' + esc(t('price')) + '</label><input id="jto-pr" inputmode="numeric" value="' + (price || '') + '"></div>' +
        '<div><label for="jto-lt">' + esc(t('loan')) + '</label><select id="jto-lt"><option value="fha">FHA</option><option value="conventional">Conventional</option><option value="va">VA</option><option value="usda">USDA</option><option value="cash">Cash</option></select></div>' +
        '<div><label for="jto-dp">' + esc(t('down')) + '</label><input id="jto-dp" inputmode="decimal" value="3.5"></div>' +
        '<div><label for="jto-sc">' + esc(t('conc')) + '</label><input id="jto-sc" inputmode="numeric"><small>' + esc(t('conc_h')) + '</small></div>' +
        '<div><label for="jto-em">' + esc(t('earn')) + '</label><input id="jto-em" inputmode="numeric" value="' + (price ? Math.max(500, Math.round(price * 0.01 / 100) * 100) : '') + '"></div>' +
        '<div><label for="jto-of">' + esc(t('ofee')) + '</label><input id="jto-of" inputmode="numeric" value="200"></div>' +
        '<div><label for="jto-od">' + esc(t('odays')) + '</label><input id="jto-od" inputmode="numeric" value="7"></div>' +
        '<div><label for="jto-cd">' + esc(t('close')) + '</label><input id="jto-cd" type="date" value="' + addDays(30) + '"></div>' +
        '<div><label for="jto-tc">' + esc(t('titleco')) + '</label><input id="jto-tc" value="Capital Title"></div>' +
        '<div><label for="jto-hw">' + esc(t('warr')) + '</label><input id="jto-hw" inputmode="numeric" value="700"></div></div>' +
      '<label class="jto-chk"><input type="checkbox" id="jto-send" checked><span><b>' + esc(t('tc')) + '</b><small>' + esc(t('tc_h')) + '</small></span></label>' +
      '<div class="jto-f" style="margin-top:10px"><label for="jto-nt">' + esc(t('note')) + '</label><textarea id="jto-nt" placeholder="' + esc(t('note_ph')) + '"></textarea></div>' +
      '<p class="jto-err" id="jto-err" role="alert"></p></div>' +
      '<div class="jto-ft" id="jto-ft"><button type="button" class="sec" data-x>' + esc(t('cancel')) + '</button><button type="button" class="pri" id="jto-go">' + esc(t('make')) + '</button></div></div>';
    ov.classList.add('on');
    ov.querySelectorAll('[data-x]').forEach(function (x) { x.onclick = close; });
    var F = facts(l), full = null;
    paintHar(F);
    fetch(API + '?detail=1&mlsNumber=' + encodeURIComponent(l.mlsNumber)).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { full = j && j.listings && j.listings[0]; if (full) { F = facts(l, full); paintHar(F); } }).catch(function () {});
    var DOWN = { fha: '3.5', conventional: '5', va: '0', usda: '0', cash: '' };
    var lt = ov.querySelector('#jto-lt'), dp = ov.querySelector('#jto-dp');
    lt.onchange = function () { dp.value = DOWN[lt.value]; dp.disabled = lt.value === 'cash'; };
    // website clients of this agent
    (clients ? Promise.resolve(clients) : rpc('jag_agent_clients').then(function (j) { clients = (j && j.clients) || []; return clients; }).catch(function () { return []; }))
      .then(function (list) {
        var sel = ov.querySelector('#jto-c'); if (!sel) return;
        list.slice().sort(function (a, b) { return String(a.name || a.email).localeCompare(String(b.name || b.email)); }).forEach(function (c) {
          var op = document.createElement('option'); op.value = c.user_id; op.textContent = (c.name || c.email) + (c.email && c.name ? ' · ' + c.email : ''); sel.appendChild(op); });
        sel.onchange = function () { var c = list.filter(function (x) { return x.user_id === sel.value; })[0]; if (!c) return;
          ov.querySelector('#jto-n').value = c.name || ''; ov.querySelector('#jto-e').value = c.email || ''; ov.querySelector('#jto-p').value = c.phone ? phone(c.phone) : ''; };
      });
    ov.querySelector('#jto-go').onclick = function () { submit(l, F, this); };
    setTimeout(function () { var n = ov.querySelector('#jto-n'); if (n && matchMedia('(pointer:fine)').matches) n.focus(); }, 60);
  }
  function paintHar(F) {
    var el = ov && ov.querySelector('#jto-har'); if (!el) return;
    var u = '<em>' + esc(t('unknown')) + '</em>';
    var rows = [
      [t('legal'), [F.lot ? 'Lot ' + F.lot : '', F.block ? 'Block ' + F.block : '', F.addition].filter(Boolean).join(', ') || F.legal_raw],
      [t('county'), F.county], [t('hoa'), F.hoa === 'true' ? [t('yes'), F.hoa_fee, F.hoa_name, F.hoa_phone].filter(Boolean).join(' · ') : F.hoa === 'false' ? t('no') : ''],
      [t('mud'), F.district_notices || t('no')],
      [t('la'), [F.listing_agent, F.listing_agent_phone, F.listing_agent_email].filter(Boolean).join(' · ')],
      [t('bk'), F.listing_firm]];
    el.innerHTML = rows.map(function (r) { return '<div><span>' + esc(r[0]) + '</span><b>' + (r[1] ? esc(r[1]) : u) + '</b></div>'; }).join('');
  }
  function val(id) { var e = ov.querySelector('#' + id); return e ? String(e.value || '').trim() : ''; }
  function num(id) { var v = val(id).replace(/[^0-9.]/g, ''); return v; }
  function submit(l, F, btn) {
    var err = ov.querySelector('#jto-err'); err.textContent = '';
    var names = val('jto-n'), price = num('jto-pr');
    if (!names || !price) { err.textContent = t('need'); return; }
    var loan = val('jto-lt');
    var terms = {
      city: F.city, zip: F.zip, county: F.county, year_built: F.year_built, lot: F.lot, block: F.block, addition: F.addition,
      hoa: F.hoa, hoa_name: F.hoa_name, hoa_phone: F.hoa_phone, district_notices: F.district_notices,
      listing_agent: F.listing_agent, listing_firm: F.listing_firm, listing_agent_phone: F.listing_agent_phone,
      listing_agent_email: F.listing_agent_email, listing_agent_address: F.listing_agent_address,
      buyer_names: names, buyer_email: val('jto-e'), buyer_phone: val('jto-p'),
      sales_price: price, loan_type: loan, down_payment: loan === 'cash' ? '' : (num('jto-dp') ? num('jto-dp') + '%' : ''),
      seller_concession: num('jto-sc'), earnest_money: num('jto-em'), option_fee: num('jto-of'), option_days: num('jto-od'),
      closing_date: val('jto-cd'), title_company: val('jto-tc'), service_contract: num('jto-hw'),
    };
    Object.keys(terms).forEach(function (k) { if (terms[k] === '' || terms[k] == null) delete terms[k]; });
    var send = ov.querySelector('#jto-send').checked, note = val('jto-nt');
    btn.disabled = true; btn.textContent = t('making');
    rpc('jag_offer_start', { p: { address: F.address, mls: String(l.mlsNumber), client: names, terms: terms } })
      .then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.reason) || 'start');
        return (send ? rpc('jag_tc_send', { p_offer_id: r.offer_request_id, p_note: note || null }).catch(function () { return null; }) : Promise.resolve(null))
          .then(function (s) { done(r, s); });
      })
      .catch(function () { btn.disabled = false; btn.textContent = t('make'); err.textContent = t('err'); });
  }
  function done(r, s) {
    var bd = ov.querySelector('#jto-bd'), ft = ov.querySelector('#jto-ft');
    var miss = r.missing || [];
    bd.innerHTML = '<div class="jto-ok"><div style="font-size:40px">📝</div><h3>' + esc(t('done')) + '</h3>' +
      (s && s.ok ? '<p><b>' + esc(t('sent')) + esc(s.tc || 'René') + '</b>' + esc(t('sent2')) + '</p>' : '') +
      (miss.length ? '<p style="margin:14px 0 0">' + esc(t('left')) + '</p><ul>' + miss.map(function (m) { return '<li>' + esc(m) + '</li>'; }).join('') + '</ul>' : '<p>' + esc(t('none')) + '</p>') + '</div>';
    ft.innerHTML = '<button type="button" class="sec" data-x>' + (lang === 'es' ? 'Cerrar' : 'Close') + '</button><a class="pri" href="' + esc(r.link) + '" target="_blank" rel="noopener">' + esc(t('open')) + '</a>';
    ft.querySelector('[data-x]').onclick = close;
  }
  function close() { if (ov) { ov.classList.remove('on'); ov.innerHTML = ''; } }

  window.JagTeamOffer = { box: box, bind: bind, open: open, facts: facts, legal: legal };
})();
