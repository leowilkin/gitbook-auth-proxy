import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { env } from "./env.js";
import auth from "./auth.js";
import slack from "./slack.js";
import { isAdmin, addAdmin, adminCount } from "./db.js";

const app = new Hono();

// seed the first admin if configured and no admins exist
if (env.SEED_ADMIN_SLACK_ID && adminCount() === 0) {
  addAdmin(env.SEED_ADMIN_SLACK_ID, "seed");
  console.log(`seeded initial admin: ${env.SEED_ADMIN_SLACK_ID}`);
}

// health check
app.get("/health", (c) => c.json({ ok: true }));

// auth routes (gitbook ↔ hack club auth)
app.route("/", auth);

// slack slash command
app.route("/", slack);

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`gitbook-auth-proxy running on port ${info.port}`);
});
