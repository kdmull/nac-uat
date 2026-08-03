// ============================================================
// Edge Function: dupr-get-ratings
// Fetches current DUPR ratings for a list of DUPR IDs (batch endpoint).
//
// ⚠️ FIXED: this function previously had UAT credentials and UAT URLs
// HARDCODED with no environment override, so it would have kept calling the
// test environment forever after go-live. Everything is now env-driven.
// ============================================================

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

const BATCH_URL = `${API_BASE}/api/user/v1.0/batch`

let cachedToken: string | null = null
let tokenExpiry = 0
async function cachedPartnerToken(): Promise<string | null> {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken
  const t = await partnerToken()
  if (t) { cachedToken = t; tokenExpiry = Date.now() + 55 * 60 * 1000 }
  return t
}

Deno.serve(async (req) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type, authorization, apikey, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  }
  if (req.method === 'OPTIONS') return new Response('ok', { headers })

  try {
    const { duprIds } = await req.json().catch(() => ({}))
    if (!duprIds || !Array.isArray(duprIds) || !duprIds.length)
      return new Response(JSON.stringify({ ratings: {} }), { headers })

    const token = await cachedPartnerToken()
    if (!token) return new Response(JSON.stringify({ error: 'DUPR auth failed' }), { status: 502, headers })

    const r = await fetch(BATCH_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ duprIds }),
    })
    const data = await r.json().catch(() => ({}))
    console.log('Batch response:', JSON.stringify(data).slice(0, 400))
    if (!r.ok || data.status === 'FAILURE')
      return new Response(JSON.stringify({ error: 'Batch fetch failed', details: data }), { status: 400, headers })

    let users: any[] = []
    if (Array.isArray(data.result)) users = data.result
    else if (Array.isArray(data.result?.hits)) users = data.result.hits
    else if (Array.isArray(data.result?.users)) users = data.result.users
    else if (Array.isArray(data.result?.found)) users = data.result.found
    else if (Array.isArray(data.results)) users = data.results

    const ratings: Record<string, any> = {}
    for (const u of users) {
      const id = u.id || u.duprId
      const rt = u.ratings || {}
      const s = (rt.singles !== null && rt.singles !== undefined && rt.singles !== 'NR') ? parseFloat(rt.singles) : null
      const d = (rt.doubles !== null && rt.doubles !== undefined && rt.doubles !== 'NR') ? parseFloat(rt.doubles) : null
      ratings[id] = { singles: (s === null || isNaN(s)) ? null : s, doubles: (d === null || isNaN(d)) ? null : d }
    }
    return new Response(JSON.stringify({ ratings }), { headers })
  } catch (e) {
    console.error('dupr-get-ratings error:', e)
    return new Response(JSON.stringify({ error: String((e as Error).message || e) }), { status: 500, headers })
  }
})