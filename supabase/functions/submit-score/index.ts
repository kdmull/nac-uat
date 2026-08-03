// ============================================================
// Edge Function: submit-score
// Score entry for players, with the score password verified SERVER-SIDE
// (it is no longer shipped in client code). Scopes what a scorer can do:
//   • mode "match":   change ONLY the game scores of one existing scheduled
//                     match (loads the schedule server-side, applies games,
//                     saves, appends to pb_scores_log, fires the score email).
//   • mode "playoff": write ONLY bracket_*/playoff_* keys (playoff score pages).
//   • mode "verify":  check the password (gates the score-entry UI).
// Admin accounts (valid session token + profiles.is_admin) are accepted in
// place of the password.
//
// Secrets: NAC_SCORES_PW (defaults to 'NAC' in dev if unset).
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SCORES_PW    = Deno.env.get('NAC_SCORES_PW') || 'NAC'
const sb = createClient(SUPABASE_URL, SERVICE_ROLE)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey, x-user-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

async function isAdminToken(req: Request): Promise<boolean> {
  const token = (req.headers.get('x-user-token') || '').trim()
  if (!token) return false
  const { data: { user } } = await sb.auth.getUser(token)
  if (!user) return false
  const { data: prof } = await sb.from('profiles').select('is_admin').eq('id', user.id).maybeSingle()
  return !!(prof && prof.is_admin)
}

function validGames(games: any): boolean {
  if (!Array.isArray(games) || !games.length || games.length > 5) return false
  for (const g of games) {
    if (g == null || typeof g !== 'object') return false
    const ok = (v: any) => v === null || (Number.isInteger(v) && v >= 0 && v <= 99)
    if (!ok(g.s1) || !ok(g.s2)) return false
  }
  return true
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const body = await req.json().catch(() => ({}))
    const { mode, pw } = body || {}

    const authed = (typeof pw === 'string' && pw.length && pw === SCORES_PW) || await isAdminToken(req)
    if (!authed) return json({ success: false, error: 'Incorrect password' }, 401)

    if (mode === 'verify') return json({ success: true })

    if (mode === 'match') {
      const { leagueKey, seasonId, week, matchIdx, games, winner, team1, team2, leagueName } = body
      if (!leagueKey || !seasonId || !Number.isInteger(week) || !Number.isInteger(matchIdx))
        return json({ success: false, error: 'Missing leagueKey/seasonId/week/matchIdx' }, 400)
      if (!validGames(games)) return json({ success: false, error: 'Invalid game scores' }, 400)

      const key = `${leagueKey}_${seasonId}`
      const { data: row, error: readErr } = await sb.from('pb_league').select('value').eq('key', key).maybeSingle()
      if (readErr || !row || !row.value) return json({ success: false, error: 'Schedule not found for that league/season' }, 404)

      const val = row.value
      const wk = (val.schedule || []).find((w: any) => w.week === week)
      const m = wk && wk.matches && wk.matches[matchIdx]
      if (!m) return json({ success: false, error: 'That match does not exist in the schedule' }, 404)

      m.games = games   // the ONLY field a scorer can change
      val.updated = Date.now()

      const { error: writeErr } = await sb.from('pb_league').upsert(
        { key, value: val, updated_at: new Date().toISOString() }, { onConflict: 'key' })
      if (writeErr) { console.error('submit-score save error:', writeErr); return json({ success: false, error: writeErr.message }, 500) }

      // Append to the score log (best-effort).
      await sb.from('pb_scores_log').insert({
        league_key: key, league_name: leagueName || leagueKey,
        week, match_num: matchIdx + 1,
        team1: team1 ?? null, team2: team2 ?? null,
        games, winner: winner ?? null,
      }).then(({ error }) => { if (error) console.warn('score log insert failed:', error.message) })

      // Fire the admin score email (best-effort, never blocks).
      fetch(`${SUPABASE_URL}/functions/v1/notify-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_ROLE}`, 'apikey': SERVICE_ROLE },
        body: JSON.stringify({ type: 'score', data: { league: leagueName || leagueKey, week, match: matchIdx + 1, team1, team2, games, winner } }),
      }).catch(() => {})

      return json({ success: true })
    }

    if (mode === 'playoff') {
      const { key, value } = body
      if (!key || typeof key !== 'string' || value === undefined)
        return json({ success: false, error: 'Missing key/value' }, 400)
      if (!/^(bracket_|playoff_|tourney_)/.test(key))
        return json({ success: false, error: 'Scorers may only write bracket/playoff/tournament data' }, 403)
      const { error } = await sb.from('pb_league').upsert(
        { key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
      if (error) { console.error('submit-score playoff save error:', error); return json({ success: false, error: error.message }, 500) }
      return json({ success: true })
    }

    return json({ success: false, error: 'Unknown mode' }, 400)
  } catch (e) {
    console.error('submit-score error:', e)
    return json({ success: false, error: String((e as Error).message || e) }, 500)
  }
})