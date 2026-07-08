// Passwords are no longer shipped to the browser. The score password is
// verified server-side by the submit-score edge function; admin access is
// account-based (profiles.is_admin) and verified by admin-save-data.
function nacGetScorePw(){ try{ return sessionStorage.getItem('nac_score_pw') || ''; }catch(e){ return ''; } }
function nacSetScorePw(pw){ try{ sessionStorage.setItem('nac_score_pw', pw||''); }catch(e){} }
async function nacVerifyScorePw(pw){
  try{
    const r = await fetch(`${SUPABASE_URL}/functions/v1/submit-score`, {
      method:'POST', headers:{ 'Content-Type':'application/json', 'apikey':SUPABASE_KEY, 'Authorization':'Bearer '+SUPABASE_KEY },
      body: JSON.stringify({ mode:'verify', pw })
    });
    if(r.ok){ nacSetScorePw(pw); return true; }
    return false;
  }catch(e){ return false; }
}
const SUPABASE_URL='https://owsvfvhlbagxxmncwmtn.supabase.co';
const SUPABASE_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im93c3ZmdmhsYmFneHhtbmN3bXRuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2NDQyMzksImV4cCI6MjA5NjIyMDIzOX0.AFemWKpLUuP8z1dAG5-j1X__EPyTdaqDFxece09-0EQ';

// Default league catalog — used until/unless a custom catalog is saved in the
// database (pb_league key 'nac_leagues'). Admins can add/remove leagues there.
const DEFAULT_LEAGUES = [
  {id:'beginner',  name:'All Ages Beginner',  key:'league_beginner',  type:'doubles', sub:'Under 3.0 rating'},
  {id:'int1949',   name:'19-49 Intermediate', key:'league_int1949',   type:'doubles', sub:'3.0 – 3.4 rating'},
  {id:'int50',     name:'50+ Intermediate',   key:'league_int50',     type:'doubles', sub:'3.0 – 3.4 rating'},
  {id:'adv1949',   name:'19-49 Advanced',     key:'league_adv1949',   type:'doubles', sub:'3.5 & up rating'},
  {id:'adv50',     name:'50+ Advanced',       key:'league_adv50',     type:'doubles', sub:'3.5 & up rating'},
  {id:'singles',   name:'Singles League',     key:'league_singles',   type:'singles', sub:'Open singles league'},
];
let LEAGUES = DEFAULT_LEAGUES.map(l => ({...l}));
let leaguesLoaded = false;

async function loadLeagues(){
  try{
    const r = await dbGet('nac_leagues');
    if(r && r.data && Array.isArray(r.data.leagues) && r.data.leagues.length){
      LEAGUES = r.data.leagues.map(l => ({...l, key: l.key || ('league_' + l.id)}));
    }
    leaguesLoaded = true;
  }catch(e){ console.warn('League catalog load failed (using defaults):', e); }
}

async function saveLeagues(){
  return dbSet('nac_leagues', { leagues: LEAGUES, updated: Date.now() });
}

// Leagues enabled for a given season. Older seasons (no enabledLeagues field)
// get the whole catalog.
function seasonLeagues(season){
  const en = season && season.enabledLeagues;
  if(!Array.isArray(en)) return LEAGUES;
  return LEAGUES.filter(l => en.includes(l.id));
}

function leagueName(id){
  const l = LEAGUES.find(x => x.id === id);
  return l ? l.name : id;
}

// League data always starts EMPTY and is filled from the database by loadData().
// (The old hardcoded demo schedule/players that used to live here caused fake
// players like "Jordan C." to appear — and get saved — when a league had no
// data yet or a fetch failed.)
let schedule = [];
let PLAYERS = [];

// ---- Display names -------------------------------------------------------
// The canonical player identity everywhere (schedules, PLAYERS, DUPR keys) is
// "First L." — that must never change, or matching against saved data breaks.
// For DISPLAY we map those identities to full names ("Jordan C." -> "Jordan
// Cooper") using the league's registrations. loadData() refreshes the map.
// NEVER use displayName() output for lookups or comparisons.
let FULL_NAMES = {};        // "jordan c." -> "Jordan Cooper"

function displayName(n){
  if(!n) return '';
  // Team strings like "Alice A. / Bob B." or "Alice A. & Bob B." — resolve each side.
  if(n.includes(' / ')) return n.split(' / ').map(displayName).join(' / ');
  if(n.includes(' & ')) return n.split(' & ').map(displayName).join(' & ');
  const full = FULL_NAMES[n.trim().toLowerCase()];
  if(full) return full;
  // Fallback: strip the period from a single-letter initial (" C." -> " C"),
  // leaving legitimate periods in names like "St. John" untouched.
  return n.replace(/(\s[A-Za-z])\.(?=\s|$)/g, '$1');
}

