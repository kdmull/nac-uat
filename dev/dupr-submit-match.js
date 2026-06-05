// Supabase Edge Function: dupr-submit-match
// Deploy to: Supabase → Edge Functions → New Function → name: dupr-submit-match

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const DUPR_CLIENT_KEY    = 'test-ck-7eead86a-54e4-4e7c-fa3f-63d27f3fb784'
const DUPR_CLIENT_SECRET = 'test-cs-145b6343faff4f06fbc0bf35b46e01fa'
const DUPR_AUTH_URL      = 'https://uat.mydupr.com/api/v1.0/auth/login'
const DUPR_MATCH_URL     = 'https://uat.mydupr.com/api/v1.0/match/save'
const DUPR_CLUB_ID       = 5297032259  // Your Club ID

// Cache token in memory for the lifetime of this function instance (up to 1 hour)
let cachedToken = null
let tokenExpiry = 0

async function getDuprToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken

  const credentials = btoa(`${DUPR_CLIENT_KEY}:${DUPR_CLIENT_SECRET}`)
  const r = await fetch(DUPR_AUTH_URL, {
    method: 'POST',
    headers: {
      'x-authorization': credentials,
      'Content-Type': 'application/json'
    }
  })

  if (!r.ok) {
    const err = await r.text()
    throw new Error(`DUPR auth failed: ${r.status} ${err}`)
  }

  const data = await r.json()
  cachedToken = data.token || data.accessToken || data.access_token
  tokenExpiry = Date.now() + (55 * 60 * 1000) // 55 min (token valid for 60)
  return cachedToken
}

serve(async (req) => {
  // CORS headers for browser requests
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type, authorization',
    'Content-Type': 'application/json'
  }

  if (req.method === 'OPTIONS') return new Response('ok', { headers })

  try {
    const body = await req.json()
    const { match, leagueKey, leagueName, week, matchNum, format } = body

    // Validate required fields
    if (!match || !match.teamA || !match.teamB) {
      return new Response(JSON.stringify({ error: 'Missing match data' }), { status: 400, headers })
    }

    // Get DUPR bearer token
    const token = await getDuprToken()

    // Build match payload
    const matchDate = new Date().toISOString().split('T')[0] // yyyy-MM-dd
    const identifier = `${leagueKey}-w${week}-m${matchNum}-${Date.now()}`

    const payload = {
      identifier,
      location: 'Marietta, OH',
      matchDate,
      teamA: match.teamA,
      teamB: match.teamB,
      format: format || 'SINGLES',  // SINGLES or DOUBLES
      event: leagueName || 'NAC Pickleball League',
      bracket: `Week ${week}`,
      matchType: 'SIDEOUT',
      clubId: DUPR_CLUB_ID,
      matchSource: 'CLUB'
    }

    // Submit to DUPR
    const duprRes = await fetch(DUPR_MATCH_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    })

    const duprData = await duprRes.json()

    if (!duprRes.ok || duprData.status === 'ERROR') {
      console.error('DUPR match submission failed:', duprData)
      return new Response(JSON.stringify({ error: 'DUPR submission failed', details: duprData }), { status: 400, headers })
    }

    console.log('DUPR match submitted:', duprData)
    return new Response(JSON.stringify({
      success: true,
      matchCode: duprData.result?.matchCode,
      hashedMatchCode: duprData.result?.hashedMatchCode,
      identifier
    }), { headers })

  } catch (e) {
    console.error('Edge function error:', e)
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers })
  }
})
