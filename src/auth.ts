import { Hono } from "hono";
import * as jose from "jose";
import { env } from "./env.js";
import { isWhitelisted } from "./db.js";

const auth = new Hono();

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

  const me = (await meRes.json()) as { slack_id?: string; id?: string };
  const slackId = me.slack_id;

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
  const redirectUrl = location
    ? `${env.GITBOOK_DOCS_URL}/${location}?jwt_token=${gitbookJwt}`
    : `${env.GITBOOK_DOCS_URL}?jwt_token=${gitbookJwt}`;

  return c.redirect(redirectUrl);
});

export default auth;