function deriveScheduleName(first, last){
  // Full name is the player's identity across schedules, standings, brackets,
  // DUPR sync, and rosters. (Was "First L." — now full last name.)
  return `${(first||'').trim()} ${(last||'').trim()}`.trim();
}

async function buildFullNameMap(seasonId){
  FULL_NAMES = {};
  if(!currentLeague) return;
  try{
    const members = await loadLeagueMembers(currentLeague.id, seasonId);
    const ambiguous = new Set();
    const add = (key, full) => {
      key = (key||'').toLowerCase(); full = (full||'').trim();
      if(!key || !full) return;
      if(ambiguous.has(key)) return;
      if(FULL_NAMES[key] && FULL_NAMES[key] !== full){
        // Two different people derive the same "First L." — can't safely map.
        delete FULL_NAMES[key]; ambiguous.add(key); return;
      }
      FULL_NAMES[key] = full;
    };
    for(const m of (members||[])){
      const full = `${m.first_name||''} ${m.last_name||''}`.trim();
      add(deriveScheduleName(m.first_name, m.last_name), full);                 // current (full-name) key
      const li = `${(m.first_name||'').trim()} ${((m.last_name||'').trim())[0]||''}.`.trim();
      add(li, full);                                                            // legacy "First L." key → full name
      if(m.partner_name){
        const parts = m.partner_name.trim().split(/\s+/);
        if(parts.length > 1) add(`${parts[0]} ${parts[parts.length-1][0]}.`, m.partner_name);
      }
    }
  }catch(e){ console.warn('full-name map failed:', e); }
}
let scheduleWeek=1, scoresWeek=1, currentModalMatch=null, lastSynced=null;
let scoreAuthed=false;
let currentLeague=null; // full league object from LEAGUES array
let currentSeason=null;  // { id, name } e.g. { id:'spring2026', name:'Spring 2026' }
let allSeasons=[];        // list of all seasons
let viewingSeason=null;   // season being viewed (may differ from active if browsing history)

function getLeagueFromURL(){
  const params=new URLSearchParams(window.location.search);
  const id=params.get('league');
  return LEAGUES.find(l=>l.id===id)||null;
}
function getSeasonFromURL(){
  return new URLSearchParams(window.location.search).get('season')||null;
}
function seasonKey(leagueKey, seasonId){
  return `${leagueKey}_${seasonId}`;
}

async function dbGet(key){
  try{
    const r=await fetch(`${SUPABASE_URL}/rest/v1/pb_league?key=eq.${encodeURIComponent(key)}&select=value`,{headers:{'apikey':SUPABASE_KEY,'Authorization':'Bearer '+SUPABASE_KEY}});
    if(!r.ok){console.error('DB fetch failed:',r.status);return{error:true};}
    const data=await r.json();
    return data.length?{data:data[0].value}:{empty:true};
  }catch(e){console.error('DB fetch exception:',e);return{error:true};}
}
async function dbSet(key,val){
  // Admin writes go through the admin-save-data edge function, which verifies
  // the caller's account is an admin. Anon writes to pb_league are disabled.
  try{
    const sess = nacGetSession();
    if(!sess){ console.error('DB save blocked: not signed in as an admin'); return false; }
    const r = await fetch(`${SUPABASE_URL}/functions/v1/admin-save-data`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'apikey':SUPABASE_KEY,
                'Authorization':'Bearer '+SUPABASE_KEY, 'x-user-token': sess.token },
      body: JSON.stringify({ key, value: val })
    });
    if(!r.ok){ const d = await r.json().catch(()=>({})); console.error('DB save failed:', r.status, d.error||''); return false; }
    return true;
  }catch(e){console.error('DB save exception:',e);return false;}
}
const DUPR_EDGE_URL = 'https://owsvfvhlbagxxmncwmtn.supabase.co/functions/v1/dupr-submit-match';

