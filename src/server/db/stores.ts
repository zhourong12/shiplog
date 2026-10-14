import { createHash, randomBytes } from "node:crypto";
import {
  VoiceProfileSchema,
  defaultVoiceProfile,
  type GenerationResult,
  type GenerationSummary,
  type Plan,
  type PlatformId,
  type RepoSummary,
  type UsageSummary,
  type VoiceProfile,
  type VoiceState,
} from "../../shared/schemas.js";
import type { Db } from "./database.js";

export function monthOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/** The id of the implicit user that owns everything in single-user (local) mode. */
export const LOCAL_USER_ID = 1;

export interface UserRecord {
  id: number;
  githubId: number | null;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  email: string | null;
  plan: Plan;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  planStatus: string | null;
  planRenewsAt: string | null;
  createdAt: string;
}

interface UserRow {
  id: number;
  github_id: number | null;
  login: string;
  name: string | null;
  avatar_url: string | null;
  email: string | null;
  plan: Plan;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  plan_status: string | null;
  plan_renews_at: string | null;
  created_at: string;
}

function toUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    githubId: row.github_id,
    login: row.login,
    name: row.name,
    avatarUrl: row.avatar_url,
    email: row.email,
    plan: row.plan,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    planStatus: row.plan_status,
    planRenewsAt: row.plan_renews_at,
    createdAt: row.created_at,
  };
}

export class UserStore {
  constructor(private readonly db: Db) {}

  get(id: number): UserRecord | null {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as unknown as
      UserRow | undefined;
    return row ? toUser(row) : null;
  }

  byStripeCustomer(customerId: string): UserRecord | null {
    const row = this.db
      .prepare("SELECT * FROM users WHERE stripe_customer_id = ?")
      .get(customerId) as unknown as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  upsertGithubUser(profile: {
    githubId: number;
    login: string;
    name: string | null;
    avatarUrl: string | null;
    email: string | null;
  }): UserRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO users (github_id, login, name, avatar_url, email, created_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(github_id) DO UPDATE SET login = excluded.login, name = excluded.name,
           avatar_url = excluded.avatar_url, email = COALESCE(excluded.email, users.email),
           last_login_at = excluded.last_login_at`,
      )
      .run(
        profile.githubId,
        profile.login,
        profile.name,
        profile.avatarUrl,
        profile.email,
        now,
        now,
      );
    const row = this.db
      .prepare("SELECT * FROM users WHERE github_id = ?")
      .get(profile.githubId) as unknown as UserRow;
    return toUser(row);
  }

  setStripeCustomer(userId: number, customerId: string): void {
    this.db.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?").run(customerId, userId);
  }

  setPlan(
    userId: number,
    update: {
      plan: Plan;
      subscriptionId: string | null;
      status: string | null;
      renewsAt: string | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE users SET plan = ?, stripe_subscription_id = ?, plan_status = ?, plan_renews_at = ?
         WHERE id = ?`,
      )
      .run(update.plan, update.subscriptionId, update.status, update.renewsAt, userId);
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Server-side sessions. Only a hash of the cookie value is stored. */
export class SessionStore {
  constructor(private readonly db: Db) {}

  create(userId: number, ttlMs: number, now = new Date()): { token: string; expiresAt: Date } {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + ttlMs);
    this.db
      .prepare(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
      )
      .run(hashToken(token), userId, now.toISOString(), expiresAt.toISOString());
    return { token, expiresAt };
  }

  userIdFor(token: string, now = new Date()): number | null {
    const row = this.db
      .prepare("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?")
      .get(hashToken(token)) as { user_id: number; expires_at: string } | undefined;
    if (!row) return null;
    if (row.expires_at <= now.toISOString()) {
      this.delete(token);
      return null;
    }
    return row.user_id;
  }

  delete(token: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
  }

  purgeExpired(now = new Date()): void {
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now.toISOString());
  }
}

interface RepoRow {
  id: number;
  kind: "local" | "github";
  label: string;
  local_path: string | null;
  github_owner: string | null;
  github_repo: string | null;
  product_context: string | null;
  created_at: string;
  last_generated_at: string | null;
}

function toRepo(row: RepoRow): RepoSummary {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    localPath: row.local_path,
    githubOwner: row.github_owner,
    githubRepo: row.github_repo,
    productContext: row.product_context,
    createdAt: row.created_at,
    lastGeneratedAt: row.last_generated_at,
  };
}

