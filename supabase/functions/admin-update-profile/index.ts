// Supabase Edge Function: admin-update-profile
// Deploy to: Supabase -> Edge Functions -> New Function -> name: admin-update-profile
//
// Updates another user's profile (name, email, phone, admin flag) regardless of
// row-level security. Only callable by a signed-in admin account. When the email
// changes, the Auth LOGIN email is updated too (marked confirmed, no verification
// email sent), so the player signs in with the new address immediately.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type, authorization, apikey',
    'Content-Type': 'application/json'
  }
  if (req.method === 'OPTIONS') return new Response('ok', { headers })

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
    const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return new Response(JSON.stringify({ error: 'Server not configured' }), { status: 500, headers })
    }

    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
    if (!token) return new Response(JSON.stringify({ error: 'Missing auth token' }), { status: 401, headers })

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } })

    const { data: caller, error: callerErr } = await admin.auth.getUser(token)
    if (callerErr || !caller || !caller.user) {
      return new Response(JSON.stringify({ error: 'Invalid session' }), { status: 401, headers })
    }
    const { data: prof } = await admin.from('profiles').select('is_admin').eq('id', caller.user.id).single()
    if (!prof || !prof.is_admin) {
      return new Response(JSON.stringify({ error: 'Not authorized' }), { status: 403, headers })
    }

    const body = await req.json().catch(() => ({}))
    const userId = body && body.userId
    const patch = (body && body.patch) || {}
    if (!userId) return new Response(JSON.stringify({ error: 'Missing userId' }), { status: 400, headers })

    // Only allow a known set of editable fields.
    const allowed = ['first_name', 'last_name', 'email', 'phone', 'is_admin']
    const clean = {}
    for (const k of allowed) if (k in patch) clean[k] = patch[k]
    if (Object.keys(clean).length === 0) {
      return new Response(JSON.stringify({ error: 'No editable fields provided' }), { status: 400, headers })
    }

    // If the email is being changed, update the Auth login email FIRST. If that
    // fails (e.g. the address is already registered to another account), abort
    // before touching the profile so nothing ends up half-changed.
    let authEmailUpdated = false
    if (typeof clean.email === 'string' && clean.email.trim()) {
      const { error: authErr } = await admin.auth.admin.updateUserById(userId, {
        email: clean.email.trim(),
        email_confirm: true   // admin-set: treat as confirmed, no verification email
      })
      if (authErr) {
        const raw = String((authErr && authErr.message) || authErr)
        const msg = /already|registered|exists|duplicate/i.test(raw)
          ? 'That email is already in use by another account.'
          : ('Could not update login email: ' + raw)
        return new Response(JSON.stringify({ error: msg }), { status: 400, headers })
      }
      authEmailUpdated = true
    }

    const { error: upErr } = await admin.from('profiles').update(clean).eq('id', userId)
    if (upErr) throw upErr

    return new Response(JSON.stringify({ success: true, authEmailUpdated }), { status: 200, headers })
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e && e.message) || e) }), { status: 500, headers })
  }
})