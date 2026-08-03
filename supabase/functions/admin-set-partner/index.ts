// Supabase Edge Function: admin-set-partner
// Deploy to: Supabase -> Edge Functions -> New Function -> name: admin-set-partner
//
// Admin-only: set or clear a player's doubles partner for a season. This is the
// admin override — it writes BOTH sides of the partnership (no invite/acceptance
// step) and cleans up any dangling links left behind on previous partners.
//
// Body: { userId, seasonId, partnerUserId }   (partnerUserId null/"" = clear)
//
// Rules:
//   - Both players must have an active registration in the SAME league this
//     season (move them via admin-manage-membership first if needed).
//   - Old partners on either side get their reciprocal links cleared.

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
    const seasonId = body && body.seasonId
    const partnerUserId = (body && body.partnerUserId) || null
    if (!userId || !seasonId) {
      return new Response(JSON.stringify({ error: 'Missing userId or seasonId' }), { status: 400, headers })
    }
    if (partnerUserId === userId) {
      return new Response(JSON.stringify({ error: 'A player cannot be their own partner' }), { status: 400, headers })
    }

    const activeRow = async (uid) => {
      const { data } = await admin.from('league_members').select('*')
        .eq('user_id', uid).eq('season_id', seasonId).eq('status', 'active')
      return (data || [])[0] || null
    }
    const clearReciprocal = async (uid, pointsAt) => {
      // Clear `uid`'s partner link only if it points at `pointsAt`
      if (!uid) return
      const row = await activeRow(uid)
      if (row && row.partner_user_id === pointsAt) {
        await admin.from('league_members')
          .update({ partner_user_id: null, partner_name: null, partner_status: null })
          .eq('id', row.id)
      }
    }
    const fullName = (r) => `${r.first_name || ''} ${r.last_name || ''}`.trim()

    const mine = await activeRow(userId)
    if (!mine) {
      return new Response(JSON.stringify({ error: 'Player is not registered in a league this season' }), { status: 400, headers })
    }

    if (!partnerUserId) {
      // Clear partner on both sides
      await clearReciprocal(mine.partner_user_id, userId)
      const { error } = await admin.from('league_members')
        .update({ partner_user_id: null, partner_name: null, partner_status: null })
        .eq('id', mine.id)
      if (error) throw error
      return new Response(JSON.stringify({ success: true, cleared: true }), { status: 200, headers })
    }

    const theirs = await activeRow(partnerUserId)
    if (!theirs || theirs.league_id !== mine.league_id) {
      return new Response(JSON.stringify({
        error: 'Partner must be registered in the same league. Move them into the league first, then pair them.'
      }), { status: 400, headers })
    }

    // Unhook both players' previous partners (if different from the new pairing)
    if (mine.partner_user_id && mine.partner_user_id !== partnerUserId) {
      await clearReciprocal(mine.partner_user_id, userId)
    }
    if (theirs.partner_user_id && theirs.partner_user_id !== userId) {
      await clearReciprocal(theirs.partner_user_id, partnerUserId)
    }

    // Write both sides, admin-confirmed
    const { error: e1 } = await admin.from('league_members')
      .update({ partner_user_id: partnerUserId, partner_name: fullName(theirs), partner_status: 'accepted' })
      .eq('id', mine.id)
    if (e1) throw e1
    const { error: e2 } = await admin.from('league_members')
      .update({ partner_user_id: userId, partner_name: fullName(mine), partner_status: 'accepted' })
      .eq('id', theirs.id)
    if (e2) throw e2

    return new Response(JSON.stringify({ success: true, partnerName: fullName(theirs) }), { status: 200, headers })
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e && e.message) || e) }), { status: 500, headers })
  }
})