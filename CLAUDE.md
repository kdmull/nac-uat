# NAC Pickleball — nacpickleball.com

League and tournament management for Nitro Athletic Complex, with DUPR rating
integration. Static site on GitHub Pages, backed by Supabase.

## Stack

- Vanilla HTML/CSS/JS. No build step, no framework, no bundler.
- Every page is a self-contained `.html` with inline `<style>` and `<script>`.
- Shared code lives in `shared.js` (data access, scoring, partner search) and
  `admin-nav.js` (nav injection + mobile menu). `tournament-engine.js` holds
  pool/bracket logic.
- Backend: Supabase (Postgres + Edge Functions, Deno/TypeScript).
- Shared base CSS (reset, tokens, nav, toast) lives in `styles.css`, loaded
  before each page's inline `<style>` so page rules still win. Page-specific
  styles stay inline — `.btn`, `.page`, `.spinner` and the media queries
  genuinely differ per page and must not be hoisted.
- `config.js` holds the Supabase URL and keys for both environments and picks
  one by hostname. It loads in `<head>`, ahead of everything that reads it.
- Deploy = push to `main`. GitHub Pages serves the repo root.

## Environments

Two GitHub repos share one history and run byte-identical code. Which
Supabase project a page talks to is decided at load time by hostname.

| | Site | Repo | Supabase |
|---|---|---|---|
| Production | nacpickleball.com | `kdmull.github.io` | `owsvfvhlbagxxmncwmtn` |
| UAT | uat.nacpickleball.com | `nac-uat` | `ymuqnrdwxiaskyfxsmui` |

`config.js` treats **anything that is not nacpickleball.com as UAT**. That
direction is deliberate: if hostname detection ever fails, the fallback is
test data, never live member records.

Promote UAT to production with:

```
./promote.sh "what this release contains" && git push origin main
```

**Never promote with a plain `git merge` or `git push`.** The two repos must
carry different `CNAME` files, and a normal merge rewrites production's,
taking nacpickleball.com down. A `.gitattributes` merge driver does *not*
protect against this — merge drivers only run when *both* sides changed the
file, and promotion changes `CNAME` on one side only. `promote.sh` restores
`CNAME` explicitly after the merge and asserts it before handing back.

The nightly backup workflow is disabled on the UAT repo (a repo setting, not
a file change, so it creates no second divergence). It commits database dumps
into the repo, so it must never run there with production secrets.

## Conventions

- **No emoji** in UI copy, commit messages, or docs.
- Minimal, flat design. Brand: navy `#1a2a6c`, green `#4caf28`, gold `#d4a017`.
  Fonts: Barlow Condensed (display) and Barlow (body).
- Prefer one focused change at a time over sweeping refactors.
- Match the surrounding style of whatever file you're editing — these pages
  were written by hand and are internally consistent.

## Verifying changes

There's no test suite. Before considering an edit done:

- Extract each inline `<script>` and run `node --check` on it. A syntax error
  in one page is invisible until someone loads that page.
- For TypeScript Edge Functions, `tsc --noEmit --skipLibCheck` (ignore
  "Cannot find name 'Deno'" — those globals exist at runtime).
- For visual changes, render at 390px wide as well as desktop. Mobile is the
  primary way members use this site.

## Things that have bitten us

- **Stale caches.** GitHub Pages' CDN and Safari both hold old JS. If a change
  seems not to apply, check the raw file on `raw.githubusercontent.com` before
  assuming the code is wrong.
- **RLS is on for every table.** The browser can only write to
  `league_members` (own rows). Everything else goes through Edge Functions
  using the secret key. If a write fails with "violates row-level security",
  the fix is usually a policy, not client code.
- **`profiles` is own-row-only.** It holds emails, phones and DUPR tokens.
  To read other players' names, use the `public_players` view
  (id, first_name, last_name, dupr_id).
- **Supabase key migration.** `SUPABASE_SERVICE_ROLE_KEY` is deprecated in
  favour of `SUPABASE_SECRET_KEYS` (a JSON dict). Edge Functions must read
  either, and should build their client *inside* the handler — a failure at
  module load crashes the function and surfaces in the browser as
  "network connection lost", which looks nothing like a key problem.
- **Auth vs secret keys.** `auth.getUser()` must be called with a client built
  from the *publishable* key. Passing a secret key makes the auth endpoint
  reject the request, reported confusingly as "invalid or expired session".
- **Player names.** Stored as full names ("First Last"). Older data used
  "First L."; lookups should tolerate both.
- **DUPR ratings arrive as strings** with five decimals. Always
  `parseFloat(...)` then `.toFixed(2)`.

## DUPR integration

- Hosts are environment-driven, never hardcoded: `DUPR_API_BASE` is
  `https://prod.mydupr.com` (UAT was `uat.mydupr.com`). SSO login frame is
  `https://dupr.gg/login-external-app/{base64 client key}`.
- The webhook identifies us by **client key** (`ck-…`), not the numeric client
  id — the receiver accepts both.
- `dupr-webhook` must be deployed with `--no-verify-jwt` or DUPR can't reach it.
  It always returns 200, so failures only appear in its logs.
- Ratings flow: SSO connect → `dupr-subscribe-user` → DUPR sends `RATING_SEED`
  → `dupr_ratings` table → UI reads that table first, batch API as fallback.

## Secrets

Never commit credentials. DUPR keys, Supabase service keys and Resend keys
live only in Supabase Edge Function secrets. The Supabase *anon* key in the
HTML is public by design and protected by RLS.

Because each environment has its own Supabase project, its secrets are its
own — production holds live DUPR credentials, UAT holds test ones, and
neither is in git. Anything environment-specific that a *browser* needs
should come from an Edge Function on that project rather than being
hardcoded: see `dupr-sso-config`, which serves the DUPR client key and SSO
host. Hardcoding those is what previously put a test client key on the
production site.

Two ways credentials have leaked here before, both worth remembering:

- **Deleting a file does not remove it from git history.** A stray
  `dupr-submit-match.js` carried a test client key *and secret*; they remain
  recoverable from earlier commits. Rotate, don't just delete.
- **Archives get served too.** `dev.zip` sat in the repo root, so GitHub
  Pages happily served 251KB of old pages — including the credentials that
  had been "removed". `*.zip` is now gitignored; keep archives off the repo.
