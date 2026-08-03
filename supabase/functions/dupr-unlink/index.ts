// ============================================================
// Edge Function: dupr-unlink
// Lets a signed-in user unlink THEIR OWN DUPR account. Identity comes from the
// caller's JWT, never the request body, so it can only ever affect that user.
//
// ⚠️ FIXED: the dupr_players cleanup previously built the player name as
// "First L.". After the full-name migration those rows are stored as
// "First Last", so unlink silently deleted nothing. It now tries BOTH forms.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!

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
function resolvePublishableKey(): string {
  const legacy = Deno.env.get('SUPABASE_ANON_KEY')
  if (legacy && legacy.trim()) return legacy.trim()
  const raw = Deno.env.get('SUPABASE_PUBLISHABLE_KEYS')
  if (raw && raw.trim()) {
    try {
      const o = JSON.parse(raw)
      if (typeof o === 'string') return o
      if (o.default) return o.default
      const f = Object.values(o).find(v => typeof v === 'string' && v)
      if (f) return f as string
    } catch (_e) { return raw.trim() }
  }
  throw new Error('No publishable/anon key in env')
}

Deno.serve(async (req) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type, authorization, apikey',
    'Content-Type': 'application/json',
  }
  if (req.method === 'OPTIONS') return new Response('ok', { headers })

  try {
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
    if (!token) return new Response(JSON.stringify({ error: 'Missing auth token' }), { status: 401, headers })

    // Resolve the caller with the PUBLISHABLE key — the auth endpoint rejects a
    // secret key as an apikey, which surfaces confusingly as "invalid session".
    const authClient = createClient(SUPABASE_URL, resolvePublishableKey(), {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    })
    const { data: caller, error: callerErr } = await authClient.auth.getUser(token)
    if (callerErr || !caller?.user)
      return new Response(JSON.stringify({ error: 'Invalid session', detail: callerErr?.message }), { status: 401, headers })
    const userId = caller.user.id

    // Writes use the secret key so RLS doesn't block the cleanup.
    const admin = createClient(SUPABASE_URL, resolveSecretKey(), { auth: { persistSession: false } })

    const { data: prof } = await admin.from('profiles').select('first_name,last_name').eq('id', userId).single()

    const { error: upErr } = await admin.from('profiles').update({ dupr_id: null }).eq('id', userId)
    if (upErr) throw upErr

    let removed = 0
    if (prof) {
      const first = (prof.first_name || '').trim()
      const last = (prof.last_name || '').trim()
      // Try every stored name form: full name (current) and "First L." (legacy).
      const names = [...new Set([`${first} ${last}`.trim(), `${first} ${last[0] || ''}.`.trim()])].filter(Boolean)

      const { data: mems } = await admin.from('league_members').select('league_id').eq('user_id', userId)
      const leagueIds = [...new Set((mems || []).map((m: any) => m.league_id).filter(Boolean))]

      for (const lid of leagueIds) {
        for (const nm of names) {
          const { data: del, error: delErr } = await admin.from('dupr_players').delete()
            .eq('league_key', lid).eq('player_name', nm).select('player_name')
          if (!delErr && del) removed += del.length
        }
      }
    }

    return new Response(JSON.stringify({ success: true, removed }), { status: 200, headers })
  } catch (e) {
    console.error('dupr-unlink error:', e)
    return new Response(JSON.stringify({ error: String((e as Error).message || e) }), { status: 500, headers })
  }
})