const repoSelect = `SELECT r.*, (SELECT MAX(created_at) FROM generations g WHERE g.repo_id = r.id) AS last_generated_at
  FROM repos r`;

/** Every query is scoped by user id; a row of another user is indistinguishable from none. */
export class RepoStore {
  constructor(private readonly db: Db) {}

  list(userId: number): RepoSummary[] {
    const rows = this.db
      .prepare(`${repoSelect} WHERE r.user_id = ? ORDER BY r.id`)
      .all(userId) as unknown as RepoRow[];
    return rows.map(toRepo);
  }

  get(userId: number, id: number): RepoSummary | null {
    const row = this.db
      .prepare(`${repoSelect} WHERE r.user_id = ? AND r.id = ?`)
      .get(userId, id) as unknown as RepoRow | undefined;
    return row ? toRepo(row) : null;
  }

  count(userId: number): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS n FROM repos WHERE user_id = ?").get(userId) as {
        n: number;
      }
    ).n;
  }

  create(
    userId: number,
    input: {
      kind: "local" | "github";
      label: string;
      localPath?: string | null;
      githubOwner?: string | null;
      githubRepo?: string | null;
      productContext?: string | null;
    },
  ): RepoSummary {
    const result = this.db
      .prepare(
        `INSERT INTO repos (user_id, kind, label, local_path, github_owner, github_repo, product_context, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        userId,
        input.kind,
        input.label,
        input.localPath ?? null,
        input.githubOwner ?? null,
        input.githubRepo ?? null,
        input.productContext ?? null,
        new Date().toISOString(),
      );
    return this.get(userId, Number(result.lastInsertRowid))!;
  }

  updateProductContext(
    userId: number,
    id: number,
    productContext: string | null,
  ): RepoSummary | null {
    this.db
      .prepare("UPDATE repos SET product_context = ? WHERE user_id = ? AND id = ?")
      .run(productContext, userId, id);
    return this.get(userId, id);
  }

  delete(userId: number, id: number): boolean {
    return (
      this.db.prepare("DELETE FROM repos WHERE user_id = ? AND id = ?").run(userId, id).changes > 0
    );
  }
}

export class GenerationStore {
  constructor(private readonly db: Db) {}

  save(userId: number, result: GenerationResult): void {
    this.db
      .prepare(
        `INSERT INTO generations (id, user_id, repo_id, mode, window_since, window_until, result_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET result_json = excluded.result_json WHERE generations.user_id = excluded.user_id`,
      )
      .run(
        result.id,
        userId,
        result.repoId,
        result.mode,
        result.window.since,
        result.window.until,
        JSON.stringify(result),
        result.createdAt,
      );
  }

  get(userId: number, id: string): GenerationResult | null {
    const row = this.db
      .prepare("SELECT result_json FROM generations WHERE user_id = ? AND id = ?")
      .get(userId, id) as { result_json: string } | undefined;
    return row ? (JSON.parse(row.result_json) as GenerationResult) : null;
  }

  list(userId: number, options: { repoId?: number; limit?: number } = {}): GenerationSummary[] {
    const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);
    const rows = (
      options.repoId === undefined
        ? this.db
            .prepare(
              "SELECT id, result_json FROM generations WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
            )
            .all(userId, limit)
        : this.db
            .prepare(
              "SELECT id, result_json FROM generations WHERE user_id = ? AND repo_id = ? ORDER BY created_at DESC LIMIT ?",
            )
            .all(userId, options.repoId, limit)
    ) as Array<{ id: string; result_json: string }>;
    const shared = this.sharedPlatformsFor(
      userId,
      rows.map((row) => row.id),
    );
    return rows.map((row) => {
      const result = JSON.parse(row.result_json) as GenerationResult;
      return {
        id: result.id,
        repoId: result.repoId,
        repoLabel: result.repoLabel,
        createdAt: result.createdAt,
        mode: result.mode,
        window: result.window,
        commits: result.totals.commits,
        dayHeadline: result.dayHeadline,
        sharedPlatforms: shared.get(result.id) ?? [],
      };
    });
  }

  recordShare(
    userId: number,
    generationId: string,
    repoId: number | null,
    platform: PlatformId,
    day: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO share_events (user_id, generation_id, repo_id, platform, shared_day, shared_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(generation_id, platform) DO NOTHING`,
      )
      .run(userId, generationId, repoId, platform, day, new Date().toISOString());
  }

  sharedPlatformsFor(userId: number, ids: string[]): Map<string, PlatformId[]> {
    const map = new Map<string, PlatformId[]>();
    if (ids.length === 0) return map;
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT generation_id, platform FROM share_events
         WHERE user_id = ? AND generation_id IN (${placeholders})`,
      )
      .all(userId, ...ids) as Array<{ generation_id: string; platform: PlatformId }>;
    for (const row of rows) {
      map.set(row.generation_id, [...(map.get(row.generation_id) ?? []), row.platform]);
    }
    return map;
  }

  sharedDays(userId: number, repoId: number | null): Set<string> {
    const rows = (
      repoId === null
        ? this.db
            .prepare("SELECT DISTINCT shared_day FROM share_events WHERE user_id = ?")
            .all(userId)
        : this.db
            .prepare(
              "SELECT DISTINCT shared_day FROM share_events WHERE user_id = ? AND repo_id = ?",
            )
            .all(userId, repoId)
    ) as Array<{ shared_day: string }>;
    return new Set(rows.map((row) => row.shared_day));
  }
}

export class UsageStore {
  constructor(private readonly db: Db) {}

  recordRun(
    userId: number,
    kind: "generation" | "voice",
    referenceId: string | null,
    now = new Date(),
  ): void {
    this.db
      .prepare(
        "INSERT INTO ai_runs (user_id, kind, reference_id, month, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(userId, kind, referenceId, monthOf(now), now.toISOString());
  }

  recordUsage(
    userId: number,
    referenceId: string | null,
    usage: UsageSummary[],
    labels: string[],
    now = new Date(),
  ): void {
    const statement = this.db.prepare(
      `INSERT INTO usage_events (user_id, reference_id, label, model, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, cost_usd, month, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    usage.forEach((item, index) => {
      statement.run(
        userId,
        referenceId,
        labels[index] ?? "ai",
        item.model,
        item.inputTokens,
        item.outputTokens,
        item.cacheReadTokens,
        item.cacheWriteTokens,
        item.costUsd,
        monthOf(now),
        now.toISOString(),
      );
    });
  }

  runsInMonth(userId: number, month: string): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM ai_runs WHERE user_id = ? AND month = ?")
        .get(userId, month) as { n: number }
    ).n;
  }

  monthTotals(
    userId: number,
    month: string,
  ): {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    unpricedCalls: number;
  } {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(input_tokens + cache_read_tokens + cache_write_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cost_usd), 0) AS cost_usd,
                COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END), 0) AS unpriced
         FROM usage_events WHERE user_id = ? AND month = ?`,
      )
      .get(userId, month) as {
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
      unpriced: number;
    };
    return {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      costUsd: Math.round(row.cost_usd * 10000) / 10000,
      unpricedCalls: row.unpriced,
    };
  }
}

export class VoiceStore {
  constructor(private readonly db: Db) {}

  get(userId: number): VoiceState {
    const row = this.db
      .prepare(
        "SELECT profile_json, source, samples_count, updated_at FROM voice_profiles WHERE user_id = ?",
      )
      .get(userId) as
      | {
          profile_json: string;
          source: VoiceState["source"];
          samples_count: number;
          updated_at: string;
        }
      | undefined;
    if (!row) {
      return { profile: defaultVoiceProfile, source: "default", samplesCount: 0, updatedAt: null };
    }
    const parsed = VoiceProfileSchema.safeParse(JSON.parse(row.profile_json));
    return {
      profile: parsed.success ? parsed.data : defaultVoiceProfile,
      source: row.source,
      samplesCount: row.samples_count,
      updatedAt: row.updated_at,
    };
  }

  save(
    userId: number,
    profile: VoiceProfile,
    source: "learned" | "manual",
    samplesCount: number,
  ): VoiceState {
    this.db
      .prepare(
        `INSERT INTO voice_profiles (user_id, profile_json, source, samples_count, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET profile_json = excluded.profile_json, source = excluded.source,
           samples_count = excluded.samples_count, updated_at = excluded.updated_at`,
      )
      .run(userId, JSON.stringify(profile), source, samplesCount, new Date().toISOString());
    return this.get(userId);
  }
}
