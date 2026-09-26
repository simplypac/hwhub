// SQLite via Node's built-in driver (Node 22.13+). One file, no server to run.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const MIGRATIONS = [
  `CREATE TABLE users (
     id TEXT PRIMARY KEY,
     email TEXT NOT NULL UNIQUE COLLATE NOCASE,
     name TEXT NOT NULL DEFAULT '',
     pass_hash TEXT NOT NULL,
     tz TEXT NOT NULL DEFAULT 'Europe/Istanbul',
     inbound_token TEXT NOT NULL UNIQUE,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     ua TEXT
   );
   CREATE INDEX sessions_user ON sessions(user_id);
   CREATE TABLE api_tokens (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     token_hash TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     last_used INTEGER
   );
   CREATE TABLE connections (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     kind TEXT NOT NULL,
     secret_enc TEXT,
     meta TEXT NOT NULL DEFAULT '{}',
     status TEXT NOT NULL DEFAULT 'active',
     last_sync INTEGER,
     next_sync INTEGER,
     last_error TEXT,
     failures INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     UNIQUE(user_id, kind)
   );
   CREATE TABLE assignments (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     title TEXT NOT NULL,
     subject TEXT NOT NULL DEFAULT '',
     due TEXT,
     all_day INTEGER NOT NULL DEFAULT 0,
     source TEXT NOT NULL DEFAULT 'Other',
     rank INTEGER NOT NULL DEFAULT 0,
     kind TEXT,
     reqs TEXT NOT NULL DEFAULT '[]',
     notes TEXT NOT NULL DEFAULT '',
     link TEXT,
     done INTEGER NOT NULL DEFAULT 0,
     removed INTEGER NOT NULL DEFAULT 0,
     user_edited TEXT NOT NULL DEFAULT '[]',
     confidence TEXT NOT NULL DEFAULT 'high',
     last_change TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX assignments_user ON assignments(user_id, removed);
   CREATE TABLE assignment_refs (
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     ref TEXT NOT NULL,
     assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
     seen_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, ref)
   );
   CREATE INDEX refs_assignment ON assignment_refs(assignment_id);
   CREATE TABLE ingest_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     channel TEXT NOT NULL,
     ext_id TEXT NOT NULL,
     received_at INTEGER NOT NULL,
     status TEXT NOT NULL,
     summary TEXT NOT NULL DEFAULT '',
     UNIQUE(user_id, channel, ext_id)
   );
   CREATE INDEX ingest_user ON ingest_log(user_id, received_at);`,
];

export function openDb(file) {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const { user_version: v } = db.prepare("PRAGMA user_version").get();
  for (let i = v; i < MIGRATIONS.length; i++) {
    db.exec("BEGIN");
    try { db.exec(MIGRATIONS[i]); db.exec(`PRAGMA user_version = ${i + 1}`); db.exec("COMMIT"); }
    catch (e) { db.exec("ROLLBACK"); throw e; }
  }
  return db;
}

export function tx(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const r = fn(); db.exec("COMMIT"); return r; }
  catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
}

const J = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };

// Shape sent to the app.
export function assignmentOut(row) {
  return {
    id: row.id, title: row.title, subject: row.subject, due: row.due, allDay: !!row.all_day,
    source: row.source, kind: row.kind, reqs: J(row.reqs, []), notes: row.notes, link: row.link,
    done: !!row.done, confidence: row.confidence, lastChange: J(row.last_change, null),
    userEdited: J(row.user_edited, []), created: row.created_at, updated: row.updated_at,
  };
}
export const parseJSON = J;
