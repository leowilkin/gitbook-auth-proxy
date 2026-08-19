import { Hono } from "hono";
import * as jose from "jose";
import { env } from "./env.js";
import { isWhitelisted, getGroupsForUser } from "./db.js";

const auth = new Hono();

// build the post-auth redirect back to gitbook, attaching the signed jwt as a
// proper query param. `location` is usually a bare docs path, but in gitbook's
// MCP oauth flow it's a full authorize-resume URL that already carries its own
// query string (?gb_oauth_state=...). naive concat produced a second "?", so
// gitbook never saw jwt_token and the exchange failed with unsupported_grant_type.
function buildGitbookRedirect(location: string, jwt: string): string {
  const docsHost = new URL(env.GITBOOK_DOCS_URL).host;

  let base: URL;
  if (/^https?:\/\//i.test(location)) {
    base = new URL(location);
    // only ever hand the jwt to gitbook-controlled hosts — otherwise a crafted
    // `?location=https://evil.com` could exfiltrate a valid signing token.
    const host = base.host;
    const trusted =
      host === docsHost ||
      host === "sites.gitbook.com" ||
      host.endsWith(".gitbook.com") ||
      host.endsWith(".gitbook.io");
    if (!trusted) {
      throw new Error(`refusing to redirect jwt to untrusted host: ${host}`);
    }
  } else {
    const path = location.replace(/^\/+/, "");
    base = new URL(
      path ? `${env.GITBOOK_DOCS_URL}/${path}` : env.GITBOOK_DOCS_URL,
    );
  }

  base.searchParams.set("jwt_token", jwt);
  return base.toString();
}

// Step 1: GitBook redirects unauthenticated users here
auth.get("/login", (c) => {
  const location = c.req.query("location") || "";

  // build hack club auth oauth url
  const params = new URLSearchParams({
    client_id: env.HC_CLIENT_ID,
    redirect_uri: env.HC_REDIRECT_URI,
    response_type: "code",
    scope: "openid slack_id",
    state: location, // pass the gitbook location through
  });

  return c.redirect(`https://auth.hackclub.com/oauth/authorize?${params}`);
});

// Step 2: Hack Club Auth redirects back here after login
auth.get("/callback", async (c) => {
  const code = c.req.query("code");
  const location = c.req.query("state") || "";

  if (!code) {
    return c.text("missing authorization code", 400);
  }

  // exchange code for tokens
  const tokenRes = await fetch("https://auth.hackclub.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.HC_CLIENT_ID,
      client_secret: env.HC_CLIENT_SECRET,
      code,
      redirect_uri: env.HC_REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    console.error("token exchange failed:", err);
    return c.text("authentication failed", 500);
  }

  const tokens = (await tokenRes.json()) as {
    access_token: string;
    id_token?: string;
  };

  // get user info (slack_id)
  const meRes = await fetch("https://auth.hackclub.com/api/v1/me", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (!meRes.ok) {
    console.error("failed to fetch user info:", await meRes.text());
    return c.text("failed to get user info", 500);
  }

  const me = (await meRes.json()) as { identity?: { slack_id?: string } };
  const slackId = me.identity?.slack_id;

  if (!slackId) {
    return c.html(
      `<html><body style="font-family:system-ui;max-width:500px;margin:80px auto;text-align:center">
        <h2>no slack account linked</h2>
        <p>your hack club auth account doesn't have a linked slack ID. please link your slack account first.</p>
      </body></html>`,
      403,
    );
  }

  // check whitelist
  if (!isWhitelisted(slackId)) {
    return c.html(
      `<html><body style="font-family:system-ui;max-width:500px;margin:80px auto;text-align:center">
        <h2>access denied</h2>
        <p>your slack account (<code>${slackId}</code>) is not on the whitelist.</p>
        <p>ask an admin to run: <code>/docs whitelist add @you</code></p>
      </body></html>`,
      403,
    );
  }

  // build adaptive-content claims: each group the user belongs to becomes a
  // boolean claim (e.g. { fulltime: true }), which gitbook reads as
  // visitor.claims.fulltime for per-section visibility conditions.
  const claims: Record<string, boolean> = {};
  for (const group of getGroupsForUser(slackId)) {
    claims[group] = true;
  }

  // sign gitbook JWT
  const gitbookJwt = await new jose.SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(new TextEncoder().encode(env.GITBOOK_SIGNING_KEY));

  // redirect back to gitbook with the JWT
  return c.redirect(buildGitbookRedirect(location, gitbookJwt));
});

// where a signed-out visitor goes to end their hack club auth session. HCA has no
// logout we can link to (it's a CSRF-protected DELETE /logout on their dashboard) and
// its /oauth/authorize ignores `prompt=login`, so we can't force a re-auth from here
// — the best we can do is send people there to log out themselves before signing
// back in as someone else.
const HC_AUTH_URL = "https://auth.hackclub.com/";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// the login wall shown after the docs session has been dropped. `location` is the
// page the visitor was on, carried through so signing back in returns them there.
function loginWall(location: string): string {
  const href = `/login${location ? `?location=${encodeURIComponent(location)}` : ""}`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>signed out</title>
</head>
<body style="font-family:system-ui,-apple-system,sans-serif;max-width:26rem;margin:20vh auto;padding:0 1.5rem;line-height:1.5;color:#1a1a1a">
  <h2 style="margin:0 0 .5rem">you're signed out</h2>
  <p style="margin:0 0 1.5rem;color:#555">your docs session has ended. sign in with hack club auth to read the docs again.</p>
  <a href="${escapeHtml(href)}" style="display:block;text-align:center;background:#ec3750;color:#fff;text-decoration:none;font-weight:600;padding:.75rem 1rem;border-radius:.5rem">sign in</a>
  <p style="margin:1.5rem 0 0;font-size:.875rem;color:#777">
    want a different account? hack club auth keeps you logged in separately —
    <a href="${HC_AUTH_URL}" target="_blank" rel="noopener" style="color:#ec3750">log out there</a>
    first, then sign in above.
  </p>
</body>
</html>`;
}

// Sign out. The proxy is stateless — the docs session lives entirely in gitbook's
// own `gitbook-visitor-token` cookie — so signing out is a two-hop bounce:
//
//   1. we redirect to <site>/~gitbook/auth/logout, which deletes that cookie
//   2. gitbook redirects back to the logout URL configured on the site, which
//      should be this route with `?signed_out=1` (see README), and we serve the
//      login wall
//
// without the marker we'd re-enter step 1 forever, and going straight to the wall
// would leave the visitor still signed in to gitbook.
auth.get("/logout", (c) => {
  const location = c.req.query("location") || "";

  if (!c.req.query("signed_out")) {
    const url = new URL(
      `${env.GITBOOK_DOCS_URL.replace(/\/$/, "")}/~gitbook/auth/logout`,
    );
    if (location) url.searchParams.set("location", location);
    return c.redirect(url.toString());
  }

  return c.html(loginWall(location));
});

export default auth;
