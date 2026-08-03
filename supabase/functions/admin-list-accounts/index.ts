// Supabase Edge Function: admin-list-accounts
// Deploy to: Supabase -> Edge Functions -> New Function -> name: admin-list-accounts
//
// Returns every profile plus league memberships for a season, so the admin
// accounts page can list all users regardless of row-level security. Only
// callable by a signed-in admin account.

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
    const seasonId = (body && body.seasonId) || 'spring2026'

    const { data: profiles, error: pErr } = await admin
      .from('profiles')
      .select('id,first_name,last_name,email,phone,dupr_id,is_admin')
    if (pErr) throw pErr

    const { data: members } = await admin
      .from('league_members')
      .select('user_id,league_id,partner_name,partner_user_id,partner_status,status')
      .eq('season_id', seasonId)
      .eq('status', 'active')

    return new Response(JSON.stringify({ profiles: profiles || [], members: members || [] }), { status: 200, headers })
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e && e.message) || e) }), { status: 500, headers })
  }
})