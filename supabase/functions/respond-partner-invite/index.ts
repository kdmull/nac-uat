// Supabase Edge Function: respond-partner-invite
// Deploy to: Supabase -> Edge Functions -> New Function -> name: respond-partner-invite
//
// Self-service: lets a signed-in user ACCEPT or DECLINE a partner invite that
// another player sent them. The caller is identified from their JWT — the
// function verifies the inviter's registration really points at the caller
// before touching anything, so nobody can accept/decline on someone else's
// behalf. Runs with the service role because accepting requires updating the
// INVITER's row (blocked by row-level security from the client).
//
// Body: { fromUserId, seasonId, action: 'accept' | 'decline' }
//
// Accept:
//   - inviter row -> partner_status 'accepted', partner_name refreshed
//   - caller gets a matching active row in the same league (created if they
//     have none; updated if they registered in that league already). If the
//     caller is registered in a DIFFERENT league this season, returns an error
//     telling them to switch leagues first.
// Decline:
//   - inviter row -> partner fields cleared, partner_status 'declined'
//     (their dashboard shows a dismissible notice so they know to re-pick)

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
    const meId = caller.user.id

    const body = await req.json().catch(() => ({}))
    const fromUserId = body && body.fromUserId
    const seasonId = body && body.seasonId
    const action = body && body.action
    if (!fromUserId || !seasonId || !['accept', 'decline'].includes(action)) {
      return new Response(JSON.stringify({ error: 'Missing fromUserId, seasonId, or valid action' }), { status: 400, headers })
    }
    if (fromUserId === meId) {
      return new Response(JSON.stringify({ error: 'Cannot respond to your own invite' }), { status: 400, headers })
    }

    // The inviter's active registration this season — must point at the caller.
    const { data: invRows } = await admin
      .from('league_members').select('*')
      .eq('user_id', fromUserId).eq('season_id', seasonId).eq('status', 'active')
    const inviter = (invRows || [])[0]
    if (!inviter || inviter.partner_user_id !== meId) {
      return new Response(JSON.stringify({ error: 'Invite not found (it may have been withdrawn)' }), { status: 404, headers })
    }

    if (action === 'decline') {
      const { error } = await admin.from('league_members')
        .update({ partner_user_id: null, partner_name: null, partner_status: 'declined' })
        .eq('id', inviter.id)
      if (error) throw error
      return new Response(JSON.stringify({ success: true, action: 'declined' }), { status: 200, headers })
    }

    // --- accept ---
    // Caller's own profile (for names on the new/updated row)
    const { data: myProf } = await admin
      .from('profiles').select('first_name,last_name,email,phone').eq('id', meId).single()
    const myFullName = `${(myProf && myProf.first_name) || ''} ${(myProf && myProf.last_name) || ''}`.trim()
    const inviterFullName = `${inviter.first_name || ''} ${inviter.last_name || ''}`.trim()

    // Caller's existing active registration this season (if any)
    const { data: myRows } = await admin
      .from('league_members').select('*')
      .eq('user_id', meId).eq('season_id', seasonId).eq('status', 'active')
    const mine = (myRows || [])[0]

    if (mine && mine.league_id !== inviter.league_id) {
      return new Response(JSON.stringify({
        error: `You're already registered in a different league this season. Switch or leave that league first, then accept.`
      }), { status: 409, headers })
    }

    if (mine) {
      const { error } = await admin.from('league_members')
        .update({ partner_user_id: fromUserId, partner_name: inviterFullName, partner_status: 'accepted' })
        .eq('id', mine.id)
      if (error) throw error
    } else {
      const { error } = await admin.from('league_members').insert({
        league_id: inviter.league_id,
        season_id: seasonId,
        user_id: meId,
        first_name: (myProf && myProf.first_name) || null,
        last_name: (myProf && myProf.last_name) || null,
        email: (myProf && myProf.email) || null,
        phone: (myProf && myProf.phone) || null,
        partner_user_id: fromUserId,
        partner_name: inviterFullName,
        partner_status: 'accepted',
        status: 'active'
      })
      if (error) throw error
    }

    // Mark the inviter's side accepted (and refresh the stored partner name)
    const { error: invErr } = await admin.from('league_members')
      .update({ partner_status: 'accepted', partner_name: myFullName || inviter.partner_name })
      .eq('id', inviter.id)
    if (invErr) throw invErr

    return new Response(JSON.stringify({ success: true, action: 'accepted', leagueId: inviter.league_id }), { status: 200, headers })
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e && e.message) || e) }), { status: 500, headers })
  }
})