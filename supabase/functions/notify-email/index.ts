// ============================================================
// Edge Function: notify-email
// Sends an admin notification email on key events (new account, new score).
// Uses Resend (https://resend.com). Set these function secrets:
//   RESEND_API_KEY  — your Resend API key
//   NOTIFY_TO       — where notifications go (your email)
//   NOTIFY_FROM     — verified sender, e.g. "NAC Pickleball <noreply@nacpickleball.com>"
//                     (for quick testing you can use "onboarding@resend.dev")
//
// Input (POST JSON): { type: "account" | "score", data: {...} }
// Never blocks the caller: returns 200 with {skipped:true} if not configured,
// and swallows send errors (logged) so the app flow is never interrupted.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL   = Deno.env.get('SUPABASE_URL') || ''
const SERVICE_ROLE   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const sb = (SUPABASE_URL && SERVICE_ROLE) ? createClient(SUPABASE_URL, SERVICE_ROLE) : null

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') || ''
const NOTIFY_TO      = Deno.env.get('NOTIFY_TO') || ''
const NOTIFY_FROM    = Deno.env.get('NOTIFY_FROM') || 'NAC Pickleball <onboarding@resend.dev>'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

function esc(v: unknown) {
  return String(v ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string))
}
function names(v: any) {
  if (Array.isArray(v)) return v.filter(Boolean).join(' & ')
  return String(v ?? '')
}

function buildEmail(type: string, data: any): { subject: string; html: string } {
  const when = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })
  if (type === 'account') {
    const nm = String(data.name || '').trim()
    return {
      subject: `New NAC Pickleball account${nm ? ' — ' + nm : ''}`,
      html: `<h2 style="font-family:sans-serif">New account created</h2>
        ${nm ? `<p style="font-family:sans-serif"><b>Name:</b> ${esc(nm)}</p>` : ''}
        <p style="font-family:sans-serif"><b>Email:</b> ${esc(data.email)}</p>
        <p style="font-family:sans-serif;color:#666">${esc(when)} ET</p>`,
    }
  }
  if (type === 'score') {
    const games = (data.games || []).filter((g: any) => g && g.s1 != null && g.s2 != null)
      .map((g: any) => `${esc(g.s1)}-${esc(g.s2)}`).join(', ')
    return {
      subject: `New score — ${data.league || 'League'} (Week ${esc(data.week)})`,
      html: `<h2 style="font-family:sans-serif">Score submitted</h2>
        <p style="font-family:sans-serif"><b>${esc(data.league)}</b> — Week ${esc(data.week)}, Match ${esc(data.match)}</p>
        <p style="font-family:sans-serif">${esc(names(data.team1))} &nbsp;vs&nbsp; ${esc(names(data.team2))}</p>
        <p style="font-family:sans-serif"><b>Games:</b> ${games || '—'}</p>
        <p style="font-family:sans-serif"><b>Winner:</b> ${esc(names(data.winner))}</p>
        <p style="font-family:sans-serif;color:#666">${esc(when)} ET</p>`,
    }
  }
  return { subject: 'NAC Pickleball notification', html: `<pre>${esc(JSON.stringify(data))}</pre>` }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const { type, data } = await req.json().catch(() => ({}))
    if (!type) return json({ error: 'Missing type' }, 400)
    if (!RESEND_API_KEY) {
      console.warn('notify-email not configured (RESEND_API_KEY); skipping.')
      return json({ skipped: true })
    }

    let to = ''
    let subject = ''
    let html = ''

    if (type === 'partner') {
      // Alert the SELECTED partner. Look up their email server-side.
      const d = data || {}
      let email = d.partnerEmail || ''
      let name = d.partnerName || ''
      if (!email && sb && d.partnerUserId) {
        const { data: prof } = await sb.from('profiles').select('email, first_name').eq('id', d.partnerUserId).maybeSingle()
        if (prof) { email = prof.email || ''; name = name || prof.first_name || '' }
      }
      if (!email) { console.warn('notify-email partner: no email found for', d.partnerUserId); return json({ skipped: true, reason: 'no partner email' }) }
      const when = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })
      const by = esc(d.byName || 'A player')
      const lg = esc(d.league || 'a league')
      to = email
      subject = `${d.byName || 'Someone'} chose you as their partner — NAC Pickleball`
      html = `<h2 style="font-family:sans-serif">You've been chosen as a partner</h2>
        <p style="font-family:sans-serif">${name ? 'Hi ' + esc(name) + ',<br><br>' : ''}<b>${by}</b> selected you as their partner for <b>${lg}</b>.</p>
        ${d.status === 'pending'
          ? `<p style="font-family:sans-serif">Log in to your NAC Pickleball account to accept the partnership.</p>`
          : `<p style="font-family:sans-serif">You're all set as partners for this league.</p>`}
        <p style="font-family:sans-serif;color:#666">${esc(when)} ET</p>`
    } else {
      // Admin notifications (account, score) go to NOTIFY_TO.
      if (!NOTIFY_TO) { console.warn('notify-email: NOTIFY_TO not set; skipping.'); return json({ skipped: true }) }
      to = NOTIFY_TO
      const built = buildEmail(type, data || {})
      subject = built.subject
      html = built.html
    }

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: NOTIFY_FROM, to: [to], subject, html }),
    })
    const body = await res.text()
    if (!res.ok) { console.error('Resend error', res.status, body.slice(0, 200)); return json({ sent: false, status: res.status }, 200) }
    return json({ sent: true })
  } catch (e) {
    console.error('notify-email error:', e)
    return json({ sent: false, error: String((e as Error).message || e) }, 200)
  }
})