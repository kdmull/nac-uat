/*
 * tournament-engine.js — pure tournament logic (no DOM, no network).
 * Used by the admin tournament tools and the public tournament page.
 *
 * DATA SHAPES
 * Division state (stored in pb_league under key `tourney_<tid>_<divId>`):
 * {
 *   teams: [{ name, players:[..], seed }],          // seed 1 = strongest
 *   pools: [[teamIdx, ...], ...],                   // indices into teams
 *   poolMatches: [{ pool, round, t1, t2, games:[{s1,s2},...] }],
 *   bracket: { size, rounds:[ [ {t1,t2,s1,s2}, ... ], ... ] },  // t = teamIdx or null (bye/TBD)
 *   phase: 'setup' | 'pools' | 'knockout' | 'complete',
 *   updated: <ms>
 * }
 */

// ── Pools ────────────────────────────────────────────────────────────────
// Snake-seed teams (ordered by seed, 1 first) into pools of ~poolSize.
function tePoolCount(nTeams, poolSize){
  return Math.max(1, Math.round(nTeams / poolSize)) || 1;
}
// Snake-seed into an EXACT number of pools (e.g. force 1 or 2 pools).
function teSeedPoolsN(teamCount, nPools){
  nPools = Math.max(1, Math.min(nPools, teamCount));
  const pools = Array.from({length:nPools}, () => []);
  let p = 0, dir = 1;
  for(let seedIdx = 0; seedIdx < teamCount; seedIdx++){
    pools[p].push(seedIdx);
    p += dir;
    if(p === nPools){ p = nPools - 1; dir = -1; }     // snake back
    else if(p < 0){ p = 0; dir = 1; }
  }
  return pools;
}
function teSeedPools(teamCount, poolSize){
  return teSeedPoolsN(teamCount, tePoolCount(teamCount, poolSize));
}

// Round-robin pairings for one pool (circle method). Returns rounds of [a,b] team-index pairs.
function teRoundRobin(idxs){
  const arr = idxs.slice();
  if(arr.length % 2 === 1) arr.push(null);            // bye slot
  const n = arr.length, rounds = [];
  for(let r = 0; r < n - 1; r++){
    const pairs = [];
    for(let i = 0; i < n/2; i++){
      const a = arr[i], b = arr[n-1-i];
      if(a !== null && b !== null) pairs.push([a, b]);
    }
    rounds.push(pairs);
    arr.splice(1, 0, arr.pop());                       // rotate all but first
  }
  return rounds;
}

// Build the flat poolMatches list for all pools.
function teBuildPoolMatches(pools){
  const matches = [];
  pools.forEach((pool, pi) => {
    teRoundRobin(pool).forEach((pairs, ri) => {
      pairs.forEach(([a,b]) => matches.push({ pool: pi, round: ri+1, t1: a, t2: b, games: [{s1:null,s2:null}] }));
    });
  });
  return matches;
}

// ── Standings ────────────────────────────────────────────────────────────
function teMatchResult(m){
  let w1 = 0, w2 = 0, pf1 = 0, pf2 = 0, played = false;
  for(const g of (m.games||[])){
    if(g == null || g.s1 == null || g.s2 == null) continue;
    played = true; pf1 += g.s1; pf2 += g.s2;
    if(g.s1 > g.s2) w1++; else if(g.s2 > g.s1) w2++;
  }
  if(!played) return { complete:false };
  return { complete:true, winner: w1 > w2 ? m.t1 : (w2 > w1 ? m.t2 : null), pf1, pf2, w1, w2 };
}

// Standings for one pool: matches won → point diff → points for → seed.
function tePoolStandings(poolIdx, pools, poolMatches, teams){
  const rows = {};
  pools[poolIdx].forEach(t => rows[t] = { team:t, played:0, won:0, lost:0, pf:0, pa:0, streak:[] });
  poolMatches.filter(m => m.pool === poolIdx).forEach(m => {
    const r = teMatchResult(m);
    if(!r.complete) return;
    rows[m.t1].played++; rows[m.t2].played++;
    rows[m.t1].pf += r.pf1; rows[m.t1].pa += r.pf2;
    rows[m.t2].pf += r.pf2; rows[m.t2].pa += r.pf1;
    if(r.winner === m.t1){ rows[m.t1].won++; rows[m.t2].lost++; rows[m.t1].streak.push('W'); rows[m.t2].streak.push('L'); }
    else if(r.winner === m.t2){ rows[m.t2].won++; rows[m.t1].lost++; rows[m.t2].streak.push('W'); rows[m.t1].streak.push('L'); }
  });
  return Object.values(rows).sort((a,b) =>
    b.won - a.won ||
    (b.pf - b.pa) - (a.pf - a.pa) ||
    b.pf - a.pf ||
    (teams[a.team].seed||99) - (teams[b.team].seed||99));
}

function tePoolsComplete(poolMatches){
  return poolMatches.length > 0 && poolMatches.every(m => teMatchResult(m).complete);
}

// ── Knockout ─────────────────────────────────────────────────────────────
// Qualifiers: top `advance` from each pool, ranked pool-finish first
// (all pool winners by record, then all runners-up, ...), so bracket seeding
// cross-pools naturally.
function teQualifiers(pools, poolMatches, teams, advance){
  const byFinish = [];
  for(let place = 0; place < advance; place++){
    const group = [];
    pools.forEach((_, pi) => {
      const st = tePoolStandings(pi, pools, poolMatches, teams);
      if(st[place]) group.push(st[place]);
    });
    group.sort((a,b) => b.won - a.won || (b.pf - b.pa) - (a.pf - a.pa) || b.pf - a.pf);
    byFinish.push(...group);
  }
  return byFinish.map(r => r.team);                    // ordered: KO seed 1 first
}

