import { Hono } from "hono";
import { verifySlackSignature, slackApi } from "./slackUtil.js";
import {
  isAdmin,
  addAdmin,
  removeAdmin,
  adminCount,
  addToWhitelist,
  removeFromWhitelist,
  listWhitelist,
  listAdmins,
  addToGroup,
  removeFromGroup,
  listGroups,
  getGroupNames,
  createGroup,
  renameGroup,
  deleteGroup,
  setGroupDescription,
  normalizeGroupName,
} from "./db.js";

const home = new Hono();

// ---------------------------------------------------------------------------
// app home view
// ---------------------------------------------------------------------------

// build the App Home view for a given viewer. management buttons only render
// for admins; everyone else gets a read-only summary.
function buildHomeView(viewerId: string) {
  const admin = isAdmin(viewerId);
  const whitelist = listWhitelist();
  const admins = listAdmins();
  const groups = listGroups();

  const blocks: any[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "📚 GitBook Access Manager" },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: admin
            ? "you're an *admin* — manage who can access the docs below."
            : "you have read-only access. ask an admin to make changes.",
        },
      ],
    },
    { type: "divider" },
  ];

  // whitelist
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*Whitelist* — ${whitelist.length} user${whitelist.length === 1 ? "" : "s"} can access the site`,
    },
  });
  if (admin) {
    blocks.push({
      type: "actions",
      elements: [
        button("Add user", "wl_add", "primary"),
        button("Remove user", "wl_remove", "danger"),
      ],
    });
  }

  // admins
  blocks.push({ type: "divider" });
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*Admins*\n${admins.length ? admins.map((id) => `• <@${id}>`).join("\n") : "_none_"}`,
    },
  });
  if (admin) {
    blocks.push({
      type: "actions",
      elements: [
        button("Add admin", "admin_add", "primary"),
        button("Remove admin", "admin_remove", "danger"),
      ],
    });
  }

  // groups (adaptive content)
  blocks.push({ type: "divider" });
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text:
        "*Groups* — control per-section visibility (gitbook adaptive content)\n" +
        (groups.length
          ? groups
              .map((g) => {
                const desc = g.description ? ` — _${g.description}_` : "";
                return `• \`${g.group_name}\`${desc} · ${g.count} member${g.count === 1 ? "" : "s"}`;
              })
              .join("\n")
          : "_no groups yet — create one to get started_"),
    },
  });
  if (admin) {
    blocks.push({
      type: "actions",
      elements: [
        button("New group", "group_new", "primary"),
        button("Edit group", "group_edit"),
        button("Delete group", "group_delete", "danger"),
      ],
    });
    if (groups.length) {
      blocks.push({
        type: "actions",
        elements: [
          button("Add member", "group_add", "primary"),
          button("Remove member", "group_remove", "danger"),
        ],
      });
    }
  }

  return { type: "home", blocks };
}

function button(text: string, action_id: string, style?: "primary" | "danger") {
  const el: any = {
    type: "button",
    text: { type: "plain_text", text },
    action_id,
  };
  if (style) el.style = style;
  return el;
}

// publish the home tab for a user (best-effort)
async function publishHome(userId: string) {
  const res = await slackApi("views.publish", {
    user_id: userId,
    view: buildHomeView(userId),
  });
  if (!(res as any).ok) {
    console.error("views.publish failed:", (res as any).error);
  }
}

// ---------------------------------------------------------------------------
// modals
// ---------------------------------------------------------------------------

// a modal with a single user picker. callback_id routes the submission.
function userPickerModal(callbackId: string, title: string, label: string) {
  return {
    type: "modal",
    callback_id: callbackId,
    title: { type: "plain_text", text: title },
    submit: { type: "plain_text", text: "Save" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "user",
        label: { type: "plain_text", text: label },
        element: { type: "users_select", action_id: "user" },
      },
    ],
  };
}

// a dropdown of existing groups (slack rejects selects with no options, so
// callers must guard against the empty case).
function groupSelect(blockId: string, label: string) {
  return {
    type: "input",
    block_id: blockId,
    label: { type: "plain_text", text: label },
    element: {
      type: "static_select",
      action_id: blockId,
      placeholder: { type: "plain_text", text: "Pick a group" },
      options: getGroupNames().map((name) => ({
        text: { type: "plain_text", text: name },
        value: name,
      })),
    },
  };
}

