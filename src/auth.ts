import { Hono } from "hono";
import * as jose from "jose";
import { env } from "./env.js";
import { isWhitelisted } from "./db.js";

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
    base = new URL(
      location ? `${env.GITBOOK_DOCS_URL}/${location}` : env.GITBOOK_DOCS_URL,
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

  // sign gitbook JWT
  const gitbookJwt = await new jose.SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(new TextEncoder().encode(env.GITBOOK_SIGNING_KEY));

  // redirect back to gitbook with the JWT
  return c.redirect(buildGitbookRedirect(location, gitbookJwt));
});

export default auth;