// Standard bracket slot order for a power-of-two size (1v(size), etc.).
function teBracketOrder(size){
  let order = [1, 2];
  while(order.length < size){
    const next = [];
    const m = order.length * 2 + 1;
    order.forEach(s => { next.push(s, m - s); });
    order = next;
  }
  return order;                                        // seed numbers, 1-based
}

// Build a single-elim bracket from ordered qualifier teamIdxs (KO seed order).
// Pads to the next power of two with byes (null); byes auto-advance.
function teBuildBracket(qualifiers){
  let size = 2;
  while(size < qualifiers.length) size *= 2;
  const slots = teBracketOrder(size).map(seed => qualifiers[seed-1] ?? null);
  const r1 = [];
  for(let i = 0; i < size; i += 2) r1.push({ t1: slots[i], t2: slots[i+1], s1: null, s2: null });
  const rounds = [r1];
  let n = size / 2;
  while(n > 1){ rounds.push(Array.from({length:n/2}, () => ({ t1:null, t2:null, s1:null, s2:null }))); n = n/2; }
  const br = { size, rounds };
  teAdvanceByes(br);
  return br;
}

function teBracketWinner(m){
  if(m.t1 !== null && m.t2 === null) return m.t1;      // bye
  if(m.t2 !== null && m.t1 === null) return m.t2;
  // Multi-game (best-of-N): winner needs the majority of the allotted games.
  if(Array.isArray(m.games) && m.games.length){
    const need = Math.floor(m.games.length/2) + 1;
    let w1 = 0, w2 = 0;
    for(const g of m.games){ if(g && g.s1!=null && g.s2!=null){ if(g.s1>g.s2) w1++; else if(g.s2>g.s1) w2++; } }
    if(w1 >= need) return m.t1;
    if(w2 >= need) return m.t2;
    return null;
  }
  // Single game (default): higher score wins.
  if(m.s1 == null || m.s2 == null) return null;
  return m.s1 > m.s2 ? m.t1 : (m.s2 > m.s1 ? m.t2 : null);
}

// Format for a division's bracket at a given round: per-round override, else the
// bracket default, else single-to-11. Returns a NAC_SCORE_FORMATS entry.
function teBracketFormat(division, roundIdx){
  const rf = division && division.roundFormats && division.roundFormats[roundIdx];
  const id = rf || (division && division.bracketFormat) || 'to11';
  return (typeof nacFormat === 'function') ? nacFormat(id)
    : ({to11:{games:1,target:11},to15:{games:1,target:15},bo3to11:{games:3,target:11}}[id] || {games:1,target:11});
}

// Push winners (incl. byes) forward into the next round's slots.
function teAdvanceByes(bracket){
  for(let r = 0; r < bracket.rounds.length - 1; r++){
    bracket.rounds[r].forEach((m, i) => {
      const w = teBracketWinner(m);
      if(w === null) return;
      const next = bracket.rounds[r+1][Math.floor(i/2)];
      if(i % 2 === 0) next.t1 = w; else next.t2 = w;
    });
  }
}

function teBracketComplete(bracket){
  const final = bracket.rounds[bracket.rounds.length - 1][0];
  return teBracketWinner(final) !== null;
}

function teRoundName(size, roundIdx, totalRounds){
  const remaining = totalRounds - roundIdx;
  if(remaining === 1) return 'Final';
  if(remaining === 2) return 'Semifinals';
  if(remaining === 3) return 'Quarterfinals';
  return 'Round of ' + Math.pow(2, remaining);
}

// ── Court management ──────────────────────────────────────────────────────
// Court state is stored per TOURNAMENT (shared across divisions) in pb_league
// under key `courts_<tid>`:
//   { count, courts: [ { id, matchRef|null } ], queuePinned: {matchRef:true} }
// A matchRef uniquely identifies a match across divisions:
//   `<divId>|pool|<poolIdx>|<matchIndex>`  or  `<divId>|bkt|<round>|<idx>`
// The engine here is pure: given the set of playable matches and current court
// state, it decides what to auto-assign. The admin page owns persistence.

function teMatchRefPool(divId, matchIndex){ return `${divId}|pool|${matchIndex}`; }
function teMatchRefBracket(divId, round, idx){ return `${divId}|bkt|${round}|${idx}`; }

// Is a pool match ready to play? (both teams known, not yet scored)
function tePoolMatchOpen(m){
  if(m.t1 === null || m.t2 === null) return false;
  return !teMatchResult(m).complete;
}
// Bracket match ready? both slots filled, not scored, not a bye
function teBracketMatchOpen(m){
  if(m.t1 === null || m.t2 === null) return false;
  return teBracketWinner(m) === null;
}

// Given a list of playable match refs (in priority order) and the current court
// array, fill empty courts with unassigned matches. Returns the mutated courts
// plus the list of refs that got assigned. Pure aside from building new objects.
function teAutoAssign(courts, playableRefs){
  const onCourt = new Set(courts.filter(c => c.matchRef).map(c => c.matchRef));
  const queue = playableRefs.filter(r => !onCourt.has(r));
  const assigned = [];
  for(const c of courts){
    if(c.matchRef) continue;
    const next = queue.shift();
    if(!next) break;
    c.matchRef = next;
    assigned.push(next);
  }
  return { courts, assigned };
}

// Free any court whose match is no longer playable (finished or changed), so the
// slot can take a new one. Returns refs that were cleared.
function teReleaseFinished(courts, stillPlayable){
  const ok = new Set(stillPlayable);
  const cleared = [];
  for(const c of courts){
    if(c.matchRef && !ok.has(c.matchRef)){ cleared.push(c.matchRef); c.matchRef = null; }
  }
  return cleared;
}
