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
    var rightGroup = nav.querySelector('#nav-links'); // text-link group on the right, if any
    var current = (location.pathname.split('/').pop() || '').toLowerCase();
    ADMIN_LINKS.forEach(function(l){
      if(l.href.toLowerCase() === current) return;   // don't link to the page we're on
      if(nav.querySelector('a[href="'+l.href+'"]')) return;  // already present (manual link)
      var a = document.createElement('a');
      a.href = l.href;
      a.textContent = l.label;
      a.setAttribute('data-admin-nav','1');
      a.className = rightGroup ? 'nav-link' : '';
      a.style.cssText = 'color:rgba(255,255,255,.85);font-family:var(--font-display);font-size:13px;'
        + 'font-weight:700;text-transform:uppercase;letter-spacing:.5px;text-decoration:none;'
        + 'padding:.7rem 0;margin-right:1.2rem;white-space:nowrap';
      a.addEventListener('mouseover', function(){ a.style.color='#fff'; });
      a.addEventListener('mouseout',  function(){ a.style.color='rgba(255,255,255,.85)'; });
      if(rightGroup) rightGroup.appendChild(a);
      else nav.appendChild(a);
    });
  }

  function run(){
    var sess = getSession();
    if(!sess) return;                 // not signed in → nothing to add
    checkAdmin(sess).then(function(isAdmin){ if(isAdmin) injectLinks(); });
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
