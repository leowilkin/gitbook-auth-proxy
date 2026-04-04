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

export function removeFromWhitelist(slackId: string): boolean {
  const result = db.prepare("DELETE FROM whitelist WHERE slack_id = ?").run(slackId);
  return result.changes > 0;
}

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

export function adminCount(): number {
  const row = db.prepare("SELECT COUNT(*) as count FROM admins").get() as { count: number };
  return row.count;
}

export default db;