// Fetch DUPR IDs for players in a match
async function getDuprIds(playerNames){
  if(!playerNames.length) return {};
  try{
    const names = playerNames.map(n => `player_name.eq.${encodeURIComponent(n)}`).join(',');
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/dupr_players?league_key=eq.${encodeURIComponent(currentLeague?.id||'')}&or=(${names})&select=player_name,dupr_id`,
      {headers:{'apikey':SUPABASE_KEY,'Authorization':'Bearer '+SUPABASE_KEY}}
    );
    if(!r.ok) return {};
    const rows = await r.json();
    const map = {};
    for(const row of rows) map[row.player_name] = row.dupr_id;
    return map;
  }catch(e){ return {}; }
}

// (matchCode is now persisted server-side by the dupr-submit-match function,
// keyed by a stable identifier, so admins can update/delete the match later.)

async function submitToDUPR(week, matchIdx, m, games){
  if(!currentLeague) return;
  const r = seriesResult(m);
  const isDoubles = m.p1a !== undefined;
  const format = isDoubles ? 'DOUBLES' : 'SINGLES';

  // Get all player names in this match
  const playerNames = isDoubles
    ? [m.p1a, m.p1b, m.p2a, m.p2b].filter(Boolean)
    : [m.p1, m.p2].filter(Boolean);

  // Look up DUPR IDs
  const duprIds = await getDuprIds(playerNames);

  // Only submit if ALL players have linked DUPR accounts
  const allLinked = playerNames.every(p => duprIds[p]);
  if(!allLinked){
    const unlinked = playerNames.filter(p => !duprIds[p]);
    console.log('DUPR submission skipped — unlinked players:', unlinked);
    return;
  }

  // Build game scores for DUPR (they want each game separately)
  // Use the last completed series result
  const completedGames = games.filter(g => g.s1 !== null && g.s2 !== null);
  if(!completedGames.length) return;

  const teamA = isDoubles
    ? { player1: duprIds[m.p1a], player2: duprIds[m.p1b] }
    : { player1: duprIds[m.p1] };
  const teamB = isDoubles
    ? { player1: duprIds[m.p2a], player2: duprIds[m.p2b] }
    : { player1: duprIds[m.p2] };

  // Add game scores
  completedGames.forEach((g, i) => {
    const gNum = i + 1;
    teamA[`game${gNum}`] = g.s1;
    teamB[`game${gNum}`] = g.s2;
  });

  try{
    const res = await fetch(DUPR_EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type':'application/json',
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'apikey': SUPABASE_KEY
      },
      body: JSON.stringify({
        match: { teamA, teamB },
        leagueKey: currentLeague.key,
        leagueName: currentLeague.name,
        seasonId: (viewingSeason?.id || currentSeason?.id || null),
        week,
        matchNum: matchIdx + 1,
        format
      })
    });
    const data = await res.json();
    if(data.success){
      console.log('DUPR match submitted successfully:', data.matchCode);
    } else {
      console.warn('DUPR submission failed:', data.error, data.details);
    }
  }catch(e){
    console.warn('DUPR Edge Function error:', e);
  }
}


// Fire-and-forget admin email notification via the notify-email edge function.
function notifyEmail(type, data){
  try{
    fetch(`${SUPABASE_URL}/functions/v1/notify-email`, {
      method:'POST', keepalive:true,
      headers:{ 'Content-Type':'application/json', 'apikey':SUPABASE_KEY, 'Authorization':'Bearer '+SUPABASE_KEY },
      body: JSON.stringify({ type, data })
    }).catch(()=>{});
  }catch(e){ /* never block the app on a notification */ }
}

async function loadSeasons(){
  if(!leaguesLoaded) await loadLeagues();
  try {
    const result = await dbGet('nac_seasons');
    if(result && result.data && result.data.seasons){
      allSeasons = result.data.seasons;
      const activeId = result.data.active;
      currentSeason = allSeasons.find(s=>s.id===activeId) || allSeasons[0] || null;
    } else {
      // First time — create default Spring 2026 season
      currentSeason = {id:'spring2026', name:'Spring 2026', created: new Date().toISOString()};
      allSeasons = [currentSeason];
      await saveSeasons(currentSeason.id);
    }
    viewingSeason = viewingSeason || currentSeason;
  } catch(e) {
    console.warn('Could not load seasons:', e);
    currentSeason = {id:'spring2026', name:'Spring 2026'};
    allSeasons = [currentSeason];
    viewingSeason = currentSeason;
  }
}
async function saveSeasons(activeId){
  await dbSet('nac_seasons', {active: activeId, seasons: allSeasons});
}
async function startNewSeason(name, leagueTypes, regDeadline, leagueWeeks, enabledLeagues){
  const id = name.toLowerCase().replace(/[^a-z0-9]/g,'');
  const newSeason = {
    id, name,
    created: new Date().toISOString(),
    leagueTypes: leagueTypes || {},
    leagueWeeks: leagueWeeks || {},   // weeks per league (default 8 when unset)
    enabledLeagues: Array.isArray(enabledLeagues) ? enabledLeagues : LEAGUES.map(l=>l.id),
    regDeadline: regDeadline || null,
    regOpen: true,
    scheduleGenerated: {}
  };
  allSeasons.push(newSeason);
  currentSeason = newSeason;
  viewingSeason = newSeason;
  await saveSeasons(id);
  return newSeason;
}

// Persist changes to the seasons array (used for toggling regOpen, scheduleGenerated, etc.)
async function updateSeasonField(seasonId, updates){
  const s = allSeasons.find(x => x.id === seasonId);
  if(!s) return;
  Object.assign(s, updates);
  await saveSeasons(currentSeason?.id || seasonId);
}

// Check if registration is open for the active season
function isRegistrationOpen(season){
  if(!season) return false;
  if(season.regOpen === false) return false;
  if(season.regDeadline){
    const deadline = new Date(season.regDeadline + 'T23:59:59');
    if(new Date() > deadline) return false;
  }
  return true;
}

// Load registered members for a league + season
async function loadLeagueMembers(leagueId, seasonId){
  try{
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/league_members?league_id=eq.${encodeURIComponent(leagueId)}&season_id=eq.${encodeURIComponent(seasonId)}&status=eq.active&select=*`,
      {headers:{'apikey':SUPABASE_KEY,'Authorization':'Bearer '+SUPABASE_KEY}}
    );
    if(!r.ok) return [];
    return await r.json();
  }catch(e){ console.warn('loadLeagueMembers failed:', e); return []; }
}

