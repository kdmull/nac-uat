// ============================================================
// Edge Function: admin-set-password
// Lets a verified admin either (a) send a password-reset email to a user, or
// (b) set a user's password directly. Uses the service role for the auth admin
// API, and refuses anyone whose profile is not is_admin.
//
// Body:
//   { userId, mode: 'reset_email' }            → emails the user a reset link
//   { userId, mode: 'set', newPassword: '...' } → sets the password directly
//
// Optional secret: SITE_URL (used as the reset-email redirect target).
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SITE_URL     = Deno.env.get('SITE_URL') || 'https://nacpickleball.com/dev/dev-auth.html'
const sb = createClient(SUPABASE_URL, SERVICE_ROLE)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    // ── caller must be a signed-in admin ──
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim()
    if (!token) return json({ error: 'Not signed in' }, 401)
    const { data: { user }, error: uErr } = await sb.auth.getUser(token)
    if (uErr || !user) return json({ error: 'Invalid or expired session — sign in again' }, 401)
    const { data: me } = await sb.from('profiles').select('is_admin').eq('id', user.id).maybeSingle()
    if (!me || !me.is_admin) return json({ error: 'Your account does not have admin access' }, 403)

    const { userId, mode, newPassword } = await req.json().catch(() => ({}))
    if (!userId || !mode) return json({ error: 'Missing userId or mode' }, 400)

    // Look up the target's email (needed for reset, useful for the audit log).
    const { data: target } = await sb.from('profiles').select('email').eq('id', userId).maybeSingle()

    if (mode === 'reset_email') {
      if (!target || !target.email) return json({ error: 'That account has no email on file' }, 400)
      const { error } = await sb.auth.resetPasswordForEmail(target.email, { redirectTo: SITE_URL })
      if (error) { console.error('reset email failed:', error.message); return json({ error: error.message }, 500) }
      console.log(`admin ${user.id} sent a password reset to ${userId}`)
      return json({ success: true, sentTo: target.email })
    }

    if (mode === 'set') {
      if (typeof newPassword !== 'string' || newPassword.length < 8)
        return json({ error: 'Password must be at least 8 characters' }, 400)
      const { error } = await sb.auth.admin.updateUserById(userId, { password: newPassword })
      if (error) { console.error('set password failed:', error.message); return json({ error: error.message }, 500) }
      console.log(`admin ${user.id} set the password for ${userId}`)
      return json({ success: true })
    }

    return json({ error: 'Unknown mode' }, 400)
  } catch (e) {
    console.error('admin-set-password error:', e)
    return json({ error: String((e as Error).message || e) }, 500)
  }
})