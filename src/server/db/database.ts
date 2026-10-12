import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

/**
 * Versioned schema migrations. Append new entries; never edit an applied one.
 */
export const migrations: Array<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: "initial schema",
    sql: `
      CREATE TABLE repos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK (kind IN ('local', 'github')),
        label TEXT NOT NULL,
        local_path TEXT,
        github_owner TEXT,
        github_repo TEXT,
        product_context TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE credentials (
        name TEXT PRIMARY KEY,
        ciphertext TEXT NOT NULL,
        iv TEXT NOT NULL,
        tag TEXT NOT NULL,
        hint TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE voice_profile (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        profile_json TEXT NOT NULL,
        source TEXT NOT NULL,
        samples_count INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE generations (
        id TEXT PRIMARY KEY,
        repo_id INTEGER REFERENCES repos(id) ON DELETE SET NULL,
        mode TEXT NOT NULL,
        window_since TEXT NOT NULL,
        window_until TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX generations_repo_created ON generations (repo_id, created_at DESC);
      CREATE TABLE share_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
        repo_id INTEGER,
        platform TEXT NOT NULL,
        shared_day TEXT NOT NULL,
        shared_at TEXT NOT NULL,
        UNIQUE (generation_id, platform)
      );
      CREATE TABLE ai_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK (kind IN ('generation', 'voice')),
        reference_id TEXT,
        month TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX ai_runs_month ON ai_runs (month);
      CREATE TABLE usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reference_id TEXT,
        label TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        cost_usd REAL,
        month TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX usage_events_month ON usage_events (month);
    `,
  },
];

export function migrate(db: Db): number[] {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map(
      (row) => row.version,
    ),
  );
  const ran: number[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
      ran.push(migration.version);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return ran;
}

export function openDatabase(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
  return db;
}