// Has the admin generated a schedule for this league/season?
function isScheduleGenerated(season, leagueId){
  if(!season) return true;
  // Legacy seasons created before this feature have no scheduleGenerated field —
  // treat them as already published so existing standings display normally.
  if(!season.scheduleGenerated) return true;
  return !!season.scheduleGenerated[leagueId];
}
function leagueWeekCount(season, leagueId){
  const w = season && season.leagueWeeks && season.leagueWeeks[leagueId];
  const n = parseInt(w, 10);
  return (n >= 1 && n <= 30) ? n : 8;   // default 8 weeks
}

// ---- Account admin detection (no supabase-js needed) ----------------------
// Reads the Supabase auth session straight from localStorage so pages that
// don't load the supabase-js SDK (league/bracket/playoff) can still tell
// whether the signed-in user is an admin.
function nacGetSession(){
  try{
    var ref = (SUPABASE_URL.match(/^https?:\/\/([^.]+)\./) || [])[1] || '';
    var raw = ref ? localStorage.getItem('sb-'+ref+'-auth-token') : null;
    if(!raw){
      for(var i=0;i<localStorage.length;i++){
        var k = localStorage.key(i);
        if(/^sb-.*-auth-token$/.test(k)){ raw = localStorage.getItem(k); break; }
      }
    }
    if(!raw) return null;
    var obj = JSON.parse(raw);
    var s = obj.currentSession || obj;
    var token = s.access_token;
    if(!token) return null;
    var uid = (s.user && s.user.id) || null;
    if(!uid){
      var part = token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
      uid = JSON.parse(atob(part)).sub || null;
    }
    return uid ? { token: token, uid: uid } : null;
  }catch(e){ return null; }
}

