// ============================================================
// Edge Function: admin-save-data
// The ONLY write path for pb_league admin data (schedules, seasons, league
// catalog, playoff/bracket seeds) once RLS locks anon to read-only.
//
// Input (POST JSON): { key, value }
// Output: { success } | { success:false, error, detail? }
//
// TWO CLIENTS, ON PURPOSE:
//   • authClient  — built with the PUBLISHABLE/ANON key. Used only to resolve
//     the caller's identity from their session JWT. The auth endpoint expects a
//     publishable-style apikey; passing a secret key here can be rejected and
//     shows up (confusingly) as "invalid session".
//   • adminClient — built with the SECRET/service-role key. Used only for the
//     database write, because it bypasses RLS.
//
// Both key names are read across the OLD and NEW Supabase key schemes, so this
// works before and after the legacy vars are removed.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!

// Pull a key out of either a legacy plain-string var or a new JSON-dictionary var.
function readKey(legacyVar: string, dictVar: string, extraVars: string[] = []): string {
  const legacy = Deno.env.get(legacyVar)
  if (legacy && legacy.trim()) return legacy.trim()

  const raw = Deno.env.get(dictVar)
  if (raw && raw.trim()) {
    try {
      const obj = JSON.parse(raw)
      if (typeof obj === 'string') return obj
      if (obj.default) return obj.default
      const first = Object.values(obj).find((v) => typeof v === 'string' && v)
      if (first) return first as string
    } catch (_e) {
      return raw.trim()
    }
  }
  for (const v of extraVars) {
    const x = Deno.env.get(v)
    if (x && x.trim()) return x.trim()
  }
  throw new Error(`No key found (checked ${legacyVar}, ${dictVar}${extraVars.length ? ', ' + extraVars.join(', ') : ''})`)
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey, x-user-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const token = (req.headers.get('x-user-token') || '').trim()
      || (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim()
    if (!token) return json({ success: false, error: 'Not signed in' }, 403)

    // ---- 1. Resolve the caller using the PUBLISHABLE/ANON key ---------------
    let publishable: string
    try {
      publishable = readKey('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEYS')
    } catch (e) {
      return json({ success: false, error: 'Server publishable key not configured', detail: String((e as Error).message || e) }, 500)
    }
    const authClient = createClient(SUPABASE_URL, publishable, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    })
    const { data: userData, error: userErr } = await authClient.auth.getUser(token)
    const user = userData?.user
    if (userErr || !user) {
      // Surface the real reason instead of a generic message.
      return json({
        success: false,
        error: 'Invalid or expired session — sign in again',
        detail: userErr ? (userErr.message || String(userErr)) : 'no user returned',
      }, 403)
    }

    // ---- 2. Check admin + write using the SECRET/service-role key -----------
    let secret: string
    try {
      secret = readKey('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEYS', ['SERVICE_SECRET', 'SB_SECRET_KEY'])
    } catch (e) {
      return json({ success: false, error: 'Server secret key not configured', detail: String((e as Error).message || e) }, 500)
    }
    const admin = createClient(SUPABASE_URL, secret, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const { data: prof, error: profErr } = await admin
      .from('profiles').select('is_admin').eq('id', user.id).maybeSingle()
    if (profErr) return json({ success: false, error: 'Could not verify admin', detail: profErr.message }, 500)
    if (!prof || !prof.is_admin) return json({ success: false, error: 'Your account does not have admin access' }, 403)

    const { key, value } = await req.json().catch(() => ({}))
    if (!key || typeof key !== 'string' || value === undefined)
      return json({ success: false, error: 'Missing key/value' }, 400)

    const { error: upErr } = await admin.from('pb_league').upsert(
      { key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
    if (upErr) {
      console.error('admin-save-data upsert error:', upErr)
      return json({ success: false, error: upErr.message }, 500)
    }
    return json({ success: true })
  } catch (e) {
    console.error('admin-save-data error:', e)
    return json({ success: false, error: String((e as Error).message || e) }, 500)
  }
})