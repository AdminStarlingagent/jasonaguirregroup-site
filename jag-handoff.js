/* ============================================================
   JAG Home Loans handoff — start apply.html with answers we already have, so the team never asks twice.
   Used by the call screener (screener.html) and the admin (admin.html).
   The answers travel through this device's storage, never in a link. They expire in 30 minutes,
   and apply.html deletes them the moment it reads them. The app links back to a screening by phone (DB trigger).
     JagHandoff.fromScreening(answers, uiLang) → Home App answers from a screener answer set
     JagHandoff.basic({ name, phone, email, lang }) → Home App answers from contact info only
     JagHandoff.start({ from, client, sid, A }) → saves the handoff and opens the app in a new tab
   ============================================================ */
(function(){
  var KEY = 'jag_app_handoff';
  function num(v){ var n = parseFloat(v); return isNaN(n) ? null : n; }

  // Monthly income for person n, same math as the screener.
  function income(st, n){
    var inc = st['p' + n + '_inc'];
    if(!inc || inc === 'Efectivo sin declarar' || inc === 'No trabaja') return 0;
    var m = null, pay = st['p' + n + '_pay'];
    if(pay === 'Por hora'){ var r = num(st['p' + n + '_rate']), h = num(st['p' + n + '_hours']); if(r != null && h != null) m = r * h * 52 / 12; }
    else if(pay === 'Al año'){ var a = num(st['p' + n + '_amount']); if(a != null) m = a / 12; }
    else if(pay === 'Al mes') m = num(st['p' + n + '_amount']);
    if(/1099/.test(inc) && st['p' + n + '_gross'] === 'Antes de gastos'){ var net = num(st['p' + n + '_net']); if(net != null) m = net / 12; }
    return m || 0;
  }
  function status(st, n){
    var id = st['p' + n + '_id'], s = st['p' + n + '_status'];
    if(s === 'Permiso de trabajo') return 'Work Permit (EAD)';
    if(id === 'ITIN') return 'ITIN (Tax ID number)';
    if(s === 'Residente') return 'Permanent Resident / Green Card';
    if(s === 'Ciudadano') return 'Social Security Number (SSN)';
    return '';
  }
  function setter(A){
    return function(k, v){ if(v != null && v !== '' && !(typeof v === 'number' && !isFinite(v))) A[k] = String(v); };
  }
  function contact(A, o){
    var set = setter(A), parts = String(o.name || '').trim().split(/\s+/).filter(Boolean);
    if(o.lang) set('language', /^(en|english)$/i.test(o.lang) ? 'English' : 'Español');
    if(parts.length) set('first', parts[0]);
    if(parts.length > 1) set('last', parts.slice(1).join(' '));
    set('phone', String(o.phone || '').replace(/\D/g, '').slice(-10));
    set('email', String(o.email || '').trim());
  }
  function basic(o){ var A = {}; contact(A, o || {}); return A; }

  function fromScreening(st, uiLang){
    st = st || {};
    var A = {}, set = setter(A);
    contact(A, { name: st.c_name, phone: st.c_phone, email: st.c_email, lang: uiLang === 'en' ? 'en' : 'es' });
    if(st.intent === 'Comprar casa') set('goal', 'Buy a home');
    // pre '' = the client, 'co' = the co-borrower (the Home App's key names)
    function person(n, pre){
      var K = function(k){ return pre ? pre + k.charAt(0).toUpperCase() + k.slice(1) : k; };
      set(K('status'), status(st, n));
      var inc = st['p' + n + '_inc'], pay = st['p' + n + '_pay'], m = income(st, n);
      if(inc === 'W-2' || inc === 'W-2 y 1099' || inc === 'Efectivo sin declarar'){
        set(K('work'), 'Employed');
        if(inc === 'Efectivo sin declarar') set(K('payType'), 'Cash');
        else if(pay === 'Por hora'){ set(K('payType'), 'By the hour'); set(K('payRate'), num(st['p' + n + '_rate'])); set(K('hoursWeek'), num(st['p' + n + '_hours'])); }
        else if(pay === 'Al año' || pay === 'Al mes'){ set(K('payType'), 'Salary'); set(K('salaryAmt'), num(st['p' + n + '_amount'])); set(K('salaryPer'), pay === 'Al año' ? 'Per year' : 'Per month'); }
        if(m){ set(K('income'), Math.round(m)); if(!pre) A.incomeComputed = true; }
      } else if(inc === '1099 / negocio propio'){
        set(K('work'), 'Self-employed');
        if(m) set(K('income'), Math.round(m));
        if(!pre && st['p' + n + '_tenure'] === 'Menos de 6 meses') set('tenure', 'Less than 1 year');
      } else if(inc === 'No trabaja') set(K('work'), 'Not employed');
    }
    person(1, '');
    if(st.who === 'Solo') set('hasCoBorrower', 'No');
    else if(st.who === 'Con pareja' || st.who === 'Con otro familiar'){
      set('hasCoBorrower', 'Yes'); A.coFromNudge = false;
      if(st.who === 'Con pareja') set('coRelation', 'Spouse/Partner');
      person(2, 'co');
    }
    var dk = ['d_car', 'd_cards', 'd_loans', 'd_other'];
    if(st.__debtsSeen || st.calc_debts != null || dk.some(function(k){ return st[k] !== undefined && st[k] !== ''; })){
      var debts = st.calc_debts != null ? num(st.calc_debts) : dk.map(function(k){ return num(st[k]) || 0; }).reduce(function(a, b){ return a + b; }, 0);
      set('debts', Math.round(debts || 0));
    }
    return A;
  }

  function start(o){
    o = o || {};
    var h = { v: 1, at: Date.now(), from: o.from || '', sid: o.sid || null, client: o.client || '', A: o.A || {} };
    try{ localStorage.setItem(KEY, JSON.stringify(h)); }catch(e){ return false; }
    window.open('apply.html?from=screener', '_blank');
    return true;
  }

  window.JagHandoff = { fromScreening: fromScreening, basic: basic, start: start };
})();
