import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./env.js";
import {
  isAdmin,
  addAdmin,
  removeAdmin,
  addToWhitelist,
  removeFromWhitelist,
  listWhitelist,
  listAdmins,
  adminCount,
} from "./db.js";

const slack = new Hono();

// verify slack request signature
function verifySlackSignature(
  signingSecret: string,
  signature: string,
  timestamp: string,
  body: string,
): boolean {
  // reject requests older than 5 minutes
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) return false;

  const baseString = `v0:${timestamp}:${body}`;
  const hmac = createHmac("sha256", signingSecret).update(baseString).digest("hex");
  const expected = `v0=${hmac}`;

  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// extract slack user ID from mention like <@U12345|username> or raw ID
function parseUserMention(text: string): string | null {
  const match = text.match(/<@(U[A-Z0-9]+)(?:\|[^>]*)?>/);
  if (match) return match[1];
  // also accept raw slack IDs
  const rawMatch = text.match(/\b(U[A-Z0-9]{8,})\b/);
  return rawMatch ? rawMatch[1] : null;
}

slack.post("/slack/command", async (c) => {
  const rawBody = await c.req.text();
  const timestamp = c.req.header("x-slack-request-timestamp") || "";
  const signature = c.req.header("x-slack-signature") || "";

  if (!verifySlackSignature(env.SLACK_SIGNING_SECRET, signature, timestamp, rawBody)) {
    return c.json({ error: "invalid signature" }, 401);
  }

  const params = new URLSearchParams(rawBody);
  const userId = params.get("user_id") || "";
  const text = (params.get("text") || "").trim();

  // check if invoking user is an admin
  if (!isAdmin(userId)) {
    return c.json({
      response_type: "ephemeral",
      text: "you don't have admin access. ask an existing admin to run `/docs admin add @you`.",
    });
  }

  const parts = text.split(/\s+/);
  const group = parts[0]?.toLowerCase(); // "whitelist" or "admin"
  const action = parts[1]?.toLowerCase(); // "add", "remove", or "list"
  const rest = parts.slice(2).join(" ");

  // handle list commands
  if (group === "whitelist" && action === "list") {
    const list = listWhitelist();
    if (list.length === 0) {
      return c.json({ response_type: "ephemeral", text: "whitelist is empty." });
    }
    const formatted = list.map((id) => `• <@${id}>`).join("\n");
    return c.json({ response_type: "ephemeral", text: `*whitelisted users:*\n${formatted}` });
  }

  if (group === "admin" && action === "list") {
    const list = listAdmins();
    const formatted = list.map((id) => `• <@${id}>`).join("\n");
    return c.json({ response_type: "ephemeral", text: `*admins:*\n${formatted}` });
  }

  // for add/remove we need a target user
  if (!["whitelist", "admin"].includes(group) || !["add", "remove"].includes(action)) {
    return c.json({
      response_type: "ephemeral",
      text: [
        "*usage:*",
        "`/docs whitelist add @user` — grant access",
        "`/docs whitelist remove @user` — revoke access",
        "`/docs whitelist list` — show whitelisted users",
        "`/docs admin add @user` — grant admin",
        "`/docs admin remove @user` — revoke admin",
        "`/docs admin list` — show admins",
      ].join("\n"),
    });
  }

  const targetId = parseUserMention(rest);
  if (!targetId) {
    return c.json({
      response_type: "ephemeral",
      text: "couldn't find a user mention. use `/docs whitelist add @user`.",
    });
  }

  // whitelist commands
  if (group === "whitelist" && action === "add") {
    const ok = addToWhitelist(targetId, userId);
    return c.json({
      response_type: "ephemeral",
      text: ok ? `added <@${targetId}> to the whitelist.` : `<@${targetId}> is already whitelisted.`,
    });
  }

  if (group === "whitelist" && action === "remove") {
    const ok = removeFromWhitelist(targetId);
    return c.json({
      response_type: "ephemeral",
      text: ok ? `removed <@${targetId}> from the whitelist.` : `<@${targetId}> wasn't on the whitelist.`,
    });
  }

  // admin commands
  if (group === "admin" && action === "add") {
    const ok = addAdmin(targetId, userId);
    return c.json({
      response_type: "ephemeral",
      text: ok ? `granted admin to <@${targetId}>.` : `<@${targetId}> is already an admin.`,
    });
  }

  if (group === "admin" && action === "remove") {
    if (targetId === userId) {
      return c.json({
        response_type: "ephemeral",
        text: "you can't remove yourself as admin.",
      });
    }
    if (adminCount() <= 1) {
      return c.json({
        response_type: "ephemeral",
        text: "can't remove the last admin.",
      });
    }
    const ok = removeAdmin(targetId);
    return c.json({
      response_type: "ephemeral",
      text: ok ? `removed admin from <@${targetId}>.` : `<@${targetId}> wasn't an admin.`,
    });
  }

  return c.json({ response_type: "ephemeral", text: "unknown command." });
});

export default slack;
