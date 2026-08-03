// ============================================================
// Edge Function: dupr-get-entitlements
// User Gating per DUPR RaaS "User Gating" requirement.
//
// Fetches a connected user's entitlements (BASIC_L1 / PREMIUM_L1 /
// VERIFIED_L1) using the USER ACCESS TOKEN captured at SSO, caches the
// result for 24h, and returns an eligibility decision.
//
// Input (POST JSON), identify the user by EITHER:
//   { "duprId": "1A1A1A" }
//   { "leagueKey": "beginner", "playerName": "Jane Doe" }
// Optional:
//   { "premiumRequired": true }   // gate for a DUPR+ premium league/event
//   { "force": true }             // bypass the 24h cache
//
// Output:
//   { duprId, basic, premium, verified, eligible, cached, source }
//   eligible = basic && (!premiumRequired || premium)
//
// ── CONFIG (set these as Edge Function secrets) ──────────────────────────
//   DUPR_ENT_BASE   base for the entitlements/refresh API
//                   production: https://api.dupr.gg
//                   UAT:        https://api.uat.dupr.gg
// Nothing is hardcoded to UAT any more: switching environments is a secret
// change, not a code edit. If DUPR_ENT_BASE is unset the function FAILS
// LOUDLY rather than silently falling back to UAT.
//
// ── KEY SCHEME ──────────────────────────────────────────────────────────
// Supabase is retiring SUPABASE_SERVICE_ROLE_KEY in favour of
// SUPABASE_SECRET_KEYS (a JSON dictionary). This function reads either, and
// builds its client INSIDE the handler so a key problem returns a readable
// JSON error instead of crashing on startup (which surfaces to the browser
// as "network connection lost").
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!

function resolveSecretKey(): string {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (legacy && legacy.trim()) return legacy.trim()
  const raw = Deno.env.get('SUPABASE_SECRET_KEYS')
  if (raw && raw.trim()) {
    try {
      const obj = JSON.parse(raw)
      if (typeof obj === 'string') return obj
      if (obj.default) return obj.default
      const first = Object.values(obj).find((v) => typeof v === 'string' && v)
      if (first) return first as string
    } catch (_e) { return raw.trim() }
  }
  const manual = Deno.env.get('SERVICE_SECRET') || Deno.env.get('SB_SECRET_KEY')
  if (manual && manual.trim()) return manual.trim()
  throw new Error('No service/secret key in env (checked SUPABASE_SERVICE_ROLE_KEY, SUPABASE_SECRET_KEYS, SERVICE_SECRET)')
}

// Entitlements API base — required, no UAT fallback.
function entBase(): string {
  const b = (Deno.env.get('DUPR_ENT_BASE') || '').trim().replace(/\/+$/, '')
  if (!b) throw new Error('DUPR_ENT_BASE is not set (e.g. https://api.dupr.gg for production)')
  return b
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

const CACHE_TTL_MS = 24 * 60 * 60 * 1000  // 24h, per DUPR caching allowance

// Candidate paths, resolved against DUPR_ENT_BASE. The first that returns a
// usable 200 is logged ("ENTITLEMENTS endpoint OK:") so it can be locked in.
const ENT_PATHS     = ['/user/v1.0/subscriptions', '/v1.0/subscriptions']
const REFRESH_PATHS = ['/auth/v1.0/refresh', '/api/auth/v1.0/refresh']

async function getStoredTokens(sb: any, body: any) {
  let duprId = body.duprId
  if (!duprId && body.leagueKey && body.playerName) {
    const { data } = await sb.from('dupr_players').select('dupr_id')
      .eq('league_key', body.leagueKey).eq('player_name', body.playerName).limit(1)
    if (data && data.length) duprId = data[0].dupr_id
  }
  if (!duprId) return null
  // 1) profiles — account-mode connect (current flow) has the freshest token.
  const { data: prof } = await sb.from('profiles')
    .select('dupr_access_token, dupr_refresh_token')
    .eq('dupr_id', duprId).not('dupr_access_token', 'is', null).limit(1)
  if (prof && prof.length) return { dupr_id: duprId, access_token: prof[0].dupr_access_token, refresh_token: prof[0].dupr_refresh_token, source: 'profiles' }
  // 2) dupr_players — legacy league-mode connect stored tokens here.
  const { data: tok } = await sb.from('dupr_players')
    .select('dupr_id, access_token, refresh_token')
    .eq('dupr_id', duprId).not('access_token', 'is', null).limit(1)
  if (tok && tok.length) return { ...tok[0], source: 'dupr_players' }
  return { dupr_id: duprId, access_token: null, refresh_token: null, source: null }
}

async function callEntitlements(accessToken: string) {
  const base = entBase()
  const attempts: any[] = []
  let sawAuthError = false
  for (const path of ENT_PATHS) {
    const url = base + path
    let res: Response
    try {
      res = await fetch(url, { headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' } })
    } catch (e) { attempts.push({ url, error: String(e) }); continue }
    const txt = await res.text()
    attempts.push({ url, status: res.status, body: txt.slice(0, 200) })
    console.log('ENTITLEMENTS try', url, '->', res.status, txt.slice(0, 200))
    if (res.status === 401 || res.status === 403) { sawAuthError = true; continue }
    if (!res.ok) continue
    let data: any = null
    try { data = JSON.parse(txt) } catch (_) { /* not json */ }
    const ent = data && (data.entitlements || data.result?.entitlements)
    if (ent) { console.log('ENTITLEMENTS endpoint OK:', url); return { data, attempts } }
  }
  return sawAuthError ? { unauthorized: true, attempts } : { notFound: true, attempts }
}

async function refreshTokens(refreshToken: string) {
  const base = entBase()
  for (const path of REFRESH_PATHS) {
    const url = base + path
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      })
    } catch (e) { console.log('REFRESH try', url, '-> network error', String(e)); continue }
    const txt = await res.text()
    console.log('REFRESH try', url, '->', res.status, txt.slice(0, 160))
    if (!res.ok) continue
    let data: any = null
    try { data = JSON.parse(txt) } catch (_) { /* not json */ }
    const result = data?.result || data
    const newAccess = result?.accessToken || result?.access_token || result?.token
    const newRefresh = result?.refreshToken || result?.refresh_token || refreshToken
    if (newAccess) { console.log('REFRESH endpoint OK:', url); return { accessToken: newAccess, refreshToken: newRefresh } }
  }
  return null
}