async function checkAccountAdmin(){
  try{
    const sess = nacGetSession();
    if(!sess) return false;
    const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${sess.uid}&select=is_admin`,
      { headers:{ 'apikey':SUPABASE_KEY, 'Authorization':'Bearer '+sess.token } });
    if(!r.ok) return false;
    const rows = await r.json();
    return !!(rows[0] && rows[0].is_admin);
  }catch(e){ return false; }
}

// ---- Playoff seeding (shared by admin + public postseason pages) ----------
// Entrants for the currently-loaded league, best record first, with W/L.
// isTeam=true -> partnerships ("A & B"); else individuals.
function computePlayoffEntrants(isTeam){
  if(isTeam){
    const teamStats = {};
    const teamOf = (x, y) => {
      const key = [x, y].filter(Boolean).map(v=>v.toLowerCase()).sort().join('|');
      if(!key) return null;
      if(!teamStats[key]) teamStats[key] = { name:[x,y].filter(Boolean).join(' & '), w:0,l:0,pts:0,opp:0 };
      return teamStats[key];
    };
    for(const w of schedule)for(const m of w.matches){
      if(m.p1a===undefined) continue;
      teamOf(m.p1a, m.p1b); teamOf(m.p2a, m.p2b);
      const r = seriesResult(m);
      if(!r.complete) continue;
      const t1 = teamOf(m.p1a, m.p1b), t2 = teamOf(m.p2a, m.p2b);
      if(!t1 || !t2) continue;
      const t1won = r.p1w > r.p2w;
      const wt = t1won ? t1 : t2, lt = t1won ? t2 : t1;
      wt.w++; wt.pts += t1won ? r.pts1 : r.pts2; wt.opp += t1won ? r.pts2 : r.pts1;
      lt.l++; lt.pts += t1won ? r.pts2 : r.pts1; lt.opp += t1won ? r.pts1 : r.pts2;
    }
    return Object.values(teamStats).map(s => {
      const tot = s.w + s.l;
      return {name:s.name, w:s.w, l:s.l, pct:tot?s.w/tot:0, diff:s.pts-s.opp};
    }).sort((a,b) => b.pct-a.pct||b.diff-a.diff);
  }
  const stats = getStats();
  return getActivePlayers().map(p => {
    const s = stats[p] || {w:0,l:0,pts:0,opp:0};
    const tot = s.w + s.l;
    return {name:p, w:s.w, l:s.l, pct:tot?s.w/tot:0, diff:s.pts-s.opp};
  }).sort((a,b) => b.pct-a.pct||b.diff-a.diff);
}

// Single-elimination bracket from 4 seed names (#1v#4, #2v#3).
function buildBracketData(seedNames, isTeam){
  const ent = computePlayoffEntrants(isTeam);
  const recOf = (n) => ent.find(e=>e.name===n) || {w:0,l:0};
  const seeds = (seedNames||[]).map((name,i)=>{ const r = recOf(name); return {name, w:r.w, l:r.l, seed:i+1}; });
  return {
    seeds,
    semis: [
      {p1: seeds[0]?.name||'TBD', p2: seeds[3]?.name||'TBD', games:[], winner:null},
      {p1: seeds[1]?.name||'TBD', p2: seeds[2]?.name||'TBD', games:[], winner:null},
    ],
    final: {p1:null, p2:null, games:[], winner:null},
    champion: null,
  };
}

// Round-robin playoff from 4 seed names (rotating-partner format).
function buildPlayoffData(seedNames){
  const seeds = ['','','',''];
  for(let i=0;i<4;i++) seeds[i] = (seedNames && seedNames[i]) || '';
  const matches = [
    {label:'Match 1', team1:[0,3], team2:[1,2], s1:null, s2:null},
    {label:'Match 2', team1:[0,2], team2:[1,3], s1:null, s2:null},
    {label:'Match 3', team1:[0,1], team2:[2,3], s1:null, s2:null},
  ];
  return {seeds, matches};
}

function isViewingActiveSeason(){
  return viewingSeason && currentSeason && viewingSeason.id === currentSeason.id;
}

async function loadData(){
  if(!currentLeague)return;
  const seasonId = viewingSeason?.id || currentSeason?.id || 'spring2026';
  const key = seasonKey(currentLeague.key, seasonId);
  console.log('Loading data from key:', key);
  const result=await dbGet(key);
  if(result.data){
    schedule = result.data.schedule || [];
    PLAYERS = result.data.players || [];
  } else if(result.empty){
    // No saved schedule for this league/season — start empty.
    // (Don't fall back to the hardcoded default players.)
    schedule = [];
    PLAYERS = [];
  }
  // On a network error (result.error) keep whatever is currently loaded.
  await buildFullNameMap(seasonId);   // "First L." -> full name (display only)
  lastSynced=new Date();
}
async function saveData(){
  if(!schedule||!schedule.length||!schedule[0].matches||!schedule[0].matches.length){
    showToast('Save blocked — schedule looks empty!');return false;
  }
  // Always use season key — default to spring2026 if seasons not loaded yet
  const seasonId = viewingSeason?.id || currentSeason?.id || 'spring2026';
  const key = seasonKey(currentLeague.key, seasonId);
  const ok=await dbSet(key,{schedule,players:PLAYERS,updated:Date.now()});
  lastSynced=new Date();return ok;
}

function seriesResult(m){
  const games=m.games||[];
  let p1w=0,p2w=0,pts1=0,pts2=0;
  for(const g of games){
    if(g.s1===null||g.s2===null)continue;
    if(g.s1>g.s2)p1w++;else if(g.s2>g.s1)p2w++;
    pts1+=g.s1;pts2+=g.s2;
  }
  const complete=p1w>=2||p2w>=2;
  const isDoubles=m.p1a!==undefined;
  const team1=isDoubles?`${m.p1a} / ${m.p1b}`:m.p1;
  const team2=isDoubles?`${m.p2a} / ${m.p2b}`:m.p2;
  const winner=complete?(p1w>p2w?team1:team2):null;
  const loser=complete?(p1w>p2w?team2:team1):null;
  return{p1w,p2w,pts1,pts2,complete,winner,loser,seriesStr:p1w+'-'+p2w,team1,team2,isDoubles};
}

function getActivePlayers(){
  const seen=new Set();
  for(const w of schedule)for(const m of w.matches){
    if(m.p1a!==undefined){[m.p1a,m.p1b,m.p2a,m.p2b].forEach(p=>{if(p)seen.add(p);});}
    else{if(m.p1)seen.add(m.p1);if(m.p2)seen.add(m.p2);}
  }
  const ordered=PLAYERS.filter(p=>seen.has(p));
  seen.forEach(p=>{if(!ordered.includes(p))ordered.push(p);});
  return ordered;
}

function getStats(){
  const active=getActivePlayers();
  const s={};for(const p of active)s[p]={w:0,l:0,pts:0,opp:0,streak:[]};
  for(const w of schedule)for(const m of w.matches){
    const r=seriesResult(m);
    if(r.complete){
      if(r.isDoubles){
        const wp=r.p1w>r.p2w?[m.p1a,m.p1b]:[m.p2a,m.p2b];
        const lp=r.p1w>r.p2w?[m.p2a,m.p2b]:[m.p1a,m.p1b];
        const wpts=r.p1w>r.p2w?r.pts1:r.pts2,lpts=r.p1w>r.p2w?r.pts2:r.pts1;
        for(const p of wp.filter(Boolean)){if(s[p]){s[p].w++;s[p].pts+=wpts;s[p].opp+=lpts;s[p].streak.push('W');}}
        for(const p of lp.filter(Boolean)){if(s[p]){s[p].l++;s[p].pts+=lpts;s[p].opp+=wpts;s[p].streak.push('L');}}
      }else{
        if(s[r.winner]){s[r.winner].w++;s[r.winner].pts+=r.winner===m.p1?r.pts1:r.pts2;s[r.winner].opp+=r.winner===m.p1?r.pts2:r.pts1;s[r.winner].streak.push('W');}
        if(s[r.loser]){s[r.loser].l++;s[r.loser].pts+=r.loser===m.p1?r.pts1:r.pts2;s[r.loser].opp+=r.loser===m.p1?r.pts2:r.pts1;s[r.loser].streak.push('L');}
      }
    }
  }
  return s;
}

function findCurrentWeek(){
  for(const w of schedule)if(w.matches.some(m=>!seriesResult(m).complete))return w.week;
  return schedule.length||1;
}

function renderWeekTabs(cid,aw,fn){
  const cur=findCurrentWeek();
  document.getElementById(cid).innerHTML=schedule.map(w=>
    `<button class="week-btn${w.week===aw?' active':''}" onclick="${fn}(${w.week})">Wk ${w.week}${w.week===cur?' ●':''}</button>`
  ).join('');
}

function matchCardHTML(m,i,showScoreBtn){
  const r=seriesResult(m);
  const gamesPlayed=(m.games||[]).filter(g=>g.s1!==null).length;
  const scoreStr=r.complete
    ?`<span style="color:var(--green-dark);font-size:13px;font-weight:700">${displayName(r.winner)}</span> wins ${r.p1w>r.p2w?r.p1w+'-'+r.p2w:r.p2w+'-'+r.p1w}`
    :(gamesPlayed>0?`Game ${gamesPlayed+1}`:'—');
  const playersHTML=r.isDoubles
    ?`<div class="doubles-match-layout">
        <div class="doubles-team${r.winner===r.team1?' winner':''}">
          <span class="match-player${r.winner===r.team1?' winner':''}">${displayName(m.p1a)}</span>
          <span class="match-player${r.winner===r.team1?' winner':''}">${displayName(m.p1b)}</span>
        </div>
        <span class="vs-badge">vs</span>
        <div class="doubles-team${r.winner===r.team2?' winner':''}">
          <span class="match-player${r.winner===r.team2?' winner':''}">${displayName(m.p2a)}</span>
          <span class="match-player${r.winner===r.team2?' winner':''}">${displayName(m.p2b)}</span>
        </div>
      </div>`
    :`<div class="match-players">
        <span class="match-player${r.winner===r.team1?' winner':''}">${displayName(m.p1)}</span>
        <span class="vs-badge">vs</span>
        <span class="match-player${r.winner===r.team2?' winner':''}">${displayName(m.p2)}</span>
      </div>`;
  const actionHTML=showScoreBtn
    ?`<button class="score-btn" onclick="openModal(${m._week},${i})">${r.complete?'Edit':'Enter Scores'}</button>`
    :`<div class="match-status${r.complete?'':' pending'}">${r.complete?'Final':'Pending'}</div>`;
  return`<div class="match-card${r.complete?' completed':' upcoming'}">
    <div class="match-num">Match ${i+1}</div>
    ${playersHTML}
    <div class="match-score" style="font-size:13px;min-width:110px">${scoreStr}</div>
    ${actionHTML}
  </div>`;
}

function byeCardHTML(byePlayer){
  if(!byePlayer)return'';
  return`<div style="background:var(--surface);border:1px dashed var(--border);border-radius:var(--radius-lg);padding:10px 18px;display:flex;align-items:center;gap:16px;color:var(--muted)"><div class="match-num">BYE</div><div style="flex:1;font-size:14px"><span style="font-weight:600;color:var(--navy)">${displayName(byePlayer)}</span> has a bye this week</div></div>`;
}

function showToast(msg){
  const t=document.getElementById('toast');
  if(!t)return;
  t.textContent=msg;t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),2500);
}

// Score modal logic (shared)
function openModal(week,idx){
  const m=schedule.find(w=>w.week===week).matches[idx];
  m._week=week;
  currentModalMatch={week,idx};
  const r=seriesResult(m);
  document.getElementById('modal-p1').textContent=displayName(r.team1);
  document.getElementById('modal-p2').textContent=displayName(r.team2);
  const r2=seriesResult(m);
  const lbl1=document.getElementById('col-p1-label');
  if(lbl1)lbl1.textContent=r2.isDoubles?m.p1a.split(' ')[0]+'/'+m.p1b.split(' ')[0]:m.p1.split(' ')[0];
  const lbl2=document.getElementById('col-p2-label');
  if(lbl2)lbl2.textContent=r2.isDoubles?m.p2a.split(' ')[0]+'/'+m.p2b.split(' ')[0]:m.p2.split(' ')[0];
  document.getElementById('submit-btn').disabled=false;
  renderModalGames(m);
  document.getElementById('score-modal').classList.add('open');
}
function closeModal(){
  document.getElementById('score-modal').classList.remove('open');
  currentModalMatch=null;
}
function renderModalGames(m){
  const games=m.games&&m.games.length?m.games:[{s1:null,s2:null},{s1:null,s2:null},{s1:null,s2:null}];
  while(games.length<3)games.push({s1:null,s2:null});
  let p1w=0,p2w=0;
  for(let i=0;i<2;i++){
    const g=games[i];
    if(g.s1!==null&&g.s2!==null&&g.s1!==g.s2){if(g.s1>g.s2)p1w++;else p2w++;}
  }
  const sweep=p1w>=2||p2w>=2;
  document.getElementById('modal-games').innerHTML=games.map((g,i)=>{
    const locked=i===2&&sweep;
    const p1win=g.s1!==null&&g.s2!==null&&g.s1>g.s2;
    const p2win=g.s1!==null&&g.s2!==null&&g.s2>g.s1;
    return`<div class="game-row${locked?' game-row-disabled':''}">
      <span class="game-label">Game ${i+1}</span>
      <input class="game-input${p1win?' winner':''}" type="number" min="0" max="30" id="g${i}_s1" value="${g.s1!==null?g.s1:''}" placeholder="0" ${locked?'disabled':''} oninput="onGameInput()"/>
      <div class="game-dash">—</div>
      <input class="game-input${p2win?' winner':''}" type="number" min="0" max="30" id="g${i}_s2" value="${g.s2!==null?g.s2:''}" placeholder="0" ${locked?'disabled':''} oninput="onGameInput()"/>
    </div>`;
  }).join('');
  updateSeriesStatus();
}
function onGameInput(){
  let p1w=0,p2w=0;
  for(let i=0;i<3;i++){
    const inp1=document.getElementById('g'+i+'_s1');
    const inp2=document.getElementById('g'+i+'_s2');
    if(!inp1||!inp2)continue;
    const s1=parseInt(inp1.value),s2=parseInt(inp2.value);
    if(!isNaN(s1)&&!isNaN(s2)&&s1!==s2){
      if(s1>s2){p1w++;inp1.classList.add('winner');inp2.classList.remove('winner');}
      else{p2w++;inp2.classList.add('winner');inp1.classList.remove('winner');}
    }else{inp1.classList.remove('winner');inp2.classList.remove('winner');}
  }
  let g1p1w=0,g1p2w=0;
  for(let i=0;i<2;i++){
    const s1=parseInt(document.getElementById('g'+i+'_s1')?.value);
    const s2=parseInt(document.getElementById('g'+i+'_s2')?.value);
    if(!isNaN(s1)&&!isNaN(s2)&&s1!==s2){if(s1>s2)g1p1w++;else g1p2w++;}
  }
  const sweep=g1p1w>=2||g1p2w>=2;
  const g3s1=document.getElementById('g2_s1'),g3s2=document.getElementById('g2_s2');
  const g3row=g3s1?.closest('.game-row');
  if(g3s1&&g3s2){
    g3s1.disabled=sweep;g3s2.disabled=sweep;
    if(g3row){sweep?g3row.classList.add('game-row-disabled'):g3row.classList.remove('game-row-disabled');}
    if(sweep){g3s1.value='';g3s2.value='';}
  }
  updateSeriesStatus();
}
function updateSeriesStatus(){
  let p1w=0,p2w=0;
  const p1=document.getElementById('modal-p1').textContent;
  const p2=document.getElementById('modal-p2').textContent;
  for(let i=0;i<3;i++){
    const s1=parseInt(document.getElementById('g'+i+'_s1')?.value);
    const s2=parseInt(document.getElementById('g'+i+'_s2')?.value);
    if(!isNaN(s1)&&!isNaN(s2)&&s1!==s2){if(s1>s2)p1w++;else p2w++;}
  }
  const el=document.getElementById('modal-series-status');
  if(!el)return;
  if(p1w>=2||p2w>=2){
    const winner=p1w>p2w?p1:p2;
    el.innerHTML=`<span class="series-badge complete">✓ ${winner} wins the series ${Math.max(p1w,p2w)}-${Math.min(p1w,p2w)}</span>`;
  }else if(p1w>0||p2w>0){
    el.innerHTML=`<span class="series-badge inprog">${p1} ${p1w} – ${p2w} ${p2}</span>`;
  }else{el.innerHTML='';}
}
async function submitScore(){
  const games=[];
  for(let i=0;i<3;i++){
    const s1v=document.getElementById('g'+i+'_s1').value;
    const s2v=document.getElementById('g'+i+'_s2').value;
    const s1=s1v===''?null:parseInt(s1v);
    const s2=s2v===''?null:parseInt(s2v);
    if(s1!==null||s2!==null){
      if(s1===null||s2===null||s1<0||s2<0||isNaN(s1)||isNaN(s2)){showToast('Complete all started game scores!');return;}
      if(s1===s2){showToast('No ties in pickleball!');return;}
    }
    games.push({s1,s2});
  }
  if(games[0].s1===null){showToast('Enter at least Game 1 scores!');return;}
  document.getElementById('submit-btn').disabled=true;
  const{week,idx}=currentModalMatch;
  schedule.find(w=>w.week===week).matches[idx].games=games;
  const m=schedule.find(w=>w.week===week).matches[idx];
  const r=seriesResult(m);
  // Server applies the score to the authoritative schedule, appends the score
  // log, and sends the admin email. The score password (or an admin session)
  // is verified server-side. Scorers can ONLY change game scores.
  let ok=false;
  try{
    const sess = nacGetSession();
    const seasonId = viewingSeason?.id || currentSeason?.id || 'spring2026';
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/submit-score`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'apikey':SUPABASE_KEY,
                'Authorization':'Bearer '+SUPABASE_KEY,
                ...(sess ? { 'x-user-token': sess.token } : {}) },
      body: JSON.stringify({ mode:'match', pw: nacGetScorePw(),
        leagueKey: currentLeague.key, seasonId, leagueName: currentLeague.name,
        week, matchIdx: idx, games, winner: r.winner, team1: r.team1, team2: r.team2 })
    });
    ok = resp.ok;
    if(!ok){ const d = await resp.json().catch(()=>({})); console.error('Score save failed:', d.error||resp.status); }
  }catch(e){ console.error('Score save exception:', e); }
  // DUPR submission is admin-initiated from the DUPR Matches page.
  closeModal();
  if(typeof renderScoreMatches==='function')renderScoreMatches(week);
  if(typeof renderStandings==='function')renderStandings();
  showToast(ok?'Series saved!':'Saved locally — check DB connection');
}