const NAME_HINT = "lowercase letters, numbers, underscores — e.g. fulltime";

// create a brand-new (empty) group.
function newGroupModal() {
  return {
    type: "modal",
    callback_id: "group_new",
    title: { type: "plain_text", text: "New group" },
    submit: { type: "plain_text", text: "Create" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "name",
        label: { type: "plain_text", text: "Group name" },
        hint: { type: "plain_text", text: NAME_HINT },
        element: {
          type: "plain_text_input",
          action_id: "name",
          placeholder: { type: "plain_text", text: "fulltime" },
        },
      },
      {
        type: "input",
        block_id: "description",
        optional: true,
        label: { type: "plain_text", text: "Description" },
        element: {
          type: "plain_text_input",
          action_id: "description",
          placeholder: { type: "plain_text", text: "full-time HQ staff" },
        },
      },
    ],
  };
}

// rename a group and/or change its description.
function editGroupModal() {
  return {
    type: "modal",
    callback_id: "group_edit",
    title: { type: "plain_text", text: "Edit group" },
    submit: { type: "plain_text", text: "Save" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      groupSelect("group", "Group to edit"),
      {
        type: "input",
        block_id: "name",
        optional: true,
        label: { type: "plain_text", text: "New name" },
        hint: {
          type: "plain_text",
          text: "renaming changes the gitbook claim key — update your visibility conditions to match.",
        },
        element: {
          type: "plain_text_input",
          action_id: "name",
          placeholder: { type: "plain_text", text: "leave blank to keep current name" },
        },
      },
      {
        type: "input",
        block_id: "description",
        optional: true,
        label: { type: "plain_text", text: "New description" },
        element: {
          type: "plain_text_input",
          action_id: "description",
          placeholder: { type: "plain_text", text: "leave blank to keep current description" },
        },
      },
    ],
  };
}

function deleteGroupModal() {
  return {
    type: "modal",
    callback_id: "group_delete",
    title: { type: "plain_text", text: "Delete group" },
    submit: { type: "plain_text", text: "Delete" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: "this removes the group and all its membership. it can't be undone." },
      },
      groupSelect("group", "Group to delete"),
    ],
  };
}

// add/remove a user to/from an existing group (group chosen from a dropdown).
function groupMemberModal(callbackId: string, title: string, verb: string) {
  return {
    type: "modal",
    callback_id: callbackId,
    title: { type: "plain_text", text: title },
    submit: { type: "plain_text", text: "Save" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "user",
        label: { type: "plain_text", text: `User to ${verb}` },
        element: { type: "users_select", action_id: "user" },
      },
      groupSelect("group", "Group"),
    ],
  };
}

const MODALS: Record<string, () => any> = {
  wl_add: () => userPickerModal("wl_add", "Add to whitelist", "User to grant access"),
  wl_remove: () => userPickerModal("wl_remove", "Remove from whitelist", "User to revoke"),
  admin_add: () => userPickerModal("admin_add", "Add admin", "User to make admin"),
  admin_remove: () => userPickerModal("admin_remove", "Remove admin", "Admin to remove"),
  group_new: () => newGroupModal(),
  group_edit: () => editGroupModal(),
  group_delete: () => deleteGroupModal(),
  group_add: () => groupMemberModal("group_add", "Add to group", "add"),
  group_remove: () => groupMemberModal("group_remove", "Remove from group", "remove"),
};

// ---------------------------------------------------------------------------
// events api — render the home tab when opened
// ---------------------------------------------------------------------------

home.post("/slack/events", async (c) => {
  const rawBody = await c.req.text();
  const timestamp = c.req.header("x-slack-request-timestamp") || "";
  const signature = c.req.header("x-slack-signature") || "";

  if (!verifySlackSignature(signature, timestamp, rawBody)) {
    return c.json({ error: "invalid signature" }, 401);
  }

  const payload = JSON.parse(rawBody);

  // slack url verification handshake
  if (payload.type === "url_verification") {
    return c.json({ challenge: payload.challenge });
  }

  if (payload.type === "event_callback" && payload.event?.type === "app_home_opened") {
    // render asynchronously; ack immediately so slack doesn't retry
    publishHome(payload.event.user).catch((e) => console.error("publishHome error:", e));
  }

  return c.body(null, 200);
});

