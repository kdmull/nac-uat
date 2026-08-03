// ============================================================
// Edge Function: dupr-subscribe-user
// Subscribes DUPR IDs to the RATING topic. Each subscribe makes DUPR POST a
// RATING_SEED to our webhook with the player's current rating.
// RE-RUN AFTER SWITCHING TO PRODUCTION so live ratings start flowing.
//
// Input: { duprId } | { duprIds: [...] } | {} (all ids in dupr_players)
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!

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

const SUBSCRIBE_URL = `${API_BASE}/api/user/v1/subscribe/webhook-event`  // confirmed (DUPR PHP client)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const sb = createClient(SUPABASE_URL, resolveSecretKey(), { auth: { persistSession: false } })
    const body = await req.json().catch(() => ({}))
    let ids: string[] = []
    if (body.duprId) ids = [body.duprId]
    else if (Array.isArray(body.duprIds)) ids = body.duprIds.filter(Boolean)
    else {
      // Gather from BOTH sources. profiles.dupr_id is what SSO writes, so it's
      // the authoritative list of connected players; dupr_players only fills in
      // when someone registers for a league. Using just the latter meant
      // connected players were never subscribed and so never received a rating.
      const [{ data: profs }, { data: legacy }] = await Promise.all([
        sb.from('profiles').select('dupr_id').not('dupr_id', 'is', null),
        sb.from('dupr_players').select('dupr_id').not('dupr_id', 'is', null),
      ])
      const merged = [...(profs || []), ...(legacy || [])]
        .map((r: any) => String(r.dupr_id || '').trim())
        .filter(Boolean)
      ids = [...new Set(merged)] as string[]
    }
    if (!ids.length) return json({ success: false, error: 'No DUPR IDs to subscribe' }, 400)

    const token = await partnerToken()
    if (!token) return json({ success: false, error: 'Could not authenticate with DUPR' }, 502)

    const res = await fetch(SUBSCRIBE_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ duprIds: ids, topic: 'RATING' }),
    })
    const t = await res.text()
    console.log('SUBSCRIBE', SUBSCRIBE_URL, '->', res.status, t.slice(0, 200))
    if (res.ok) {
      const now = new Date().toISOString()
      await sb.from('dupr_subscriptions').upsert(ids.map(id => ({ dupr_id: id, subscribed: true, subscribed_at: now })))
      return json({ success: true, subscribed: ids, endpoint: SUBSCRIBE_URL })
    }
    return json({ success: false, error: `DUPR subscribe failed (${res.status}): ${t.slice(0, 200)}` }, 502)
  } catch (e) {
    console.error('dupr-subscribe-user error:', e)
    return json({ success: false, error: String((e as Error).message || e) }, 500)
  }
})