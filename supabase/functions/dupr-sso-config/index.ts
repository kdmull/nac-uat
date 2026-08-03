// Returns the DUPR SSO parameters for THIS Supabase project's environment.
//
// Why this exists: dupr-connect.html used to hardcode the DUPR client key and
// SSO host. That meant production and UAT needed different copies of the file,
// and the test client key ended up committed to the production repo. Serving
// these from the environment's own project keeps both out of git entirely --
// production can never ship test keys, because it has no copy of them.
//
// The client key is public by design (it travels in the SSO login URL). The
// client SECRET is never returned here; it stays in Edge Function secrets and
// is only used server-side.
//
// Secrets read: DUPR_CLIENT_KEY, DUPR_SSO_BASE

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

Deno.serve((req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // Read secrets inside the handler: a throw at module load surfaces in the
  // browser as "network connection lost", which looks nothing like a config
  // problem and costs an afternoon to track down.
  try {
    const clientKey = Deno.env.get("DUPR_CLIENT_KEY");
    const ssoBase = Deno.env.get("DUPR_SSO_BASE");

    if (!clientKey) return json({ error: "DUPR_CLIENT_KEY is not set on this project" }, 500);
    if (!ssoBase) return json({ error: "DUPR_SSO_BASE is not set on this project" }, 500);

    return json({
      // base64 of the client key, which is the form the SSO URL wants
      clientKeyB64: btoa(clientKey),
      ssoBase,
      // Handy for spotting at a glance which environment answered, without
      // ever exposing the key itself.
      keyKind: clientKey.startsWith("test-") ? "test" : "live",
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
