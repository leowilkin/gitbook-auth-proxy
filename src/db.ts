import Database from "better-sqlite3";
import path from "node:path";

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "data", "auth.db");

// ensure data dir exists
import { mkdirSync } from "node:fs";
mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS whitelist (
    slack_id TEXT PRIMARY KEY,
    added_by TEXT NOT NULL,
    added_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS admins (
    slack_id TEXT PRIMARY KEY,
    added_by TEXT NOT NULL,
    added_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- groups power gitbook adaptive content. a group is a first-class entity so
  -- it can exist with zero members, be renamed, and carry a description.
  CREATE TABLE IF NOT EXISTS groups (
    name TEXT PRIMARY KEY,
    description TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- membership: each (slack_id, group) row becomes a boolean claim
  -- (group -> true) in the signed jwt, read by gitbook as visitor.claims.<group>.
  CREATE TABLE IF NOT EXISTS group_members (
    slack_id TEXT NOT NULL,
    group_name TEXT NOT NULL,
    added_by TEXT NOT NULL,
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (slack_id, group_name)
  );
`);

// backfill the groups table from any pre-existing implicit groups so old data
// (created before groups were first-class) shows up in the UI.
db.exec(`
  INSERT OR IGNORE INTO groups (name, created_by)
  SELECT DISTINCT group_name, 'backfill' FROM group_members;
`);

export function isWhitelisted(slackId: string): boolean {
  const row = db.prepare("SELECT 1 FROM whitelist WHERE slack_id = ?").get(slackId);
  return !!row;
}

export function addToWhitelist(slackId: string, addedBy: string): boolean {
  try {
    db.prepare("INSERT INTO whitelist (slack_id, added_by) VALUES (?, ?)").run(slackId, addedBy);
    return true;
  } catch {
    return false; // already exists
  }
}

// revoking site access also strips all group memberships — a user who can't
// reach the site shouldn't keep adaptive-content claims hanging around.
export const removeFromWhitelist = db.transaction((slackId: string): boolean => {
  db.prepare("DELETE FROM group_members WHERE slack_id = ?").run(slackId);
  const result = db.prepare("DELETE FROM whitelist WHERE slack_id = ?").run(slackId);
  return result.changes > 0;
}) as (slackId: string) => boolean;

export function isAdmin(slackId: string): boolean {
  const row = db.prepare("SELECT 1 FROM admins WHERE slack_id = ?").get(slackId);
  return !!row;
}

export function addAdmin(slackId: string, addedBy: string): boolean {
  try {
    db.prepare("INSERT INTO admins (slack_id, added_by) VALUES (?, ?)").run(slackId, addedBy);
    return true;
  } catch {
    return false;
  }
}

export function removeAdmin(slackId: string): boolean {
  const result = db.prepare("DELETE FROM admins WHERE slack_id = ?").run(slackId);
  return result.changes > 0;
}

export function listWhitelist(): string[] {
  const rows = db.prepare("SELECT slack_id FROM whitelist").all() as { slack_id: string }[];
  return rows.map((r) => r.slack_id);
}

export function listAdmins(): string[] {
  const rows = db.prepare("SELECT slack_id FROM admins").all() as { slack_id: string }[];
  return rows.map((r) => r.slack_id);
}

// group names become jwt claim keys, so keep them claim-safe.
export function normalizeGroupName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

// create an empty group. returns false if it already exists.
export function createGroup(name: string, description: string, createdBy: string): boolean {
  try {
    db.prepare(
      "INSERT INTO groups (name, description, created_by) VALUES (?, ?, ?)",
    ).run(name, description, createdBy);
    return true;
  } catch {
    return false; // already exists
  }
}

export function groupExists(name: string): boolean {
  return !!db.prepare("SELECT 1 FROM groups WHERE name = ?").get(name);
}

// rename a group, cascading to its members. the group name is the gitbook
// claim key, so callers should warn that visibility conditions must be updated.
// returns false if the new name is already taken.
export const renameGroup = db.transaction((oldName: string, newName: string): boolean => {
  if (groupExists(newName)) return false;
  db.prepare("UPDATE groups SET name = ? WHERE name = ?").run(newName, oldName);
  db.prepare("UPDATE group_members SET group_name = ? WHERE group_name = ?").run(newName, oldName);
  return true;
}) as (oldName: string, newName: string) => boolean;

export function setGroupDescription(name: string, description: string): void {
  db.prepare("UPDATE groups SET description = ? WHERE name = ?").run(description, name);
}

// delete a group and all its membership rows.
export const deleteGroup = db.transaction((name: string): boolean => {
  db.prepare("DELETE FROM group_members WHERE group_name = ?").run(name);
  const result = db.prepare("DELETE FROM groups WHERE name = ?").run(name);
  return result.changes > 0;
}) as (name: string) => boolean;

export function getGroupNames(): string[] {
  const rows = db.prepare("SELECT name FROM groups ORDER BY name").all() as { name: string }[];
  return rows.map((r) => r.name);
}

export function addToGroup(slackId: string, groupName: string, addedBy: string): boolean {
  // ensure the group exists so membership added via slash command still works.
  createGroup(groupName, "", addedBy);
  // group membership implies site access — a user can't see adaptive content
  // for a section they can't reach. whitelist them too (no-op if already on it).
  addToWhitelist(slackId, addedBy);
  try {
    db.prepare(
      "INSERT INTO group_members (slack_id, group_name, added_by) VALUES (?, ?, ?)",
    ).run(slackId, groupName, addedBy);
    return true;
  } catch {
    return false; // already a member
  }
}

export function removeFromGroup(slackId: string, groupName: string): boolean {
  const result = db
    .prepare("DELETE FROM group_members WHERE slack_id = ? AND group_name = ?")
    .run(slackId, groupName);
  return result.changes > 0;
}

// all groups a user belongs to — used to build their adaptive-content claims.
export function getGroupsForUser(slackId: string): string[] {
  const rows = db
    .prepare("SELECT group_name FROM group_members WHERE slack_id = ?")
    .all(slackId) as { group_name: string }[];
  return rows.map((r) => r.group_name);
}

export function listGroupMembers(groupName: string): string[] {
  const rows = db
    .prepare("SELECT slack_id FROM group_members WHERE group_name = ?")
    .all(groupName) as { slack_id: string }[];
  return rows.map((r) => r.slack_id);
}

// all groups (including empty ones) with description and member count.
export function listGroups(): { group_name: string; description: string; count: number }[] {
  return db
    .prepare(
      `SELECT g.name AS group_name, g.description AS description,
              COUNT(m.slack_id) AS count
       FROM groups g
       LEFT JOIN group_members m ON m.group_name = g.name
       GROUP BY g.name
       ORDER BY g.name`,
    )
    .all() as { group_name: string; description: string; count: number }[];
}

export function adminCount(): number {
  const row = db.prepare("SELECT COUNT(*) as count FROM admins").get() as { count: number };
  return row.count;
}

export default db;