// ---------------------------------------------------------------------------
// interactivity — button clicks (open modals) and modal submissions (mutate)
// ---------------------------------------------------------------------------

home.post("/slack/interactivity", async (c) => {
  const rawBody = await c.req.text();
  const timestamp = c.req.header("x-slack-request-timestamp") || "";
  const signature = c.req.header("x-slack-signature") || "";

  if (!verifySlackSignature(signature, timestamp, rawBody)) {
    return c.json({ error: "invalid signature" }, 401);
  }

  // interactivity payloads arrive url-encoded as payload=<json>
  const params = new URLSearchParams(rawBody);
  const payload = JSON.parse(params.get("payload") || "{}");
  const viewerId: string = payload.user?.id || "";

  // every action here is admin-only
  if (!isAdmin(viewerId)) {
    if (payload.type === "view_submission") {
      return c.json({
        response_action: "errors",
        errors: { user: "you don't have admin access." },
      });
    }
    return c.body(null, 200);
  }

  // button click → open the matching modal
  if (payload.type === "block_actions") {
    const actionId = payload.actions?.[0]?.action_id;
    const make = actionId && MODALS[actionId];
    if (make && payload.trigger_id) {
      const res = await slackApi("views.open", {
        trigger_id: payload.trigger_id,
        view: make(),
      });
      if (!(res as any).ok) console.error("views.open failed:", (res as any).error);
    }
    return c.body(null, 200);
  }

  // modal submission → mutate, then refresh the home tab
  if (payload.type === "view_submission") {
    const callbackId: string = payload.view?.callback_id;
    const values = payload.view?.state?.values || {};
    const targetId: string | undefined = values.user?.user?.selected_user;
    const selectedGroup: string | undefined = values.group?.group?.selected_option?.value;

    const err = (block: string, msg: string) =>
      c.json({ response_action: "errors", errors: { [block]: msg } });

    switch (callbackId) {
      case "wl_add":
        if (!targetId) return err("user", "pick a user.");
        addToWhitelist(targetId, viewerId);
        break;
      case "wl_remove":
        if (!targetId) return err("user", "pick a user.");
        removeFromWhitelist(targetId);
        break;
      case "admin_add":
        if (!targetId) return err("user", "pick a user.");
        addAdmin(targetId, viewerId);
        break;
      case "admin_remove":
        if (!targetId) return err("user", "pick a user.");
        if (targetId === viewerId) return err("user", "you can't remove yourself.");
        if (adminCount() <= 1) return err("user", "can't remove the last admin.");
        removeAdmin(targetId);
        break;
      case "group_new": {
        const name = normalizeGroupName(values.name?.name?.value || "");
        if (!name) return err("name", "enter a group name.");
        const desc = values.description?.description?.value || "";
        if (!createGroup(name, desc, viewerId)) {
          return err("name", `group \`${name}\` already exists.`);
        }
        break;
      }
      case "group_edit": {
        if (!selectedGroup) return err("group", "pick a group.");
        const newNameRaw = values.name?.name?.value || "";
        const newDesc = values.description?.description?.value;
        if (newNameRaw.trim()) {
          const newName = normalizeGroupName(newNameRaw);
          if (newName !== selectedGroup && !renameGroup(selectedGroup, newName)) {
            return err("name", `group \`${newName}\` already exists.`);
          }
          if (newDesc) setGroupDescription(newName, newDesc);
        } else if (newDesc) {
          setGroupDescription(selectedGroup, newDesc);
        }
        break;
      }
      case "group_delete":
        if (!selectedGroup) return err("group", "pick a group.");
        deleteGroup(selectedGroup);
        break;
      case "group_add":
        if (!targetId) return err("user", "pick a user.");
        if (!selectedGroup) return err("group", "pick a group.");
        addToGroup(targetId, selectedGroup, viewerId);
        break;
      case "group_remove":
        if (!targetId) return err("user", "pick a user.");
        if (!selectedGroup) return err("group", "pick a group.");
        removeFromGroup(targetId, selectedGroup);
        break;
      default:
        return c.body(null, 200);
    }

    // refresh the home tab to reflect the change
    publishHome(viewerId).catch((e) => console.error("publishHome error:", e));
    return c.json({ response_action: "clear" });
  }

  return c.body(null, 200);
});

export default home;
