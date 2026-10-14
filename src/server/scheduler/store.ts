import {
  PlatformIdSchema,
  type PlatformId,
  type ScheduleRun,
  type ScheduleSettings,
  type WebhookKind,
} from "../../shared/schemas.js";
import type { Db } from "../db/database.js";

export const DEFAULT_SCHEDULE: Omit<ScheduleSettings, "webhookConfigured"> = {
  enabled: false,
  repoId: null,
  time: "21:00",
  timezone: "Asia/Shanghai",
  platforms: ["jike", "x", "changelog"],
  windowHours: 24,
  skipEmpty: true,
  notifyEmail: null,
  webhookKind: null,
};

export interface StoredSchedule extends Omit<ScheduleSettings, "webhookConfigured"> {
  userId: number;
  lastRunDay: string | null;
}

interface ScheduleRow {
  user_id: number;
  enabled: number;
  repo_id: number | null;
  time_local: string;
  timezone: string;
  platforms_json: string;
  window_hours: number;
  skip_empty: number;
  notify_email: string | null;
  webhook_kind: WebhookKind | null;
  last_run_day: string | null;
}

function parsePlatforms(json: string): PlatformId[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return DEFAULT_SCHEDULE.platforms;
    return parsed.filter((item): item is PlatformId => PlatformIdSchema.safeParse(item).success);
  } catch {
    return DEFAULT_SCHEDULE.platforms;
  }
}

function toSchedule(row: ScheduleRow): StoredSchedule {
  return {
    userId: row.user_id,
    enabled: row.enabled === 1,
    repoId: row.repo_id,
    time: row.time_local,
    timezone: row.timezone,
    platforms: parsePlatforms(row.platforms_json),
    windowHours: row.window_hours,
    skipEmpty: row.skip_empty === 1,
    notifyEmail: row.notify_email,
    webhookKind: row.webhook_kind,
    lastRunDay: row.last_run_day,
  };
}

interface RunRow {
  id: number;
  trigger: ScheduleRun["trigger"];
  started_at: string;
  finished_at: string | null;
  status: ScheduleRun["status"];
  generation_id: string | null;
  message: string | null;
  notified: string | null;
}

export class ScheduleStore {
  constructor(private readonly db: Db) {}

  get(userId: number): StoredSchedule {
    const row = this.db
      .prepare("SELECT * FROM schedules WHERE user_id = ?")
      .get(userId) as unknown as ScheduleRow | undefined;
    return row ? toSchedule(row) : { ...DEFAULT_SCHEDULE, userId, lastRunDay: null };
  }

  listEnabled(): StoredSchedule[] {
    const rows = this.db
      .prepare("SELECT * FROM schedules WHERE enabled = 1 AND repo_id IS NOT NULL")
      .all() as unknown as ScheduleRow[];
    return rows.map(toSchedule);
  }

  save(userId: number, settings: Omit<ScheduleSettings, "webhookConfigured">): StoredSchedule {
    this.db
      .prepare(
        `INSERT INTO schedules (user_id, enabled, repo_id, time_local, timezone, platforms_json, window_hours,
           skip_empty, notify_email, webhook_kind, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, repo_id = excluded.repo_id,
           time_local = excluded.time_local, timezone = excluded.timezone,
           platforms_json = excluded.platforms_json, window_hours = excluded.window_hours,
           skip_empty = excluded.skip_empty, notify_email = excluded.notify_email,
           webhook_kind = excluded.webhook_kind, updated_at = excluded.updated_at`,
      )
      .run(
        userId,
        settings.enabled ? 1 : 0,
        settings.repoId,
        settings.time,
        settings.timezone,
        JSON.stringify(settings.platforms),
        settings.windowHours,
        settings.skipEmpty ? 1 : 0,
        settings.notifyEmail,
        settings.webhookKind,
        new Date().toISOString(),
      );
    return this.get(userId);
  }

  /**
   * Claim today's run for a user. Returns false when it was already claimed, so two ticks
   * (or two server instances sharing the database) never run the same day twice.
   */
  claimDay(userId: number, day: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE schedules SET last_run_day = ?
         WHERE user_id = ? AND (last_run_day IS NULL OR last_run_day <> ?)`,
      )
      .run(day, userId, day);
    return result.changes > 0;
  }

  startRun(userId: number, trigger: ScheduleRun["trigger"], now = new Date()): number {
    const result = this.db
      .prepare(
        "INSERT INTO schedule_runs (user_id, trigger, started_at, status) VALUES (?, ?, ?, 'running')",
      )
      .run(userId, trigger, now.toISOString());
    return Number(result.lastInsertRowid);
  }

  finishRun(
    id: number,
    outcome: {
      status: Exclude<ScheduleRun["status"], "running">;
      generationId?: string | null;
      message?: string | null;
      notified?: string[];
    },
    now = new Date(),
  ): void {
    this.db
      .prepare(
        `UPDATE schedule_runs SET status = ?, generation_id = ?, message = ?, notified = ?, finished_at = ?
         WHERE id = ?`,
      )
      .run(
        outcome.status,
        outcome.generationId ?? null,
        outcome.message ?? null,
        (outcome.notified ?? []).join(","),
        now.toISOString(),
        id,
      );
  }

  runs(userId: number, limit = 10): ScheduleRun[] {
    const rows = this.db
      .prepare("SELECT * FROM schedule_runs WHERE user_id = ? ORDER BY id DESC LIMIT ?")
      .all(userId, limit) as unknown as RunRow[];
    return rows.map((row) => ({
      id: row.id,
      trigger: row.trigger,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      status: row.status,
      generationId: row.generation_id,
      message: row.message,
      notified: row.notified ? row.notified.split(",").filter(Boolean) : [],
    }));
  }
}
