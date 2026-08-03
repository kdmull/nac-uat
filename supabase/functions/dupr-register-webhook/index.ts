// ============================================================
// Edge Function: dupr-register-webhook   (admin, one-time per environment)
// Registers our public dupr-webhook URL with DUPR for the RATING topic.
// RE-RUN THIS AFTER SWITCHING TO PRODUCTION — UAT registrations don't carry over.
// Input (POST JSON): {} or { webhookUrl }
// ============================================================

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

const CLIENT_ID = (Deno.env.get('DUPR_CLIENT_ID') || '').trim()
const REGISTER_URL = `${API_BASE}/api/v1/webhook`   // confirmed (DUPR PHP client)

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
    if (!CLIENT_ID) return json({ success: false, error: 'DUPR_CLIENT_ID is not set' }, 500)
    const body = await req.json().catch(() => ({}))
    const webhookUrl = body.webhookUrl || `${SUPABASE_URL}/functions/v1/dupr-webhook`

    const token = await partnerToken()
    if (!token) return json({ success: false, error: 'Could not authenticate with DUPR' }, 502)

    const res = await fetch(REGISTER_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ clientId: CLIENT_ID, webhookUrl, topics: ['RATING'] }),
    })
    const t = await res.text()
    console.log('REGISTER', REGISTER_URL, '->', res.status, t.slice(0, 200))
    if (res.ok) return json({ success: true, webhookUrl, endpoint: REGISTER_URL })
    return json({ success: false, error: `DUPR register failed (${res.status}): ${t.slice(0, 200)}`, webhookUrl }, 502)
  } catch (e) {
    console.error('dupr-register-webhook error:', e)
    return json({ success: false, error: String((e as Error).message || e) }, 500)
  }
})