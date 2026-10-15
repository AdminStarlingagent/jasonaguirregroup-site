/* ============================================================
   JAG offer strength: a plain guide (not a prediction) used by the
   offer worksheet, the client portal and the Agent Hub.
   Looks at what sellers usually weigh: proof the buyer can close,
   price vs list, earnest money, option period and closing speed.
   ============================================================ */
(function(){
  var T = {
    es: { lv: ['Débil', 'Regular', 'Fuerte', 'Muy fuerte'], label: 'Fuerza de la oferta',
          fine: 'Guía basada en lo que los vendedores suelen tomar en cuenta. No es una predicción ni una garantía.',
          now: 'Su oferta hoy', withp: 'Con pre-aprobación', withf: 'Con comprobante de fondos',
          st: { submitted: 'Recibida', reviewing: 'En revisión', sent: 'Enviada al vendedor', countered: 'Contraoferta',
                accepted: 'Aceptada', declined: 'No aceptada', withdrawn: 'Retirada' } },
    en: { lv: ['Weak', 'Fair', 'Strong', 'Very strong'], label: 'Offer strength',
          fine: 'A guide based on what sellers usually weigh. Not a prediction or a guarantee.',
          now: 'Your offer today', withp: 'With pre-approval', withf: 'With proof of funds',
          st: { submitted: 'Received', reviewing: 'In review', sent: 'Sent to seller', countered: 'Counteroffer',
                accepted: 'Accepted', declined: 'Not accepted', withdrawn: 'Withdrawn' } }
  };
  function num(v){ v = Number(String(v == null ? '' : v).replace(/[^0-9.]/g, '')); return isFinite(v) ? v : 0; }

  /* o: {offer_price, list_price, earnest, financing:'cash'|'financed', proof:'yes'|'working'|'no',
         contingencies:[...], option_days, close_date, proof_verified:true} -> {score, level 0..3} */
  function strength(o){
    o = o || {};
    var s = 0, price = num(o.offer_price), list = num(o.list_price), earnest = num(o.earnest);
    var cash = o.financing === 'cash';
    if(o.proof === 'yes') s += cash ? 4 : 3; else if(o.proof === 'working') s += 1;
    if(o.proof_verified) s += 1;
    if(price && list){ var r = price / list; s += r >= 1 ? 3 : r >= 0.98 ? 2 : r >= 0.95 ? 1 : 0; } else s += 1;
    if(price && earnest){ var e = earnest / price; s += e >= 0.02 ? 2 : e >= 0.01 ? 1 : 0; }
    var od = num(o.option_days); if(od && od <= 7) s += 1;
    var c = (o.contingencies || []).join(' ').toLowerCase();
    if(/venta de mi casa|sale of my/.test(c)) s -= 1;
    if(o.close_date){ var d = (new Date(o.close_date) - new Date()) / 864e5; if(d > 0 && d <= 30) s += 1; }
    var level = s >= 8 ? 3 : s >= 6 ? 2 : s >= 4 ? 1 : 0;
    return { score: s, level: level };
  }
  function lang(){ try{ var v = localStorage.getItem('jag_lang'); if(v === 'en' || v === 'es') return v; }catch(e){} return 'es'; }
  function t(){ return T[lang()] || T.es; }

  /* small HTML meter: 4 segments, filled up to the level */
  function meter(level, opts){
    opts = opts || {}; var L = t(), lv = Math.max(0, Math.min(3, level | 0));
    var segs = [0, 1, 2, 3].map(function(k){
      return '<i style="flex:1;height:8px;border-radius:99px;background:' + (k <= lv ? (lv >= 2 ? '#17161c' : '#8a8992') : '#e7e5e1') + '"></i>';
    }).join('');
    return '<div class="jo-meter" role="img" aria-label="' + L.label + ': ' + L.lv[lv] + '">' +
      (opts.title === false ? '' : '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:6px">' +
        '<span style="font-size:10.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#5b5a62">' + (opts.title || L.label) + '</span>' +
        '<b style="font-size:' + (opts.big ? '28px' : '15px') + ';letter-spacing:-.02em">' + L.lv[lv] + '</b></div>') +
      '<div style="display:flex;gap:4px">' + segs + '</div></div>';
  }
  /* what the same offer looks like with proof the buyer can close */
  function compare(o){
    var now = strength(o), w = Object.assign({}, o, { proof: 'yes' }), up = strength(w);
    return { now: now, with: up, better: up.level > now.level, label: o.financing === 'cash' ? t().withf : t().withp };
  }
  window.JagOffer = { strength: strength, meter: meter, compare: compare, text: t, statusText: function(s){ return t().st[s] || s; } };
})();
