/* Environment configuration for NAC Pickleball.
   Loaded before shared.js and before any page script that talks to Supabase.

   Production is nacpickleball.com. Everything else -- uat.nacpickleball.com,
   localhost, any preview -- resolves to UAT. The check is deliberately
   written this way round: if hostname detection ever fails, the site falls
   back to UAT rather than writing to live member data.

   Both key forms are kept: SUPABASE_KEY is the legacy JWT anon key, and
   SUPABASE_ANON_KEY is the newer publishable key used by the stats pages.
   The anon/publishable keys are public by design and protected by RLS. */

const NAC_ENV =
  (location.hostname === 'nacpickleball.com' ||
   location.hostname === 'www.nacpickleball.com') ? 'prod' : 'uat';

const NAC_CONFIG = {
  prod: {
    SUPABASE_URL:      'https://owsvfvhlbagxxmncwmtn.supabase.co',
    SUPABASE_KEY:      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im93c3ZmdmhsYmFneHhtbmN3bXRuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2NDQyMzksImV4cCI6MjA5NjIyMDIzOX0.AFemWKpLUuP8z1dAG5-j1X__EPyTdaqDFxece09-0EQ',
    SUPABASE_ANON_KEY: 'sb_publishable_iYuBBWxRTIXA8h0V-wbRrw_IRgGpbyK',
  },
  uat: {
    // This project issues only the newer publishable key, which is valid for
    // both uses: it authenticates REST (apikey + Bearer) and the auth endpoint.
    SUPABASE_URL:      'https://ymuqnrdwxiaskyfxsmui.supabase.co',
    SUPABASE_KEY:      'sb_publishable_CLdJDcB4F8nygbvPmfz4yQ_WhnEdbXm',
    SUPABASE_ANON_KEY: 'sb_publishable_CLdJDcB4F8nygbvPmfz4yQ_WhnEdbXm',
  },
}[NAC_ENV];

const SUPABASE_URL      = NAC_CONFIG.SUPABASE_URL;
const SUPABASE_KEY      = NAC_CONFIG.SUPABASE_KEY;
const SUPABASE_ANON_KEY = NAC_CONFIG.SUPABASE_ANON_KEY;
