/* ============================================================
   JAG team: clean up a website offer before the contract is prepared.
   The admin or the client's assigned agent fixes the buyer's details and terms
   (jag_offer_edit). The client sees the corrected offer in their portal.
   JagOfferEdit.open(offer, { call: function(rpcName, args) → Promise<json>, onSaved: function(updatedOffer) })
   ============================================================ */
(function () {
  'use strict';
  var ov = null;
  var CT = [['Inspección', 'Inspection'], ['Avalúo', 'Appraisal'], ['Financiamiento', 'Financing'], ['Venta de mi casa actual', 'Sale of their current home']];
  var LOANS = ['FHA', 'Conventional', 'VA', 'USDA', 'ITIN', 'Not sure yet'];
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function digits(p) { return String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); }
  function phone(p) { var d = digits(p); return d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : String(p || ''); }
  function amt(v) { var n = Number(String(v == null ? '' : v).replace(/[^0-9.]/g, '')); return n > 0 ? Math.round(n).toLocaleString('en-US') : ''; }
  function css() {
    if (document.getElementById('joe-css')) return;
    var s = document.createElement('style'); s.id = 'joe-css';
    s.textContent = '.joe-ov{position:fixed;inset:0;background:rgba(15,14,20,.6);display:none;align-items:flex-start;justify-content:center;padding:14px;z-index:9700;overflow-y:auto}.joe-ov.on{display:flex}' +
      '.joe-m{background:#fff;color:#17161c;border-radius:18px;width:100%;max-width:620px;margin:auto 0;font-family:inherit;font-size:15px;text-align:left}' +
      '.joe-hd{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:16px 20px;border-bottom:1px solid #e8e8ec;position:sticky;top:0;background:#fff;border-radius:18px 18px 0 0;z-index:2}' +
      '.joe-hd b{font-size:18px}.joe-hd small{display:block;font-size:12.5px;color:#5f5e68;font-weight:500}.joe-x{border:0;background:#f5f5f7;width:38px;height:38px;border-radius:50%;font-size:20px;cursor:pointer;flex:none;color:#17161c}' +
      '.joe-bd{padding:6px 20px 18px}.joe-bd h5{margin:18px 0 8px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#5f5e68}' +
      '.joe-g{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px}.joe-g .full{grid-column:1/-1}' +
      '.joe-g label{display:block;font-size:13px;font-weight:700;margin:0 0 4px}.joe-g input,.joe-g select,.joe-g textarea{width:100%;box-sizing:border-box;border:1px solid #c9c8d0;border-radius:10px;padding:10px 12px;font:inherit;font-size:16px;background:#fff;color:#17161c}' +
      '.joe-g textarea{min-height:70px;resize:vertical}.joe-g small{display:block;color:#85848d;font-size:12px;margin-top:3px}' +
      '.joe-ck{display:flex;flex-wrap:wrap;gap:8px}.joe-ck label{display:flex;align-items:center;gap:6px;border:1px solid #c9c8d0;border-radius:99px;padding:7px 12px;font-weight:600;font-size:14px;cursor:pointer;margin:0}' +
      '.joe-ck input{width:18px;height:18px;margin:0;accent-color:#c8102e}' +
      '.joe-ft{display:flex;gap:10px;justify-content:flex-end;align-items:center;padding:14px 20px;border-top:1px solid #e8e8ec;position:sticky;bottom:0;background:#fff;border-radius:0 0 18px 18px}' +
      '.joe-ft button{border:2px solid #c8102e;border-radius:12px;padding:11px 16px;font:inherit;font-weight:800;cursor:pointer}.joe-ft .pri{background:#c8102e;color:#fff}.joe-ft .sec{background:#fff;color:#c8102e}' +
      '.joe-err{color:#a30d26;font-weight:700;font-size:14px;margin:12px 0 0}.joe-err:empty{display:none}' +
      '@media(max-width:560px){.joe-g{grid-template-columns:minmax(0,1fr)}.joe-ov{padding:0}.joe-m{border-radius:0;min-height:100%}}';
    document.head.appendChild(s);
  }
  function f(id, label, html, hint, full) { return '<div' + (full ? ' class="full"' : '') + '><label for="joe-' + id + '">' + esc(label) + '</label>' + html + (hint ? '<small>' + esc(hint) + '</small>' : '') + '</div>'; }
  function inp(id, v, attrs) { return '<input id="joe-' + id + '" value="' + esc(v == null ? '' : v) + '"' + (attrs || '') + '>'; }
  function sel(id, v, opts) { return '<select id="joe-' + id + '">' + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(v || '') === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>'; }

  function open(o, opts) {
    opts = opts || {}; css();
    if (!ov) { ov = document.createElement('div'); ov.className = 'joe-ov'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); document.body.appendChild(ov);
      ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && ov.classList.contains('on')) { e.stopPropagation(); close(); } }, true); }
    var loans = LOANS.slice(); if (o.loan_type && loans.indexOf(o.loan_type) < 0) loans.unshift(o.loan_type);
    var cs = o.contingencies || [];
    ov.innerHTML = '<div class="joe-m"><div class="joe-hd"><span><b>Edit offer details</b><small>' + esc(o.address || '') + '</small></span><button type="button" class="joe-x" data-x aria-label="Close">×</button></div>' +
      '<div class="joe-bd"><h5>Buyer</h5><div class="joe-g">' +
        f('name', 'Full legal name', inp('name', o.name, ' autocomplete="off"'), 'Exactly as they will sign the contract.', true) +
        f('co', 'Co-buyer(s)', inp('co', o.co_buyer, ' autocomplete="off"'), 'Anyone else on title, full legal name.', true) +
        f('email', 'Email', inp('email', o.email, ' type="email" autocomplete="off"')) +
        f('phone', 'Phone', inp('phone', phone(o.phone), ' type="tel" autocomplete="off"')) + '</div>' +
      '<h5>Home</h5><div class="joe-g">' + f('addr', 'Property address', inp('addr', o.address), '', true) + '</div>' +
      '<h5>Price and terms</h5><div class="joe-g">' +
        f('price', 'Offer price ($)', inp('price', amt(o.offer_price), ' inputmode="numeric"')) +
        f('earn', 'Earnest money ($)', inp('earn', amt(o.earnest), ' inputmode="numeric"')) +
        f('fin', 'Paying with', sel('fin', o.financing || 'financed', [['financed', 'Loan'], ['cash', 'Cash']])) +
        f('loan', 'Loan type', sel('loan', o.loan_type || '', [['', '—']].concat(loans.map(function (x) { return [x, x]; })))) +
        f('down', 'Down payment', inp('down', o.down_payment, ' placeholder="3.5% or $10,000"')) +
        f('lender', 'Lender', inp('lender', o.lender)) +
        f('proof', 'Pre-approval / proof of funds', sel('proof', o.proof || '', [['', '—'], ['yes', 'Has it'], ['working', 'Working on it'], ['no', 'Not yet']])) +
        f('opt', 'Option period (days)', inp('opt', o.option_days, ' inputmode="numeric"')) +
        f('close', 'Closing date', inp('close', o.close_date ? String(o.close_date).slice(0, 10) : '', ' type="date"')) +
        '<div class="full"><label>Conditions</label><div class="joe-ck">' + CT.map(function (c, i) {
          return '<label><input type="checkbox" data-ct="' + i + '"' + (cs.indexOf(c[0]) >= 0 || cs.indexOf(c[1]) >= 0 ? ' checked' : '') + '>' + esc(c[1]) + '</label>'; }).join('') + '</div></div>' +
        f('notes', 'Client notes', '<textarea id="joe-notes">' + esc(o.notes || '') + '</textarea>', '', true) + '</div>' +
      '<p class="joe-err" id="joe-err" role="alert"></p></div>' +
      '<div class="joe-ft"><button type="button" class="sec" data-x>Cancel</button><button type="button" class="pri" id="joe-save">Save details</button></div></div>';
    ov.classList.add('on');
    ov.querySelectorAll('[data-x]').forEach(function (x) { x.onclick = close; });
    var fin = ov.querySelector('#joe-fin'), sync = function () { var cash = fin.value === 'cash'; ['loan', 'down', 'lender'].forEach(function (k) { ov.querySelector('#joe-' + k).disabled = cash; }); };
    fin.onchange = sync; sync();
    ['price', 'earn'].forEach(function (k) { var el = ov.querySelector('#joe-' + k); el.oninput = function () { var v = amt(el.value); el.value = v; }; });
    ov.querySelector('#joe-save').onclick = function () { save(o, opts, this); };
  }
  function v(id) { var e = ov.querySelector('#joe-' + id); return e ? String(e.value || '').trim() : ''; }
  function save(o, opts, btn) {
    var err = ov.querySelector('#joe-err'); err.textContent = '';
    var cash = v('fin') === 'cash';
    if (!v('name')) { err.textContent = 'Type the buyer\'s full name.'; return; }
    if (digits(v('phone')).length !== 10) { err.textContent = 'Phone needs 10 digits.'; return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v('email'))) { err.textContent = 'Check the email.'; return; }
    if (!(Number(v('price').replace(/[^0-9.]/g, '')) > 0)) { err.textContent = 'Type the offer price.'; return; }
    var cts = []; ov.querySelectorAll('[data-ct]').forEach(function (c) { if (c.checked) cts.push(CT[+c.getAttribute('data-ct')][0]); });
    var p = { name: v('name'), co_buyer: v('co'), email: v('email'), phone: digits(v('phone')), address: v('addr'),
      offer_price: v('price').replace(/[^0-9.]/g, ''), earnest: v('earn').replace(/[^0-9.]/g, ''), financing: v('fin'),
      loan_type: cash ? '' : v('loan'), down_payment: cash ? '' : v('down'), lender: cash ? '' : v('lender'),
      proof: v('proof') || null, contingencies: cts, option_days: v('opt'), close_date: v('close'), notes: v('notes') };
    btn.disabled = true; btn.textContent = 'Saving…';
    opts.call('jag_offer_edit', { p_id: o.id, p: p }).then(function (j) {
      if (!j || !j.ok) { btn.disabled = false; btn.textContent = 'Save details';
        err.textContent = j && j.reason === 'not_allowed' ? 'Only the admin or this client\'s agent can edit this offer.' : j && j.reason === 'email' ? 'Check the email.' : j && j.reason === 'phone' ? 'Phone needs 10 digits.' : 'Could not save. Try again.'; return; }
      close(); if (opts.onSaved) opts.onSaved(j.offer || null);
    }).catch(function () { btn.disabled = false; btn.textContent = 'Save details'; err.textContent = 'Could not save. Check your sign-in and try again.'; });
  }
  function close() { if (ov) { ov.classList.remove('on'); ov.innerHTML = ''; } }
  window.JagOfferEdit = { open: open, close: close };
})();
