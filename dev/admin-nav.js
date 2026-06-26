/*
 * admin-nav.js — when the visitor is signed in as an admin account, inject
 * the admin navigation links into the page's <nav>. Self-contained: no
 * dependency on supabase-js or shared-dev.js, no global variables (IIFE).
 * Drop <script src="admin-nav.js"></script> before </body> on any dev page.
 */
(function(){
  var SB_URL = 'https://owsvfvhlbagxxmncwmtn.supabase.co';
  var SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im93c3ZmdmhsYmFneHhtbmN3bXRuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2NDQyMzksImV4cCI6MjA5NjIyMDIzOX0.AFemWKpLUuP8z1dAG5-j1X__EPyTdaqDFxece09-0EQ';
  var REF = 'owsvfvhlbagxxmncwmtn';

  // All admin destinations. The link to the current page is skipped.
  var ADMIN_LINKS = [
    { href:'dev-admin.html',    label:'Admin' },
    { href:'dev-accounts.html', label:'Accounts' }
  ];

  // Read the Supabase session from localStorage (handles v2 and v1 shapes).
  function getSession(){
    try{
      var raw = localStorage.getItem('sb-'+REF+'-auth-token');
      if(!raw){
        for(var i=0;i<localStorage.length;i++){
          var k = localStorage.key(i);
          if(/^sb-.*-auth-token$/.test(k)){ raw = localStorage.getItem(k); break; }
        }
      }
      if(!raw) return null;
      var obj = JSON.parse(raw);
      var s = obj.currentSession || obj;       // v1 wraps the session
      var token = s.access_token;
      if(!token) return null;
      var uid = (s.user && s.user.id) || null;
      if(!uid){                                 // fall back to JWT 'sub'
        var part = token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
        uid = JSON.parse(atob(part)).sub || null;
      }
      return uid ? { token:token, uid:uid } : null;
    }catch(e){ return null; }
  }

  // Check is_admin on the user's own profile row. Uses the user's token so
  // row-level security (auth.uid() = id) is satisfied.
  function checkAdmin(sess){
    return fetch(SB_URL+'/rest/v1/profiles?id=eq.'+encodeURIComponent(sess.uid)+'&select=is_admin',
      { headers:{ 'apikey':SB_KEY, 'Authorization':'Bearer '+sess.token } })
      .then(function(r){ return r.ok ? r.json() : []; })
      .then(function(rows){ return !!(rows[0] && rows[0].is_admin); })
      .catch(function(){ return false; });
  }

  function injectLinks(){
    var nav = document.querySelector('nav');
    if(!nav || nav.querySelector('[data-admin-nav]')) return;
    var tabs = nav.querySelector('.nav-tabs');       // league pages
    var rightGroup = nav.querySelector('#nav-links'); // other pages
    var container = tabs || rightGroup || nav;
    var cls = tabs ? 'nav-tab' : 'nav-link';
    var current = (location.pathname.split('/').pop() || '').toLowerCase();
    ADMIN_LINKS.forEach(function(l){
      if(l.href.toLowerCase() === current) return;   // don't link to the page we're on
      if(nav.querySelector('a[href="'+l.href+'"]')) return;  // already present (manual link)
      var a = document.createElement('a');
      a.href = l.href;
      a.textContent = l.label;
      a.setAttribute('data-admin-nav','1');
      a.className = cls;
      a.style.textDecoration = 'none';
      container.appendChild(a);
    });
  }

  // Inject account buttons (My Profile + Sign Out) on pages that don't build their
  // own. Pages with a #nav-actions container manage their own account buttons.
  function styleNavBtn(a){
    a.style.cssText = 'padding:1rem .95rem;font-family:var(--font-display);font-size:14px;font-weight:700;'
      + 'letter-spacing:.5px;text-transform:uppercase;color:rgba(255,255,255,.6);text-decoration:none;'
      + 'border-bottom:3px solid transparent;transition:all .15s;white-space:nowrap;cursor:pointer;background:none';
    a.addEventListener('mouseover', function(){ a.style.color='#fff'; });
    a.addEventListener('mouseout',  function(){ a.style.color='rgba(255,255,255,.6)'; });
  }

  function signOut(){
    try{
      for(var i=localStorage.length-1;i>=0;i--){
        var k=localStorage.key(i);
        if(/^sb-.*-auth-token$/.test(k)) localStorage.removeItem(k);
      }
      sessionStorage.removeItem('nac_admin_unlocked');
      localStorage.removeItem('nac_admin_unlocked');
    }catch(e){}
    window.location.href = 'dev-index.html';
  }

  function injectAccountButtons(){
    var nav = document.querySelector('nav');
    if(!nav) return;
    if(nav.querySelector('#nav-actions')) return;        // page builds its own account buttons
    if(nav.querySelector('[data-account-nav]')) return;  // already injected
    var current = (location.pathname.split('/').pop() || '').toLowerCase();

    var group = document.createElement('div');
    group.setAttribute('data-account-nav','1');
    group.style.cssText = 'display:flex;align-items:center;flex-wrap:wrap';

    if(current !== 'dev-dashboard.html'){
      var prof = document.createElement('a');
      prof.href = 'dev-dashboard.html'; prof.textContent = 'My Profile';
      styleNavBtn(prof); group.appendChild(prof);
    }
    var out = document.createElement('a');
    out.href = '#'; out.textContent = 'Sign Out';
    styleNavBtn(out);
    out.addEventListener('click', function(e){ e.preventDefault(); signOut(); });
    group.appendChild(out);

    var brand = nav.querySelector('.nav-brand');
    if(brand) nav.insertBefore(group, brand.nextSibling);
    else nav.insertBefore(group, nav.firstChild);
  }

  // ---- Partner invite banner (site-wide) -------------------------------
  // If anyone has chosen this user as their doubles partner and it's still
  // pending, show an Accept/Decline banner at the top of EVERY page until
  // they respond. The dashboard renders its own richer banner, so it's
  // skipped here to avoid doubles (pun intended).
  var LEAGUE_NAMES = {
    beginner:'All Ages Beginner', int1949:'19-49 Intermediate', int50:'50+ Intermediate',
    adv1949:'19-49 Advanced', adv50:'50+ Advanced', singles:'Singles League'
  };
  // Merge in custom leagues from the catalog so banner names stay correct
  fetch(SB_URL+'/rest/v1/pb_league?key=eq.nac_leagues&select=value',
    { headers:{ 'apikey':SB_KEY, 'Authorization':'Bearer '+SB_KEY } })
    .then(function(r){ return r.ok ? r.json() : []; })
    .then(function(rows){
      var lgs = rows[0] && rows[0].value && rows[0].value.leagues;
      if(Array.isArray(lgs)) lgs.forEach(function(l){ if(l && l.id) LEAGUE_NAMES[l.id] = l.name || l.id; });
    })
    .catch(function(){});

  function checkPartnerInvites(sess){
    var current = (location.pathname.split('/').pop() || '').toLowerCase();
    if(current === 'dev-dashboard.html') return;   // dashboard has its own banner
    if(document.querySelector('[data-invite-banner]')) return;

    // Active season id lives in the pb_league KV store under 'nac_seasons'
    fetch(SB_URL+'/rest/v1/pb_league?key=eq.nac_seasons&select=value',
      { headers:{ 'apikey':SB_KEY, 'Authorization':'Bearer '+SB_KEY } })
      .then(function(r){ return r.ok ? r.json() : []; })
      .then(function(rows){
        var seasonId = (rows[0] && rows[0].value && rows[0].value.active) || 'spring2026';
        return fetch(SB_URL+'/rest/v1/league_members'
          + '?partner_user_id=eq.'+encodeURIComponent(sess.uid)
          + '&partner_status=eq.pending&status=eq.active'
          + '&season_id=eq.'+encodeURIComponent(seasonId)
          + '&select=user_id,first_name,last_name,league_id',
          { headers:{ 'apikey':SB_KEY, 'Authorization':'Bearer '+sess.token } })
          .then(function(r){ return r.ok ? r.json() : []; })
          .then(function(invites){ if(invites.length) showInviteBanner(invites, seasonId, sess); });
      })
      .catch(function(){ /* silent — banner is best-effort */ });
  }

  function showInviteBanner(invites, seasonId, sess){
    var wrap = document.createElement('div');
    wrap.setAttribute('data-invite-banner','1');
    wrap.style.cssText = 'background:#f0f9ec;border-bottom:2px solid #4caf28;padding:10px max(1rem,env(safe-area-inset-left));font-family:Barlow,system-ui,sans-serif';
    invites.forEach(function(inv){
      var name = ((inv.first_name||'')+' '+(inv.last_name||'')).trim() || 'A player';
      var lg = LEAGUE_NAMES[inv.league_id] || inv.league_id;
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:center;max-width:1100px;margin:0 auto;padding:4px 0';
      row.innerHTML = '<span style="font-size:18px">🤝</span>'
        + '<span style="font-size:14px;color:#1a2a6c;flex:1;min-width:200px;text-align:left"><strong>'+name+'</strong> chose you as their doubles partner in <strong>'+lg+'</strong>. Accepting registers you as a team.</span>';
      var btns = document.createElement('div');
      btns.style.cssText = 'display:flex;gap:8px';
      var mkBtn = function(label, solid){
        var b = document.createElement('button');
        b.textContent = label;
        b.style.cssText = 'font-family:"Barlow Condensed",sans-serif;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;padding:7px 16px;border-radius:6px;cursor:pointer;border:1.5px solid #4caf28;'
          + (solid ? 'background:#4caf28;color:#fff' : 'background:transparent;color:#1a2a6c');
        return b;
      };
      var acceptB = mkBtn('Accept', true), declineB = mkBtn('Decline', false);
      var respond = function(action, btn){
        acceptB.disabled = declineB.disabled = true;
        btn.textContent = action==='accept' ? 'Accepting…' : 'Declining…';
        fetch(SB_URL+'/functions/v1/respond-partner-invite', {
          method:'POST',
          headers:{ 'Content-Type':'application/json', 'apikey':SB_KEY, 'Authorization':'Bearer '+sess.token },
          body: JSON.stringify({ fromUserId: inv.user_id, seasonId: seasonId, action: action })
        })
        .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ return { ok:r.ok, j:j }; }); })
        .then(function(res){
          if(!res.ok || !res.j.success) throw new Error(res.j.error || 'Request failed');
          location.reload();   // refresh page state (rosters, dashboards, etc.)
        })
        .catch(function(e){
          alert((action==='accept'?'Could not accept: ':'Could not decline: ') + (e.message || 'unknown error'));
          acceptB.disabled = declineB.disabled = false;
          acceptB.textContent = 'Accept'; declineB.textContent = 'Decline';
        });
      };
      acceptB.addEventListener('click', function(){ respond('accept', acceptB); });
      declineB.addEventListener('click', function(){ respond('decline', declineB); });
      btns.appendChild(acceptB); btns.appendChild(declineB);
      row.appendChild(btns);
      wrap.appendChild(row);
    });
    var nav = document.querySelector('nav');
    if(nav && nav.parentNode) nav.parentNode.insertBefore(wrap, nav.nextSibling);
    else document.body.insertBefore(wrap, document.body.firstChild);
  }

  // ── Mobile hamburger: collapse BOTH nav rows into one menu ───────────
  function esc(s){ return (s||'').replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }

  function injectHamburgerCSS(){
    if(document.getElementById('nac-hamburger-css')) return;
    var st = document.createElement('style');
    st.id = 'nac-hamburger-css';
    st.textContent =
      '.nav-hamburger{display:none;background:none;border:none;color:#fff;font-size:24px;line-height:1;cursor:pointer;padding:6px 10px;margin-left:auto}' +
      '.nav-panel{display:none;background:var(--navy,#1a2a6c);border-bottom:3px solid var(--green,#4caf28)}' +
      '.nav-panel.open{display:block}' +
      '.nav-panel a{display:block;padding:13px 22px;font-family:"Barlow Condensed",sans-serif;font-size:16px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:rgba(255,255,255,.78);text-decoration:none;border-top:1px solid rgba(255,255,255,.08)}' +
      '.nav-panel a:hover,.nav-panel a:active{background:rgba(255,255,255,.06);color:#fff}' +
      '.nav-panel a.np-active{color:var(--green,#4caf28)}' +
      '.nav-panel .np-greeting{padding:12px 22px 8px;font-family:"Barlow",sans-serif;font-size:14px;font-weight:600;color:rgba(255,255,255,.9)}' +
      '.nav-panel .np-divider{height:1px;background:rgba(255,255,255,.16);margin:0}' +
      '@media(min-width:769px){.nav-panel{display:none!important}}' +
      '@media(max-width:768px){' +
        '.nav-hamburger{display:block}' +
        'nav .nav-actions,nav .nav-right,nav [data-account-nav],nav .nav-tabs{display:none!important}' +
        'nav .nav-greeting{display:none!important}' +
        'nav{justify-content:space-between!important;flex-wrap:nowrap!important}' +
        'nav .nav-brand{width:auto!important;margin:0!important;justify-content:flex-start!important;padding:.5rem 0!important;flex:0 1 auto}' +
        'nav .nav-logo{height:42px!important}' +
      '}';
    document.head.appendChild(st);
  }

  // Gather every nav link + account item present right now.
  function collectNav(){
    var nav = document.querySelector('nav');
    var out = { greeting:'', links:[], account:[] };
    if(!nav) return out;
    var g = nav.querySelector('.nav-greeting');
    if(g) out.greeting = g.textContent.trim();
    nav.querySelectorAll('.nav-tab, .nav-link').forEach(function(a){
      var t = a.textContent.trim(); if(!t) return;
      out.links.push({ text:t, href:a.getAttribute('href'),
        active: a.classList.contains('active') || a.classList.contains('current') });
    });
    nav.querySelectorAll('#nav-actions a, #nav-actions button, [data-account-nav] a, [data-account-nav] button').forEach(function(a){
      var t = a.textContent.trim(); if(!t) return;
      out.account.push({ text:t, href: a.getAttribute && a.getAttribute('href'),
        signout: t.toLowerCase().indexOf('sign out') >= 0 });
    });
    return out;
  }

  function buildPanel(panel, closeFn){
    var d = collectNav();
    var html = '';
    if(d.greeting) html += '<div class="np-greeting">' + esc(d.greeting) + '</div>';
    d.links.forEach(function(l){
      html += '<a href="' + esc(l.href || '#') + '"' + (l.active ? ' class="np-active"' : '') + '>' + esc(l.text) + '</a>';
    });
    if(d.account.length){
      html += '<div class="np-divider"></div>';
      d.account.forEach(function(a){
        html += a.signout
          ? '<a href="#" data-signout="1">' + esc(a.text) + '</a>'
          : '<a href="' + esc(a.href || '#') + '">' + esc(a.text) + '</a>';
      });
    }
    panel.innerHTML = html;
    panel.querySelectorAll('a').forEach(function(a){
      a.addEventListener('click', function(e){
        if(a.getAttribute('data-signout')){ e.preventDefault(); signOut(); return; }
        closeFn();   // let navigation proceed
      });
    });
  }

  function setupHamburger(){
    var nav = document.querySelector('nav');
    if(!nav || nav.querySelector('.nav-hamburger')) return;
    var btn = document.createElement('button');
    btn.className = 'nav-hamburger';
    btn.setAttribute('aria-label', 'Menu');
    btn.innerHTML = '☰';
    nav.appendChild(btn);
    var panel = document.createElement('div');
    panel.className = 'nav-panel';
    nav.parentNode.insertBefore(panel, nav.nextSibling);
    function close(){ panel.classList.remove('open'); btn.innerHTML = '☰'; }
    function open(){ buildPanel(panel, close); panel.classList.add('open'); btn.innerHTML = '✕'; }
    btn.addEventListener('click', function(e){
      e.stopPropagation();
      panel.classList.contains('open') ? close() : open();
    });
    document.addEventListener('click', function(e){
      if(panel.classList.contains('open') && !panel.contains(e.target) && e.target !== btn) close();
    });
  }

  function run(){
    injectHamburgerCSS();             // mobile menu styles (everyone)
    setupHamburger();                 // collapse both nav rows into one menu
    var sess = getSession();
    if(!sess) return;                 // not signed in → no account/admin links to add
    injectAccountButtons();           // My Profile + Sign Out for any logged-in user
    checkAdmin(sess).then(function(isAdmin){ if(isAdmin) injectLinks(); });
    checkPartnerInvites(sess);        // partner invite Accept/Decline banner
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
