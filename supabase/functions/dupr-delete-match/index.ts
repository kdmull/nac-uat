// ============================================================
// Edge Function: dupr-delete-match
// Deletes a previously-submitted DUPR match by stored matchCode.
// Input: { identifier }
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

const DELETE_URL = `${API_BASE}/api/match/v1/delete`   // confirmed (DUPR PHP client)

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
    const { identifier } = await req.json().catch(() => ({}))
    if (!identifier) return json({ success: false, error: 'Missing identifier' }, 400)

    const { data: row } = await sb.from('dupr_matches').select('*').eq('identifier', identifier).maybeSingle()
    if (!row || !row.match_code) return json({ success: false, error: 'No stored DUPR match code for that identifier' }, 404)

    const token = await partnerToken()
    if (!token) return json({ success: false, error: 'Could not authenticate with DUPR' }, 502)

    let res: Response
    try {
      res = await fetch(DELETE_URL, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchCode: row.match_code, identifier }),
      })
    } catch (e) { return json({ success: false, error: 'Network error reaching DUPR: ' + String(e) }, 502) }
    const t = await res.text()
    console.log('DELETE', DELETE_URL, '->', res.status, t.slice(0, 200))
    if (res.ok) {
      await sb.from('dupr_matches').update({ status: 'deleted', updated_at: new Date().toISOString() }).eq('identifier', identifier)
      return json({ success: true })
    }
    return json({ success: false, error: `DUPR delete failed (${res.status}): ${t.slice(0, 200)}` }, 502)
  } catch (e) {
    console.error('dupr-delete-match error:', e)
    return json({ success: false, error: String((e as Error).message || e) }, 500)
  }
})