// ============================================================
// Edge Function: dupr-submit-match
// Creates a match in DUPR with:
//   • CLUB INTEGRATION — submitter must be a DIRECTOR/ORGANIZER of the club.
//   • USER GATING — every player must hold BASIC_L1.
//   • ID PERSISTENCE — DUPR's match id is stored so it can be updated/deleted.
//
// Input: { match:{teamA,teamB}, leagueKey, leagueName, week, matchNum, format,
//          seasonId?, submitterDuprId, identifier?, idSuffix?, bracketLabel?,
//          isTournament?, duprEnabled? }
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
// Match venue. Previously hardcoded to another city; now configurable and
// defaulting to the NAC venue.
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

const CREATE_URL = `${API_BASE}/api/match/v1/create`   // confirmed (DUPR PHP client)
const UPDATE_URL = `${API_BASE}/api/match/v1/update`

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

// Verify BASIC_L1 for every player (24h cache; refresh misses via the
// entitlements function). Returns DUPR IDs that are NOT eligible.
async function findIneligible(sb: any, secret: string, duprIds: string[]): Promise<string[]> {
  const bad: string[] = []
  for (const id of duprIds) {
    let basic = false
    const { data: cached } = await sb.from('dupr_entitlements').select('basic, checked_at').eq('dupr_id', id).maybeSingle()
    if (cached && (Date.now() - new Date(cached.checked_at).getTime() < 24 * 60 * 60 * 1000)) basic = !!cached.basic
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

// Submitter must be a DIRECTOR or ORGANIZER of the club we submit under.
// Partner-API call → uses the PARTNER token, not a user token.
async function verifyClubRole(submitterDuprId: string): Promise<{ ok: boolean; reason?: string; role?: string }> {
  const token = await partnerToken()
  if (!token) return { ok: false, reason: 'Could not authenticate with DUPR to verify club membership.' }
  const cid = clubId()
  const url = `${API_BASE}/api/user/v1/${submitterDuprId}/clubs`
  let res: Response
  try { res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }) }
  catch (e) { return { ok: false, reason: 'Network error reaching DUPR club membership: ' + String(e) } }
  const txt = await res.text()
  console.log('CLUBROLE', url, '->', res.status, txt.slice(0, 240))
  if (!res.ok) return { ok: false, reason: `Could not read club membership (${res.status}).` }
  let data: any = null
  try { data = JSON.parse(txt) } catch (_) { return { ok: false, reason: 'Club membership response was not JSON.' } }
  const listRaw = Array.isArray(data) ? data : (data.result || data.clubs || data.data || data.memberships || [])
  const arr = Array.isArray(listRaw) ? listRaw : (Array.isArray(listRaw.clubs) ? listRaw.clubs : [])
  for (const m of arr) {
    const id = String(m.clubId ?? m.id ?? m.club?.id ?? '')
    const role = String(m.role ?? m.membershipType ?? m.clubRole ?? m.type ?? '').toUpperCase()
    if (id === String(cid) && (role.includes('DIRECTOR') || role.includes('ORGANIZER'))) {
      console.log('CLUBROLE OK — role:', role)
      return { ok: true, role }
    }
  }
  return { ok: false, reason: `The submitting account is not a DIRECTOR or ORGANIZER of club ${cid}.` }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const secret = resolveSecretKey()
    const sb = createClient(SUPABASE_URL, secret, { auth: { persistSession: false } })

    const body = await req.json().catch(() => ({}))
    const { match, leagueKey, leagueName, week, matchNum, format, seasonId, submitterDuprId } = body || {}
    if (!match || !match.teamA || !match.teamB) return json({ success: false, error: 'Missing match/teamA/teamB' }, 400)

    // DUPR-off backstop: refuse competitions flagged as not counting for DUPR.
    if (body.duprEnabled === false)
      return json({ success: false, error: 'This league/division is set to not count for DUPR.' }, 403)

    // ── CLUB INTEGRATION ──
    const REQUIRE_CLUB = (Deno.env.get('DUPR_REQUIRE_CLUB_ROLE') || 'true') !== 'false'
    if (submitterDuprId) {
      const club = await verifyClubRole(submitterDuprId)
      if (club.ok) console.log('Club role verified:', club.role)
      else if (REQUIRE_CLUB) return json({ success: false, error: club.reason }, 403)
      else console.warn('CLUB ROLE NOT VERIFIED — allowed (DUPR_REQUIRE_CLUB_ROLE=false):', club.reason)
    } else if (REQUIRE_CLUB) {
      return json({ success: false, error: 'Only a club admin can submit matches (missing submitter identity). Connect your DUPR admin account.' }, 403)
    } else {
      console.warn('No submitterDuprId — allowed (DUPR_REQUIRE_CLUB_ROLE=false)')
    }

    const ids = [match.teamA.player1, match.teamA.player2, match.teamB.player1, match.teamB.player2].filter(Boolean)
    if (!ids.length) return json({ success: false, error: 'No player DUPR IDs in match' }, 400)

    // ── USER GATING ──
    const REQUIRE_ENT = (Deno.env.get('DUPR_REQUIRE_ENTITLEMENTS') || 'true') !== 'false'
    const ineligible = await findIneligible(sb, secret, ids)
    if (ineligible.length) {
      if (REQUIRE_ENT)
        return json({ success: false, error: 'One or more players are not eligible for rated play (missing BASIC_L1).', ineligible }, 403)
      console.warn('ENTITLEMENTS not verified — allowed (DUPR_REQUIRE_ENTITLEMENTS=false):', ineligible.join(','))
    }

    const token = await partnerToken()
    if (!token) return json({ success: false, error: 'Could not authenticate with DUPR' }, 502)

    const baseId = body.identifier || `${leagueKey || 'lg'}|${seasonId || 'nos'}|w${week}|m${matchNum}`
    const identifier = body.idSuffix ? `${baseId}-${body.idSuffix}` : baseId
    const payload = {
      location: MATCH_LOCATION,
      matchDate: new Date().toISOString().slice(0, 10),
      teamA: match.teamA,
      teamB: match.teamB,
      format: format || 'DOUBLES',
      event: leagueName || 'NAC Pickleball League',
      // Tournaments send a round label and are one day; leagues send "Week N".
      bracket: body.bracketLabel || (week != null ? `Week ${week}` : ''),
      matchType: 'SIDEOUT',
      identifier,
      clubId: Number(clubId()),
      matchSource: 'CLUB',
      matchCompletionType: 'COMPLETED',
      matchPlayType: body.isTournament ? 'TOURNAMENT' : 'LEAGUE',
    }

    const res = await fetch(CREATE_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload),
    })
    const text = await res.text()

    if (!res.ok) {
      // DUPR enforces unique identifiers — if it already exists, update instead.
      if (res.status === 400 && /already|identifier/i.test(text)) {
        const m = text.match(/Match ID:\s*(\d+)/i)
        const { data: existing } = await sb.from('dupr_matches').select('match_id, match_code').eq('identifier', identifier).maybeSingle()
        const mId = (m && m[1]) || existing?.match_id || existing?.match_code || null
        if (mId) {
          const upRes = await fetch(UPDATE_URL, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ ...payload, matchId: Number(mId) }),
          })
          const upText = await upRes.text()
          console.log('SUBMIT→UPDATE fallback, matchId', mId, '->', upRes.status, upText.slice(0, 200))
          if (upRes.ok) {
            await sb.from('dupr_matches').upsert({
              identifier, league_key: leagueKey, season_id: seasonId || null,
              week: week ?? null, match_num: matchNum ?? null, format: format || null,
              match_id: String(mId), match_code: String(mId),
              player_ids: ids, status: 'active', updated_at: new Date().toISOString(),
            })
            return json({ success: true, updated: true, matchId: mId, identifier })
          }
          return json({ success: false, error: 'This match is already in DUPR and the update failed.', details: upText.slice(0, 300), status: upRes.status }, 502)
        }
        return json({ success: false, error: 'This match is already in DUPR but no id was found to update it.', details: text.slice(0, 300) }, 409)
      }
      console.error('DUPR create failed', res.status, text.slice(0, 300))
      return json({ success: false, error: 'DUPR rejected the match', status: res.status, details: text.slice(0, 300) }, 502)
    }

    const data = (() => { try { return JSON.parse(text) } catch { return {} } })()
    const result = data?.result || data
    console.log('DUPR create result:', JSON.stringify(result).slice(0, 300))
    const rawMatchId = result?.matchId ?? result?.id ?? null
    const rawMatchCode = result?.matchCode ?? null
    const hashedCode = result?.hashedMatchCode ?? result?.hashedMatchId ?? null
    const matchId = rawMatchId ?? (rawMatchCode != null && /^\d+$/.test(String(rawMatchCode)) ? rawMatchCode : null)
    const matchCode = rawMatchCode ?? hashedCode ?? (matchId != null ? String(matchId) : null)

    await sb.from('dupr_matches').upsert({
      identifier, league_key: leagueKey, season_id: seasonId || null,
      week: week ?? null, match_num: matchNum ?? null, format: format || null,
      match_id: matchId != null ? String(matchId) : null,
      match_code: matchCode ? String(matchCode) : null,
      hashed_code: hashedCode ? String(hashedCode) : null,
      player_ids: ids, status: 'active', submitted_at: new Date().toISOString(),
    })

    console.log('DUPR match created:', identifier, 'matchId:', matchId)
    return json({ success: true, matchId, matchCode, identifier })
  } catch (e) {
    console.error('dupr-submit-match error:', e)
    return json({ success: false, error: String((e as Error).message || e) }, 500)
  }
})