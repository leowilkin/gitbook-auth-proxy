import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./env.js";

// verify slack request signature (shared by slash commands, events, interactivity)
export function verifySlackSignature(
  signature: string,
  timestamp: string,
  body: string,
): boolean {
  // reject requests older than 5 minutes
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) return false;

  const baseString = `v0:${timestamp}:${body}`;
  const hmac = createHmac("sha256", env.SLACK_SIGNING_SECRET).update(baseString).digest("hex");
  const expected = `v0=${hmac}`;

  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// thin wrapper around the slack web api using the bot token
export async function slackApi<T = any>(method: string, body: unknown): Promise<T> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

// fetch all members of a slack channel (handles pagination)
export async function getChannelMembers(channelId: string): Promise<string[]> {
  const members: string[] = [];
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({ channel: channelId, limit: "200" });
    if (cursor) params.set("cursor", cursor);

    const res = await fetch(`https://slack.com/api/conversations.members?${params}`, {
      headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    });
    const data = (await res.json()) as {
      ok: boolean;
      members?: string[];
      response_metadata?: { next_cursor?: string };
      error?: string;
    };

    if (!data.ok) throw new Error(data.error || "failed to fetch channel members");

    members.push(...(data.members || []));
    cursor = data.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return members;
}

// extract slack user ID from mention like <@U12345|username> or raw ID
export function parseUserMention(text: string): string | null {
  const match = text.match(/<@(U[A-Z0-9]+)(?:\|[^>]*)?>/);
  if (match) return match[1];
  const rawMatch = text.match(/\b(U[A-Z0-9]{8,})\b/);
  return rawMatch ? rawMatch[1] : null;
}
