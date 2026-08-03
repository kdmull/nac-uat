// ============================================================
// Edge Function: dupr-webhook   (PUBLIC RECEIVER)
// Receives DUPR RATING / RATING_SEED events and upserts them into dupr_ratings.
// Must be HTTPS, valid cert, and return 200 quickly for both the registration
// handshake and real events.
//
// ⚠️ DEPLOY WITH JWT VERIFICATION OFF:
//    supabase functions deploy dupr-webhook --no-verify-jwt
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

// Only accept events for our own account. DUPR identifies the partner in the
// webhook payload by the CLIENT KEY (ck-…), not the numeric Client ID, so both
// are accepted — comparing against the numeric id alone silently discarded
// every real rating event.
const ACCEPTED_IDS = [
  (Deno.env.get('DUPR_CLIENT_ID') || '').trim(),
  (Deno.env.get('DUPR_CLIENT_KEY') || '').trim(),
].filter(Boolean).map(v => v.toLowerCase())

const ok = () => new Response('OK', { status: 200, headers: { 'Content-Type': 'text/plain' } })

Deno.serve(async (req) => {
  if (req.method !== 'POST') return ok()   // GET handshake / health check
  try {
    const body = await req.json().catch(() => null)
    if (!body) return ok()

    if (ACCEPTED_IDS.length && body.clientId &&
        !ACCEPTED_IDS.includes(String(body.clientId).trim().toLowerCase())) {
      console.warn('dupr-webhook: clientId mismatch, ignoring', body.clientId,
                   '(accepted:', ACCEPTED_IDS.join(', '), ')')
      return ok()
    }

    const event = body.event || 'RATING'
    const msg = body.message || {}
    const duprId = msg.duprId
    if (!duprId) { console.log('dupr-webhook: no duprId, ignoring'); return ok() }

    // Client built here so a key problem is logged, not a startup crash.
    const sb = createClient(SUPABASE_URL, resolveSecretKey(), { auth: { persistSession: false } })

    const rating = msg.rating || null
    await sb.from('dupr_ratings').upsert({
      dupr_id: String(duprId),
      singles: rating?.singles ?? null,
      doubles: rating?.doubles ?? null,
      singles_reliability: rating?.singlesReliability ?? null,
      doubles_reliability: rating?.doublesReliability ?? null,
      last_event: event,
      last_match_id: rating?.matchId ?? null,
      updated_at: new Date().toISOString(),
    })
    console.log('dupr-webhook stored', event, 'for', duprId, 'singles:', rating?.singles, 'doubles:', rating?.doubles)
  } catch (e) {
    // Never fail the webhook — log and still 200 so DUPR doesn't retry-storm.
    console.error('dupr-webhook error (returning 200 anyway):', e)
  }
  return ok()
})