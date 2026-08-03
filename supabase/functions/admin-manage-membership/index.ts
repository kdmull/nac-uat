// Supabase Edge Function: admin-manage-membership
// Deploy to: Supabase -> Edge Functions -> New Function -> name: admin-manage-membership
//
// Adds, changes, or removes a player's league for a season. Only callable by a
// signed-in admin account. Pass leagueId = null/"" to remove them from a league.
// When a player's league changes or they're removed, partner links are cleared
// on both sides (a partnership doesn't carry across leagues).

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Fallback league list — the live catalog is read from pb_league 'nac_leagues'
const DEFAULT_LEAGUES = ['beginner', 'int1949', 'int50', 'adv1949', 'adv50', 'singles']

async function validLeagueIds(admin: any): Promise<string[]> {
  try {
    const { data } = await admin.from('pb_league').select('value').eq('key', 'nac_leagues').maybeSingle()
    const lgs = data && data.value && data.value.leagues
    if (Array.isArray(lgs) && lgs.length) return lgs.map((l: any) => String(l.id))
  } catch (_e) { /* fall through */ }
  return DEFAULT_LEAGUES
}

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
    const lid = (body && body.leagueId) ? String(body.leagueId) : null
    if (!userId || !seasonId) {
      return new Response(JSON.stringify({ error: 'Missing userId or seasonId' }), { status: 400, headers })
    }
    if (lid) {
      const valid = await validLeagueIds(admin)
      if (!valid.includes(lid)) {
        return new Response(JSON.stringify({ error: 'Invalid league' }), { status: 400, headers })
      }
    }

    // Current active membership for this season (if any).
    const { data: rows } = await admin
      .from('league_members')
      .select('id,partner_user_id')
      .eq('user_id', userId).eq('season_id', seasonId).eq('status', 'active')
    const existing = (rows || [])[0]
    const exPartnerId = existing ? existing.partner_user_id : null

    if (!lid) {
      // Remove from league
      if (existing) {
        const { error } = await admin.from('league_members')
          .delete().eq('user_id', userId).eq('season_id', seasonId).eq('status', 'active')
        if (error) throw error
      }
    } else if (existing) {
      // Move to a different league (clear partner — partnership is league-specific)
      const { error } = await admin.from('league_members')
        .update({ league_id: lid, partner_user_id: null, partner_name: null, partner_status: null })
        .eq('user_id', userId).eq('season_id', seasonId).eq('status', 'active')
      if (error) throw error
    } else {
      // No membership yet — add one
      const { error } = await admin.from('league_members')
        .insert({ user_id: userId, season_id: seasonId, league_id: lid, status: 'active' })
      if (error) throw error
    }

    // Clear the ex-partner's dangling reference back to this player.
    if (exPartnerId) {
      await admin.from('league_members')
        .update({ partner_user_id: null, partner_name: null, partner_status: null })
        .eq('user_id', exPartnerId).eq('season_id', seasonId).eq('status', 'active')
    }

    return new Response(JSON.stringify({ success: true, leagueId: lid }), { status: 200, headers })
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e && e.message) || e) }), { status: 500, headers })
  }
})