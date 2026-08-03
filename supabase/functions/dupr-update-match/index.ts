// ============================================================
// Edge Function: dupr-update-match
// Updates the scores of a previously-submitted DUPR match.
// Input: { identifier, match: { teamA, teamB }, format, leagueName?, week?, bracketLabel?, isTournament? }
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
// Where matches are played. Was hardcoded to another city — now configurable
// and defaulting to the NAC venue.
const MATCH_LOCATION = (Deno.env.get('DUPR_LOCATION') || 'Nitro, WV').trim()

// ── Supabase key (handles the new API-key scheme) ────────────────────────
function resolveSecretKey(): string {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (legacy && legacy.trim()) return legacy.trim()
  const raw = Deno.env.get('SUPABASE_SECRET_KEYS')
  if (raw && raw.trim()) {
    try {
      const o = JSON.parse(raw)
      if (typeof o === 'string') return o
      if (o.default) return o.default
      const f = Object.values(o).find(v => typeof v === 'string' && v)
      if (f) return f as string
    } catch (_e) { return raw.trim() }
  }
  const m = Deno.env.get('SERVICE_SECRET') || Deno.env.get('SB_SECRET_KEY')
  if (m && m.trim()) return m.trim()
  throw new Error('No service/secret key in env')
}

// ── DUPR hosts: production by default, overridable per environment ───────
const API_BASE = (Deno.env.get('DUPR_API_BASE') || 'https://api.mydupr.com').trim().replace(/\/+$/, '')
const AUTH_URL = `${API_BASE}/api/auth/v1.0/token`

// Credentials: NO UAT fallbacks. A missing secret fails loudly rather than
// silently submitting to the test environment.
function creds(): { key: string; secret: string } {
  const key = (Deno.env.get('DUPR_CLIENT_KEY') || '').trim()
  const secret = (Deno.env.get('DUPR_CLIENT_SECRET') || '').trim()
  if (!key || !secret) throw new Error('DUPR_CLIENT_KEY / DUPR_CLIENT_SECRET are not set')
  return { key, secret }
}
function clubId(): string {
  const c = (Deno.env.get('DUPR_CLUB_ID') || '').trim()
  if (!c) throw new Error('DUPR_CLUB_ID is not set')
  return c
}
async function partnerToken(): Promise<string | null> {
  const { key, secret } = creds()
  console.log('DUPR base in use:', API_BASE)
  const r = await fetch(AUTH_URL, { method: 'POST', headers: { 'x-authorization': btoa(`${key}:${secret}`), 'Accept': 'application/json' } })
  if (!r.ok) { console.error('DUPR auth failed', r.status, (await r.text()).slice(0, 200)); return null }
  const d = await r.json().catch(() => null)
  return d?.result?.token || d?.token || null
}

const UPDATE_URL = `${API_BASE}/api/match/v1/update`   // confirmed (DUPR PHP client)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

// Verify BASIC_L1 for every player (24h cache, refresh misses via the
// entitlements function). Returns the DUPR IDs that are NOT eligible.
async function findIneligible(sb: any, secret: string, duprIds: string[]): Promise<string[]> {
  const bad: string[] = []
  for (const id of duprIds) {
    let basic = false
    const { data: c } = await sb.from('dupr_entitlements').select('basic, checked_at').eq('dupr_id', id).maybeSingle()
    if (c && (Date.now() - new Date(c.checked_at).getTime() < 24 * 60 * 60 * 1000)) basic = !!c.basic
    else {
      try {
        const r = await fetch(`${SUPABASE_URL}/functions/v1/dupr-get-entitlements`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${secret}`, 'apikey': secret },
          body: JSON.stringify({ duprId: id }),
        })
        basic = !!(await r.json().catch(() => ({}))).basic
      } catch (_) { basic = false }
    }
    if (!basic) bad.push(id)
  }
  return bad
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const secret = resolveSecretKey()
    const sb = createClient(SUPABASE_URL, secret, { auth: { persistSession: false } })

    const body = await req.json().catch(() => ({}))
    const { identifier, match, format, leagueName, week } = body
    if (!identifier || !match || !match.teamA || !match.teamB)
      return json({ success: false, error: 'Missing identifier/match' }, 400)

    const { data: row } = await sb.from('dupr_matches').select('*').eq('identifier', identifier).maybeSingle()
    if (!row || (!row.match_id && !row.match_code))
      return json({ success: false, error: 'No stored DUPR match id for that identifier' }, 404)

    const ids = [match.teamA.player1, match.teamA.player2, match.teamB.player1, match.teamB.player2].filter(Boolean)
    const REQUIRE_ENT = (Deno.env.get('DUPR_REQUIRE_ENTITLEMENTS') || 'true') !== 'false'
    const ineligible = await findIneligible(sb, secret, ids)
    if (ineligible.length && REQUIRE_ENT)
      return json({ success: false, error: 'One or more players are not eligible (missing BASIC_L1).', ineligible }, 403)
    if (ineligible.length) console.warn('ENTITLEMENTS not verified — allowed (DUPR_REQUIRE_ENTITLEMENTS=false):', ineligible.join(','))

    const token = await partnerToken()
    if (!token) return json({ success: false, error: 'Could not authenticate with DUPR' }, 502)

    const payload = JSON.stringify({
      matchId: Number(row.match_id ?? row.match_code),
      location: MATCH_LOCATION,
      matchDate: new Date().toISOString().slice(0, 10),
      teamA: match.teamA, teamB: match.teamB,
      format: format || row.format || 'DOUBLES',
      event: leagueName || 'NAC Pickleball League',
      // Tournaments send a round label; leagues fall back to "Week N".
      bracket: body.bracketLabel || (week != null ? `Week ${week}` : (row.week != null ? `Week ${row.week}` : '')),
      matchType: 'SIDEOUT',
      identifier,
      clubId: Number(clubId()),
      matchSource: 'CLUB',
      matchCompletionType: 'COMPLETED',
      matchPlayType: body.isTournament ? 'TOURNAMENT' : 'LEAGUE',
    })

    let res: Response
    try {
      res = await fetch(UPDATE_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: payload,
      })
    } catch (e) { return json({ success: false, error: 'Network error reaching DUPR: ' + String(e) }, 502) }
    const t = await res.text()
    console.log('UPDATE', UPDATE_URL, '->', res.status, t.slice(0, 200))
    if (res.ok) {
      await sb.from('dupr_matches').update({ player_ids: ids, updated_at: new Date().toISOString() }).eq('identifier', identifier)
      return json({ success: true })
    }
    return json({ success: false, error: `DUPR update failed (${res.status}): ${t.slice(0, 200)}` }, 502)
  } catch (e) {
    console.error('dupr-update-match error:', e)
    return json({ success: false, error: String((e as Error).message || e) }, 500)
  }
})