import { Hono } from "hono";
import {
  verifySlackSignature,
  getChannelMembers,
  parseUserMention,
} from "./slackUtil.js";
import {
  isAdmin,
  addAdmin,
  removeAdmin,
  addToWhitelist,
  removeFromWhitelist,
  listWhitelist,
  listAdmins,
  adminCount,
  normalizeGroupName,
  addToGroup,
  removeFromGroup,
  listGroupMembers,
  listGroups,
} from "./db.js";

const slack = new Hono();

slack.post("/slack/command", async (c) => {
  const rawBody = await c.req.text();
  const timestamp = c.req.header("x-slack-request-timestamp") || "";
  const signature = c.req.header("x-slack-signature") || "";

  if (!verifySlackSignature(signature, timestamp, rawBody)) {
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

  // group membership powers gitbook adaptive content. syntax differs from
  // whitelist/admin because it carries an extra <name> token:
  //   /docs group add <name> @user | channel
  //   /docs group remove <name> @user | channel
  //   /docs group list            — all groups + member counts
  //   /docs group list <name>     — members of a group
  if (group === "group") {
    const rawName = parts[2] || "";
    const groupTarget = parts.slice(3).join(" ").trim();

    if (action === "list") {
      if (!rawName) {
        const groups = listGroups();
        if (groups.length === 0) {
          return c.json({ response_type: "ephemeral", text: "no groups defined yet." });
        }
        const formatted = groups
          .map((g) => `• \`${g.group_name}\` — ${g.count} member${g.count === 1 ? "" : "s"}`)
          .join("\n");
        return c.json({ response_type: "ephemeral", text: `*groups:*\n${formatted}` });
      }
      const name = normalizeGroupName(rawName);
      const members = listGroupMembers(name);
      if (members.length === 0) {
        return c.json({ response_type: "ephemeral", text: `group \`${name}\` is empty.` });
      }
      const formatted = members.map((id) => `• <@${id}>`).join("\n");
      return c.json({
        response_type: "ephemeral",
        text: `*members of \`${name}\`:*\n${formatted}`,
      });
    }

    if ((action === "add" || action === "remove") && rawName) {
      const name = normalizeGroupName(rawName);

      // sync a whole channel into / out of the group
      if (groupTarget.toLowerCase() === "channel") {
        const channelId = params.get("channel_id");
        if (!channelId) {
          return c.json({ response_type: "ephemeral", text: "couldn't determine the channel." });
        }
        try {
          const members = await getChannelMembers(channelId);
          let count = 0;
          for (const memberId of members) {
            if (action === "add") {
              if (addToGroup(memberId, name, userId)) count++;
            } else {
              if (removeFromGroup(memberId, name)) count++;
            }
          }
          const verb = action === "add" ? "added" : "removed";
          return c.json({
            response_type: "ephemeral",
            text: `${verb} ${count} user${count === 1 ? "" : "s"} (out of ${members.length} in this channel) ${action === "add" ? "to" : "from"} group \`${name}\`.`,
          });
        } catch (err) {
          console.error("failed to fetch channel members:", err);
          return c.json({
            response_type: "ephemeral",
            text: "failed to fetch channel members. make sure the bot is in this channel.",
          });
        }
      }

      const memberId = parseUserMention(groupTarget);
      if (!memberId) {
        return c.json({
          response_type: "ephemeral",
          text: "couldn't find a user mention. use `/docs group add <name> @user`.",
        });
      }
      if (action === "add") {
        const ok = addToGroup(memberId, name, userId);
        return c.json({
          response_type: "ephemeral",
          text: ok
            ? `added <@${memberId}> to group \`${name}\`.`
            : `<@${memberId}> is already in group \`${name}\`.`,
        });
      }
      const ok = removeFromGroup(memberId, name);
      return c.json({
        response_type: "ephemeral",
        text: ok
          ? `removed <@${memberId}> from group \`${name}\`.`
          : `<@${memberId}> wasn't in group \`${name}\`.`,
      });
    }

    return c.json({
      response_type: "ephemeral",
      text: [
        "*group usage:*",
        "`/docs group add <name> @user` — add user to a group",
        "`/docs group add <name> channel` — add everyone in this channel",
        "`/docs group remove <name> @user` — remove user from a group",
        "`/docs group remove <name> channel` — remove everyone in this channel",
        "`/docs group list` — show all groups",
        "`/docs group list <name>` — show members of a group",
      ].join("\n"),
    });
  }

  // for add/remove we need a target user
  if (!["whitelist", "admin"].includes(group) || !["add", "remove"].includes(action)) {
    return c.json({
      response_type: "ephemeral",
      text: [
        "*usage:*",
        "`/docs whitelist add @user` — grant access",
        "`/docs whitelist add channel` — whitelist everyone in this channel",
        "`/docs whitelist remove @user` — revoke access",
        "`/docs whitelist remove channel` — remove everyone in this channel",
        "`/docs whitelist list` — show whitelisted users",
        "`/docs admin add @user` — grant admin",
        "`/docs admin remove @user` — revoke admin",
        "`/docs admin list` — show admins",
        "`/docs group add <name> @user` — add to an adaptive-content group",
        "`/docs group add <name> channel` — add this channel to a group",
        "`/docs group list` — show groups",
      ].join("\n"),
    });
  }

  // handle "whitelist add/remove channel"
  if (group === "whitelist" && rest.trim().toLowerCase() === "channel") {
    const channelId = params.get("channel_id");
    if (!channelId) {
      return c.json({ response_type: "ephemeral", text: "couldn't determine the channel." });
    }

    try {
      const members = await getChannelMembers(channelId);
      let count = 0;
      for (const memberId of members) {
        if (action === "add") {
          if (addToWhitelist(memberId, userId)) count++;
        } else {
          if (removeFromWhitelist(memberId)) count++;
        }
      }
      const verb = action === "add" ? "added" : "removed";
      return c.json({
        response_type: "ephemeral",
        text: `${verb} ${count} user${count === 1 ? "" : "s"} (out of ${members.length} in this channel) ${action === "add" ? "to" : "from"} the whitelist.`,
      });
    } catch (err) {
      console.error("failed to fetch channel members:", err);
      return c.json({
        response_type: "ephemeral",
        text: "failed to fetch channel members. make sure the bot is in this channel.",
      });
    }
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
