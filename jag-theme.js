/* JAG light / dark mode — one file for every page (client account, Agent Hub, Admin, and the shared widgets).
   Preference: localStorage 'jag_theme' = 'system' (default, follows the phone or computer) | 'light' | 'dark'.
   Load it in <head> (before the page's own styles) so there is no white flash.

   How dark mode works: the pages are designed in light colors. This file reads every same-origin stylesheet (and the
   inline styles the widgets write) and builds a dark twin of each rule under :root[data-theme="dark"]:
   light surfaces become dark, dark text becomes light, colored text gets brighter, red/blue buttons stay as they are.
   Every color rule is re-emitted with the same extra specificity, so hover/active/selected states keep working.
   A page can fine-tune anything with its own :root[data-theme="dark"] rules (those win, they're written later). */
(function(){
  var KEY = 'jag_theme', root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function get(){ try{ var v = localStorage.getItem(KEY); if(v === 'light' || v === 'dark') return v; }catch(e){} return 'system'; }
  function isDark(){ var p = get(); return p === 'dark' || (p === 'system' && !!(mq && mq.matches)); }

  /* ---------- color math ---------- */
  var cache = {};
  function parse(c){
    c = String(c).trim().toLowerCase();
    var m = c.match(/^#([0-9a-f]{3,8})$/);
    if(m){ var h = m[1]; if(h.length < 6) h = h.split('').map(function(x){ return x + x; }).join('');
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1]; }
    m = c.match(/^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
    if(m){ var a = m[4] == null ? 1 : (/%$/.test(m[4]) ? parseFloat(m[4]) / 100 : +m[4]); return [+m[1], +m[2], +m[3], a]; }
    if(c === 'white') return [255, 255, 255, 1]; if(c === 'black') return [0, 0, 0, 1];
    return null;
  }
  function hsl(r, g, b){ r /= 255; g /= 255; b /= 255; var mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, h = 0, s = 0;
    if(mx !== mn){ var d = mx - mn; s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn);
      h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h /= 6; }
    return [h, s, l]; }
  function rgb(h, s, l){ function f(p, q, t){ if(t < 0) t += 1; if(t > 1) t -= 1; return t < 1/6 ? p + (q - p) * 6 * t : t < 1/2 ? q : t < 2/3 ? p + (q - p) * (2/3 - t) * 6 : p; }
    if(!s){ var v = Math.round(l * 255); return [v, v, v]; } var q = l < .5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    return [Math.round(f(p, q, h + 1/3) * 255), Math.round(f(p, q, h) * 255), Math.round(f(p, q, h - 1/3) * 255)]; }
  function out(c, a){ return a < 1 ? 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (Math.round(a * 1000) / 1000) + ')' : 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'; }
  // kind: 'bg' (surfaces), 'fg' (text, icons), 'bd' (borders, outlines)
  function darkOf(c, kind){
    var k = kind + c; if(cache[k] != null) return cache[k];
    var p = parse(c); if(!p){ cache[k] = c; return c; }
    var H = hsl(p[0], p[1], p[2]), h = H[0], s = H[1], l = H[2], r;
    if(kind === 'bg'){
      if(p[0] === 255 && p[1] === 255 && p[2] === 255 && p[3] < 1) r = rgb(250/360, .1, .12);         // frosted white headers
      else if(l >= .995) r = rgb(250/360, .08, .135);                 // white cards
      else if(l >= .8 && s > .3) r = rgb(h, Math.min(s, .45), .17);  // pale tints (pink, blue, green…)
      else if(l >= .95) r = rgb(250/360, .08, .105);                  // page backgrounds
      else if(l >= .8) r = rgb(250/360, .07, .2);                     // light gray fills
      else if(l < .14 && s < .3) r = rgb(250/360, .08, .2);           // near-black (ink) blocks: keep dark, lift a little
      else r = null;                                                   // brand colors stay
    } else if(kind === 'fg'){
      if(l >= .75) r = null;                                           // white / light text stays
      else if(s < .25) r = rgb(h, s, l < .5 ? .95 - l * .6 : .62);    // grays: ink → near white, muted → soft gray
      else r = rgb(h, Math.min(s, .9), Math.min(.72, Math.max(l + .16, .58)));    // colored text gets a little brighter
    } else {
      if(l >= .7) r = rgb(250/360, .06, .26);                          // light borders
      else if(l < .3 && s < .3) r = rgb(250/360, .05, .45);            // ink borders
      else if(s >= .25 && l < .55) r = rgb(h, s, .62);
      else r = null;
    }
    var v = r ? out(r, p[3]) : c; cache[k] = v; return v;
  }

  /* ---------- tokens (custom properties) from :root, so var(--ink) can be mapped per use ---------- */
  var tokens = {};
  function collectTokens(rules){ for(var i = 0; i < rules.length; i++){ var r = rules[i];
    if(r.cssRules && !r.selectorText) { collectTokens(r.cssRules); continue; }
    if(r.selectorText && /(^|,)\s*(:root|html)\s*($|,)/.test(r.selectorText) && r.style){
      for(var j = 0; j < r.style.length; j++){ var n = r.style[j]; if(n.indexOf('--') === 0) tokens[n] = r.style.getPropertyValue(n).trim(); } } } }
  function resolve(v, depth){ return String(v).replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g, function(all, n, fb){
      var t = tokens[n]; if(t == null) return fb != null ? fb : all; return (depth || 0) < 4 ? resolve(t, (depth || 0) + 1) : t; }); }
  var COLOR_RX = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|\bwhite\b|\bblack\b/g;
  function mapValue(v, kind){
    if(!v || /^(inherit|initial|unset|currentcolor|transparent|none)$/i.test(v.trim())) return null;
    var res = resolve(v); if(!COLOR_RX.test(res)) { COLOR_RX.lastIndex = 0; return null; } COLOR_RX.lastIndex = 0;
    return res.replace(COLOR_RX, function(c){ return darkOf(c, kind); });
  }
  // Every color-related declaration is re-emitted (mapped when it holds a color, as-is when it's 'none', '0'…), using the
  // fullest form the browser gives back, so the dark twins keep exactly the same cascade as the light rules.
  var FG = ['color', 'fill', 'stroke', 'caret-color', 'text-decoration-color', 'accent-color'];
  var SIDES = ['top', 'right', 'bottom', 'left'];
  function darkDecls(style){
    var outv = [];
    function emit(n, kind){ var v = style.getPropertyValue(n); if(!v) return false;
      var m = mapValue(v, kind); outv.push(n + ':' + (m == null ? v : m) + (style.getPropertyPriority(n) ? ' !important' : '')); return true; }
    FG.forEach(function(n){ emit(n, 'fg'); });
    if(!emit('background', 'bg')){ emit('background-color', 'bg'); emit('background-image', 'bg'); }
    if(!emit('border', 'bd')){
      var anySide = false;
      SIDES.forEach(function(sd){ if(emit('border-' + sd, 'bd')) anySide = true; else emit('border-' + sd + '-color', 'bd'); });
      if(!anySide) emit('border-color', 'bd');
    }
    if(!emit('outline', 'bd')) emit('outline-color', 'bd');
    return outv.join(';');
  }
  function prefix(sel){ return sel.split(/,(?![^(]*\))/).map(function(s){
      s = s.trim(); if(!s) return s;
      if(/^(:root|html)\b/.test(s)) return s.replace(/^(:root|html)/, ':root[data-theme="dark"]');
      return ':root[data-theme="dark"] ' + s; }).join(','); }
  function build(rules){
    var css = '';
    for(var i = 0; i < rules.length; i++){ var r = rules[i];
      if(r.type === 4 && r.cssRules){ var inner = build(r.cssRules); if(inner) css += '@media ' + r.media.mediaText + '{' + inner + '}'; continue; }
      if(r.type === 12 && r.cssRules){ var inner2 = build(r.cssRules); if(inner2) css += '@supports ' + r.conditionText + '{' + inner2 + '}'; continue; }
      if(r.type !== 1 || !r.selectorText || /data-theme/.test(r.selectorText)) continue;
      var d = darkDecls(r.style); if(d) css += prefix(r.selectorText) + '{' + d + '}\n';
    }
    return css;
  }

  /* ---------- run over the page's stylesheets (and any the widgets add later) ---------- */
  var done = typeof WeakSet === 'function' ? new WeakSet() : null, holder = null;
  function own(sheet){ return sheet.ownerNode && (sheet.ownerNode.id === 'jag-dark' || sheet.ownerNode.hasAttribute('data-jag-dark')); }
  function scan(){
    var sheets = document.styleSheets, fresh = [], i, rules;
    for(i = 0; i < sheets.length; i++){ var sh = sheets[i]; if(own(sh) || (done && done.has(sh))) continue;
      try{ rules = sh.cssRules; }catch(e){ if(done) done.add(sh); continue; }       // Google Fonts etc. (cross-origin)
      if(!rules) continue; collectTokens(rules); fresh.push(sh); }
    if(!fresh.length) return;
    var css = '';
    for(i = 0; i < fresh.length; i++){ try{ css += build(fresh[i].cssRules); }catch(e){} if(done) done.add(fresh[i]); }
    if(!css) return;
    var s = document.createElement('style'); s.setAttribute('data-jag-dark', ''); s.textContent = css;
    // insert right after its source so the page's own :root[data-theme="dark"] fine-tuning (written later) still wins
    (document.head || root).appendChild(s);
    holder = s;
  }

  /* ---------- inline style="" colors (cards and lists the scripts build) ---------- */
  var INLINE = [['color', 'fg'], ['background', 'bg'], ['background-color', 'bg'], ['border', 'bd'], ['border-color', 'bd'], ['border-bottom', 'bd'], ['border-top', 'bd'], ['border-left', 'bd'], ['fill', 'fg']];
  function inlineDark(el){
    if(!el.style || !el.getAttribute) return;
    var orig = el.getAttribute('data-jl');
    if(orig == null){ orig = el.getAttribute('style') || ''; if(!COLOR_RX.test(orig) && orig.indexOf('var(') < 0){ COLOR_RX.lastIndex = 0; return; } COLOR_RX.lastIndex = 0; el.setAttribute('data-jl', orig); }
    if(el.getAttribute('data-jd') === el.getAttribute('style')) return;          // already dark
    for(var i = 0; i < INLINE.length; i++){ var v = el.style.getPropertyValue(INLINE[i][0]); if(!v) continue;
      var m = mapValue(v, INLINE[i][1]); if(m != null && m !== v) el.style.setProperty(INLINE[i][0], m); }
    el.setAttribute('data-jd', el.getAttribute('style') || '');
  }
  function inlineLight(el){ var o = el.getAttribute('data-jl'); if(o == null) return; el.removeAttribute('data-jl'); el.removeAttribute('data-jd'); el.setAttribute('style', o); }
  var busy = false;
  function walk(node, fn){ if(node.nodeType !== 1) return; if(node.hasAttribute('style') || node.hasAttribute('data-jl')) fn(node);
    var all = node.querySelectorAll('[style],[data-jl]'); for(var i = 0; i < all.length; i++) fn(all[i]); }

  /* ---------- apply ---------- */
  function apply(){
    var d = isDark();
    root.setAttribute('data-theme', d ? 'dark' : 'light');
    root.style.colorScheme = d ? 'dark' : 'light';
    var m = document.querySelector('meta[name="theme-color"]');
    if(m){ if(!m.hasAttribute('data-light')) m.setAttribute('data-light', m.getAttribute('content') || '#ffffff'); m.setAttribute('content', d ? '#17161c' : m.getAttribute('data-light')); }
    if(document.body) { if(d) { scan(); walk(document.body, inlineDark); } else walk(document.body, inlineLight); }
    try{ window.dispatchEvent(new CustomEvent('jag-theme', { detail: { pref: get(), dark: d } })); }catch(e){}
  }
  function set(v){ try{ if(v === 'light' || v === 'dark') localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); }catch(e){} apply(); }

  root.setAttribute('data-theme', isDark() ? 'dark' : 'light'); root.style.colorScheme = isDark() ? 'dark' : 'light';
  // a plain dark ground until the page's styles are read (no white flash)
  var early = document.createElement('style'); early.id = 'jag-dark'; early.textContent = ':root[data-theme="dark"],:root[data-theme="dark"] body{background:#17161c;color:#f1f0f4}';
  (document.head || root).appendChild(early);

  function start(){
    apply();
    if(window.MutationObserver){
      new MutationObserver(function(list){
        if(!isDark() || busy) return;
        var newSheet = false;
        for(var i = 0; i < list.length; i++){ var r = list[i];
          if(r.type === 'attributes'){ var t = r.target;
            if(t.hasAttribute('data-jd') && t.getAttribute('style') !== t.getAttribute('data-jd')){ t.removeAttribute('data-jl'); t.removeAttribute('data-jd'); }   // a script rewrote it
            inlineDark(t); continue; }
          for(var j = 0; j < r.addedNodes.length; j++){ var n = r.addedNodes[j];
            if(n.nodeName === 'STYLE' || n.nodeName === 'LINK') newSheet = true; else walk(n, inlineDark); } }
        if(newSheet) setTimeout(scan, 0);
      }).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    }
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.addEventListener('load', function(){ if(isDark()) scan(); });
  if(mq){ var on = function(){ if(get() === 'system') apply(); }; if(mq.addEventListener) mq.addEventListener('change', on); else if(mq.addListener) mq.addListener(on); }
  window.addEventListener('storage', function(e){ if(e.key === KEY) apply(); });   // changed in another tab

  /* ---------- text size: localStorage 'jag_text' = normal | large | xl (for older clients, or anyone who wants bigger text) ---------- */
  var SIZES = { normal: 1, large: 1.12, xl: 1.25 };
  function size(){ try{ var v = localStorage.getItem('jag_text'); if(SIZES[v]) return v; }catch(e){} return 'normal'; }
  function applySize(){ var z = SIZES[size()]; root.style.zoom = z === 1 ? '' : String(z); root.setAttribute('data-text', size()); }
  function setSize(v){ try{ if(v && v !== 'normal' && SIZES[v]) localStorage.setItem('jag_text', v); else localStorage.removeItem('jag_text'); }catch(e){} applySize();
    try{ window.dispatchEvent(new CustomEvent('jag-theme', { detail: { pref: get(), dark: isDark(), size: size() } })); }catch(e){} }
  applySize();
  window.addEventListener('storage', function(e){ if(e.key === 'jag_text') applySize(); });

  window.JagTheme = { get: get, set: set, isDark: isDark, size: size, setSize: setSize };
})();