function parseEntitlements(payload: any) {
  const ent = payload?.entitlements || payload?.result?.entitlements || {}
  const list: string[] = ent?.tournaments || []
  return {
    basic: list.includes('BASIC_L1'),
    premium: list.includes('PREMIUM_L1'),
    verified: list.includes('VERIFIED_L1'),
    raw: ent ?? null,
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    // Build the client here (not at module load) so key/config problems come
    // back as readable JSON instead of a startup crash.
    let sb: any
    try {
      sb = createClient(SUPABASE_URL, resolveSecretKey(), {
        auth: { autoRefreshToken: false, persistSession: false },
      })
    } catch (e) {
      console.error('dupr-get-entitlements key error:', e)
      return json({ error: 'Server key not configured', detail: String((e as Error).message || e) }, 500)
    }
    try { entBase() } catch (e) {
      return json({ error: 'DUPR environment not configured', detail: String((e as Error).message || e) }, 500)
    }

    const body = await req.json().catch(() => ({}))
    const premiumRequired = !!body.premiumRequired

    const row = await getStoredTokens(sb, body)
    if (!row) return json({ error: 'No connected DUPR user found for that identity' }, 404)
    const duprId = row.dupr_id

    // 1) Serve from cache if fresh and not forced
    if (!body.force) {
      const { data: cached } = await sb.from('dupr_entitlements').select('*').eq('dupr_id', duprId).maybeSingle()
      if (cached && (Date.now() - new Date(cached.checked_at).getTime() < CACHE_TTL_MS)) {
        return json({
          duprId, basic: cached.basic, premium: cached.premium, verified: cached.verified,
          eligible: cached.basic && (!premiumRequired || cached.premium),
          cached: true, source: 'cache',
        })
      }
    }

    // 2) Live fetch (refresh the access token once if expired)
    let accessToken = row.access_token
    if (!accessToken) return json({ error: 'User has no stored access token; re-connect via SSO' }, 409)

    let call: any = await callEntitlements(accessToken)
    if (call.unauthorized && row.refresh_token) {
      const refreshed = await refreshTokens(row.refresh_token)
      if (refreshed) {
        accessToken = refreshed.accessToken
        if (row.source === 'profiles') {
          await sb.from('profiles')
            .update({ dupr_access_token: refreshed.accessToken, dupr_refresh_token: refreshed.refreshToken })
            .eq('dupr_id', duprId)
        } else {
          await sb.from('dupr_players')
            .update({ access_token: refreshed.accessToken, refresh_token: refreshed.refreshToken })
            .eq('dupr_id', duprId)
        }
        call = await callEntitlements(accessToken)
      }
    }

    if (call.unauthorized)
      return json({ error: 'DUPR access token expired and refresh failed; user must re-connect via SSO', duprId, attempts: call.attempts }, 401)
    if (call.notFound)
      return json({ error: 'Could not reach a working getSubscriptions endpoint; see attempts', duprId, attempts: call.attempts }, 502)

    const ent = parseEntitlements(call.data)

    // 3) Cache it
    await sb.from('dupr_entitlements').upsert({
      dupr_id: duprId, basic: ent.basic, premium: ent.premium, verified: ent.verified,
      raw: ent.raw, checked_at: new Date().toISOString(),
    })

    return json({
      duprId, basic: ent.basic, premium: ent.premium, verified: ent.verified,
      eligible: ent.basic && (!premiumRequired || ent.premium),
      cached: false, source: 'live',
    })
  } catch (e) {
    console.error('dupr-get-entitlements error:', e)
    return json({ error: String((e as Error).message || e) }, 500)
  }
})