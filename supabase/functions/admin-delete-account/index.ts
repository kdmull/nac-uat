// Supabase Edge Function: admin-delete-account
// Deploy to: Supabase -> Edge Functions -> New Function -> name: admin-delete-account
//
// Permanently deletes a user: their Auth login PLUS their profile row and
// league registrations. Only callable by a signed-in admin account — the
// caller's JWT is verified and their profiles.is_admin must be true.
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically by the
// Edge Functions runtime; no secrets need to be set manually.

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

    // The caller's access token (from the signed-in admin account).
    const authHeader = req.headers.get('Authorization') || ''
    const token = authHeader.replace(/^Bearer\s+/i, '')
    if (!token) {
      return new Response(JSON.stringify({ error: 'Missing auth token' }), { status: 401, headers })
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } })

    // Identify the caller and confirm they are an admin.
    const { data: caller, error: callerErr } = await admin.auth.getUser(token)
    if (callerErr || !caller || !caller.user) {
      return new Response(JSON.stringify({ error: 'Invalid session' }), { status: 401, headers })
    }
    const callerId = caller.user.id

    const { data: prof, error: profErr } = await admin
      .from('profiles').select('is_admin').eq('id', callerId).single()
    if (profErr || !prof || !prof.is_admin) {
      return new Response(JSON.stringify({ error: 'Not authorized' }), { status: 403, headers })
    }

    const body = await req.json()
    const userId = body && body.userId
    if (!userId) {
      return new Response(JSON.stringify({ error: 'Missing userId' }), { status: 400, headers })
    }
    if (userId === callerId) {
      return new Response(JSON.stringify({ error: 'You cannot delete your own account.' }), { status: 400, headers })
    }

    // Remove app data first (service role bypasses RLS), then the Auth login.
    await admin.from('league_members').delete().eq('user_id', userId)
    await admin.from('profiles').delete().eq('id', userId)

    const { error: delErr } = await admin.auth.admin.deleteUser(userId)
    if (delErr) {
      return new Response(JSON.stringify({ error: 'Auth delete failed: ' + delErr.message }), { status: 500, headers })
    }

    return new Response(JSON.stringify({ success: true }), { status: 200, headers })
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e && e.message) || e) }), { status: 500, headers })
  }
})