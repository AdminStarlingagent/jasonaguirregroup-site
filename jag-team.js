/* JAG Team workspace glue. agent.html (Agent Hub), matrix.html and screener.html run as tabs inside workspace.html.
   Load it first thing in <head> with the page's tab name:  <script src="jag-team.js?v=1" data-sec="hub|matrix|screener"></script>

   - Opened on its own (bookmark, Follow Up Boss note, old text): forwards to workspace.html#<tab>=<this page's ?query#hash>.
     Add ?solo=1 to open a page by itself (debugging).
   - Inside workspace.html: hides the page's own cross-links and sign-out (the workspace bar has them), sends links to the
     other pages to their tab instead of loading them in this frame, opens sms:/tel:/mailto: from the top window,
     and reports the tab badge (unread messages + notifications, leads to call). */
(function(){
  var me = document.currentScript, sec = me && me.dataset.sec;
  if(!sec) return;
  var SEC_OF = { agent: 'hub', matrix: 'matrix', screener: 'screener' };

  if(window.top === window){
    if(/[?&]solo=1(&|#|$)/.test(location.search)) return;
    var suf = location.search + location.hash;
    document.documentElement.style.visibility = 'hidden';
    location.replace('workspace.html#' + sec + (suf ? '=' + encodeURIComponent(suf) : ''));
    return;
  }

  var host = null, frame = null;
  try{ host = window.parent.JagTeam || null; frame = window.frameElement; }catch(e){}
  if(!host) return;   // framed by something else: behave like a normal page

  // This frame belongs to another tab (a page script navigated it here): open it in its own tab instead.
  if(frame && frame.dataset.sec && frame.dataset.sec !== sec){
    document.documentElement.style.visibility = 'hidden';
    host.go(sec, location.search + location.hash, frame.dataset.sec);
    return;
  }

  var root = document.documentElement;
  root.classList.add('in-team');
  var HIDE = {
    hub: '#hd-ph,#hd-name,#hd-sub,.hd a[href="matrix.html"],#scr-link,#out{display:none!important}.hd .wrap{padding-block:10px;flex-wrap:wrap}',
    matrix: '.top .lock,.top .toplinks,.top .who{display:none!important}',
    screener: '.site a[href="matrix.html"],#toadmin,#signout{display:none!important}'
  };
  var st = document.createElement('style');
  st.textContent = (HIDE[sec] || '').replace(/(^|\})([^{}]+)\{/g, function(m, b, sel){
    return b + sel.split(',').map(function(s){ return 'html.in-team ' + s.trim(); }).join(',') + '{';
  });
  (document.head || root).appendChild(st);

  document.addEventListener('click', function(ev){
    if(ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if(!a) return;
    var href = a.getAttribute('href') || '';
    if(/^(sms|tel|mailto|whatsapp):/i.test(href)){ if(!a.target) a.target = '_top'; return; }
    if(a.target && a.target !== '_self') return;   // new tab: it forwards into its own workspace
    var u; try{ u = new URL(a.href, location.href); }catch(e){ return; }
    if(u.origin !== location.origin) return;
    var m = u.pathname.match(/\/(agent|matrix|screener|admin|workspace|signin)(\.html)?$/i);
    if(!m) return;
    var page = m[1].toLowerCase();
    if(page === 'admin' || page === 'workspace' || page === 'signin'){ ev.preventDefault(); window.top.location.href = u.href; return; }
    var to = SEC_OF[page];
    if(to === sec) return;   // same page: let it navigate inside this tab
    ev.preventDefault();
    host.go(to, u.search + u.hash);
  }, true);

  var BADGE = { hub: '#tc-msgs,#nf-n', screener: '#leads-n' }, last = -1;   // hub: unread messages + new notifications
  function report(){
    var sel = BADGE[sec]; if(!sel) return;
    var n = 0;
    document.querySelectorAll(sel).forEach(function(el){ if(!el.hidden) n += parseInt(String(el.textContent).replace(/\D/g, ''), 10) || 0; });
    if(n !== last){ last = n; try{ host.badge(sec, n); }catch(e){} }
  }
  if(BADGE[sec]){ window.addEventListener('load', report); setInterval(report, 4000); }
})();
