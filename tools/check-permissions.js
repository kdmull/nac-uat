#!/usr/bin/env node
//
// Checks what an anonymous visitor can read from each environment's database.
//
// Why this exists: member emails and DUPR access tokens were both publicly
// readable at one point, and neither showed up as an obvious misconfiguration.
// The protection is column-level GRANTs, which do NOT appear in a pg_policies
// listing and are silently undone by a blanket "grant select on all tables".
// A SQL-only audit reports league_members as fine when it is not, so this
// probes the REST API instead -- the same surface an attacker would use.
//
// Reads both environments' URL and key from config.js, so it can never drift
// from what the site itself uses. No secrets live here.
//
//   node tools/check-permissions.js          both environments
//   node tools/check-permissions.js prod     one of: prod | uat
//
// Exit code 0 = all good, 1 = something is exposed or broken.

const fs = require('fs');
const path = require('path');

const CONFIG = path.join(__dirname, '..', 'config.js');
const src = fs.readFileSync(CONFIG, 'utf8');

// config.js picks an environment from location.hostname; feed it one.
const cfgFor = (hostname) =>
  new Function('location', src + '\n; return { SUPABASE_URL, SUPABASE_KEY, SUPABASE_ANON_KEY };')({ hostname });

const ENVS = {
  prod: { label: 'production', hostname: 'nacpickleball.com' },
  uat:  { label: 'uat',        hostname: 'uat.nacpickleball.com' },
};

// Anonymous requests that MUST be refused. Each one has leaked before or
// would leak credentials/PII if the grant were ever widened.
const MUST_BLOCK = [
  ['league_members',     'select=*',             'every member column incl. email/phone'],
  ['league_members',     'select=email',         'member email addresses'],
  ['league_members',     'select=phone',         'member phone numbers'],
  ['league_members',     'select=first_name,email', 'email smuggled beside a safe column'],
  ['dupr_players',       'select=*',             'every column incl. DUPR tokens'],
  ['dupr_players',       'select=access_token',  'DUPR access tokens'],
  ['dupr_players',       'select=refresh_token', 'DUPR refresh tokens'],
  ['dupr_subscriptions', 'select=*',             'subscription rows (no browser code reads these)'],
];

// Anonymous requests that MUST keep working, or the public site breaks.
const MUST_READ = [
  ['league_members', 'select=league_id,user_id,first_name,last_name,partner_status', 'public roster'],
  ['dupr_players',   'select=league_key,player_name,dupr_id',                        'name -> dupr id lookup'],
  ['dupr_ratings',   'select=dupr_id,singles,doubles',                               'ratings on rosters'],
  ['public_players', 'select=id,first_name,last_name,dupr_id',                       'public player view'],
  ['pb_league',      'select=key',                                                   'league/season config'],
];

async function probe(base, key, table, query) {
  const url = `${base}/rest/v1/${table}?${query}&limit=1`;
  try {
    const r = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    const body = await r.text();
    let code = null;
    try { code = JSON.parse(body).code; } catch { /* array response */ }
    return { status: r.status, denied: code === '42501', code };
  } catch (e) {
    return { status: 0, denied: false, error: String(e.message || e) };
  }
}

async function checkEnv(envKey) {
  const env = ENVS[envKey];
  const cfg = cfgFor(env.hostname);
  const base = cfg.SUPABASE_URL;
  const key = cfg.SUPABASE_KEY;

  console.log(`\n${env.label}  (${base})`);

  if (/REPLACE_WITH/.test(base) || /REPLACE_WITH/.test(key)) {
    console.log('  SKIPPED - config.js still has placeholder values for this environment');
    return { failures: 0, skipped: true };
  }

  let failures = 0;

  console.log('  must be BLOCKED:');
  for (const [table, query, why] of MUST_BLOCK) {
    const r = await probe(base, key, table, query);
    const ok = r.denied;
    if (!ok) failures++;
    console.log(`    ${ok ? 'ok  ' : 'FAIL'}  ${table}?${query}${ok ? '' : `   <-- EXPOSED: ${why} (HTTP ${r.status}${r.code ? ', ' + r.code : ''})`}`);
  }

  console.log('  must be READABLE:');
  for (const [table, query, why] of MUST_READ) {
    const r = await probe(base, key, table, query);
    const ok = r.status === 200;
    if (!ok) failures++;
    console.log(`    ${ok ? 'ok  ' : 'FAIL'}  ${table}?${query.slice(0, 46)}${ok ? '' : `   <-- BROKEN: ${why} (HTTP ${r.status}${r.code ? ', ' + r.code : ''})`}`);
  }

  return { failures, skipped: false };
}

(async () => {
  const only = process.argv[2];
  const keys = only ? [only] : Object.keys(ENVS);
  if (only && !ENVS[only]) {
    console.error(`unknown environment "${only}" - use one of: ${Object.keys(ENVS).join(', ')}`);
    process.exit(2);
  }

  let total = 0;
  for (const k of keys) {
    const { failures } = await checkEnv(k);
    total += failures;
  }

  console.log(total === 0
    ? '\nAll checks passed.\n'
    : `\n${total} check(s) FAILED - see above.\n`);
  process.exit(total === 0 ? 0 : 1);
})();
