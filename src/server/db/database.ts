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
  {
    version: 2,
    name: "accounts: users, sessions and per-user data",
    sql: `
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        github_id INTEGER UNIQUE,
        login TEXT NOT NULL,
        name TEXT,
        avatar_url TEXT,
        email TEXT,
        plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro')),
        stripe_customer_id TEXT UNIQUE,
        stripe_subscription_id TEXT,
        plan_status TEXT,
        plan_renews_at TEXT,
        created_at TEXT NOT NULL,
        last_login_at TEXT
      );
      -- Existing single-user data belongs to the local user.
      INSERT INTO users (id, login, name, created_at)
        VALUES (1, 'local', '本地用户', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX sessions_user ON sessions (user_id);

      ALTER TABLE repos ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE generations ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE share_events ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE ai_runs ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE usage_events ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
      CREATE INDEX repos_user ON repos (user_id);
      CREATE INDEX generations_user_created ON generations (user_id, created_at DESC);
      CREATE INDEX ai_runs_user_month ON ai_runs (user_id, month);
      CREATE INDEX usage_events_user_month ON usage_events (user_id, month);

      CREATE TABLE credentials_v2 (
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        iv TEXT NOT NULL,
        tag TEXT NOT NULL,
        hint TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, name)
      );
      INSERT INTO credentials_v2 SELECT 1, name, ciphertext, iv, tag, hint, updated_at FROM credentials;
      DROP TABLE credentials;
      ALTER TABLE credentials_v2 RENAME TO credentials;

      CREATE TABLE voice_profiles (
        user_id INTEGER PRIMARY KEY,
        profile_json TEXT NOT NULL,
        source TEXT NOT NULL,
        samples_count INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO voice_profiles SELECT 1, profile_json, source, samples_count, updated_at FROM voice_profile;
      DROP TABLE voice_profile;
    `,
  },
  {
    version: 3,
    name: "billing: processed Stripe events",
    sql: `
      CREATE TABLE stripe_events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 4,
    name: "daily schedule and run log",
    sql: `
      CREATE TABLE schedules (
        user_id INTEGER PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        repo_id INTEGER,
        time_local TEXT NOT NULL DEFAULT '21:00',
        timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
        platforms_json TEXT NOT NULL DEFAULT '["jike","x","changelog"]',
        window_hours INTEGER NOT NULL DEFAULT 24,
        skip_empty INTEGER NOT NULL DEFAULT 1,
        notify_email TEXT,
        webhook_kind TEXT,
        last_run_day TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE schedule_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        trigger TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        generation_id TEXT,
        message TEXT,
        notified TEXT
      );
      CREATE INDEX schedule_runs_user ON schedule_runs (user_id, started_at DESC);
    `,
  },
  {
    version: 5,
    name: "post metrics",
    sql: `
      CREATE TABLE post_metrics (
        user_id INTEGER NOT NULL,
        generation_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        post_url TEXT,
        views INTEGER,
        likes INTEGER NOT NULL DEFAULT 0,
        comments INTEGER NOT NULL DEFAULT 0,
        reposts INTEGER NOT NULL DEFAULT 0,
        saves INTEGER NOT NULL DEFAULT 0,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (user_id, generation_id, platform)
      );
      CREATE INDEX post_metrics_recent ON post_metrics (user_id, recorded_at DESC);
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
