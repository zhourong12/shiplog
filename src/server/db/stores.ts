import {
  VoiceProfileSchema,
  defaultVoiceProfile,
  type GenerationResult,
  type GenerationSummary,
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

export class RepoStore {
  constructor(private readonly db: Db) {}

  list(): RepoSummary[] {
    const rows = this.db
      .prepare(
        `SELECT r.*, (SELECT MAX(created_at) FROM generations g WHERE g.repo_id = r.id) AS last_generated_at
         FROM repos r ORDER BY r.id`,
      )
      .all() as unknown as RepoRow[];
    return rows.map(toRepo);
  }

  get(id: number): RepoSummary | null {
    const row = this.db
      .prepare(
        `SELECT r.*, (SELECT MAX(created_at) FROM generations g WHERE g.repo_id = r.id) AS last_generated_at
         FROM repos r WHERE r.id = ?`,
      )
      .get(id) as unknown as RepoRow | undefined;
    return row ? toRepo(row) : null;
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM repos").get() as { n: number }).n;
  }

  create(input: {
    kind: "local" | "github";
    label: string;
    localPath?: string | null;
    githubOwner?: string | null;
    githubRepo?: string | null;
    productContext?: string | null;
  }): RepoSummary {
    const result = this.db
      .prepare(
        `INSERT INTO repos (kind, label, local_path, github_owner, github_repo, product_context, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.kind,
        input.label,
        input.localPath ?? null,
        input.githubOwner ?? null,
        input.githubRepo ?? null,
        input.productContext ?? null,
        new Date().toISOString(),
      );
    return this.get(Number(result.lastInsertRowid))!;
  }

  updateProductContext(id: number, productContext: string | null): RepoSummary | null {
    this.db.prepare("UPDATE repos SET product_context = ? WHERE id = ?").run(productContext, id);
    return this.get(id);
  }

  delete(id: number): boolean {
    return this.db.prepare("DELETE FROM repos WHERE id = ?").run(id).changes > 0;
  }
}

export class GenerationStore {
  constructor(private readonly db: Db) {}

  save(result: GenerationResult): void {
    this.db
      .prepare(
        `INSERT INTO generations (id, repo_id, mode, window_since, window_until, result_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET result_json = excluded.result_json`,
      )
      .run(
        result.id,
        result.repoId,
        result.mode,
        result.window.since,
        result.window.until,
        JSON.stringify(result),
        result.createdAt,
      );
  }

  get(id: string): GenerationResult | null {
    const row = this.db.prepare("SELECT result_json FROM generations WHERE id = ?").get(id) as
      { result_json: string } | undefined;
    return row ? (JSON.parse(row.result_json) as GenerationResult) : null;
  }

  list(options: { repoId?: number; limit?: number } = {}): GenerationSummary[] {
    const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);
    const rows = (
      options.repoId === undefined
        ? this.db
            .prepare("SELECT id, result_json FROM generations ORDER BY created_at DESC LIMIT ?")
            .all(limit)
        : this.db
            .prepare(
              "SELECT id, result_json FROM generations WHERE repo_id = ? ORDER BY created_at DESC LIMIT ?",
            )
            .all(options.repoId, limit)
    ) as Array<{ id: string; result_json: string }>;
    const shared = this.sharedPlatformsFor(rows.map((row) => row.id));
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
    generationId: string,
    repoId: number | null,
    platform: PlatformId,
    day: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO share_events (generation_id, repo_id, platform, shared_day, shared_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(generation_id, platform) DO NOTHING`,
      )
      .run(generationId, repoId, platform, day, new Date().toISOString());
  }

  sharedPlatformsFor(ids: string[]): Map<string, PlatformId[]> {
    const map = new Map<string, PlatformId[]>();
    if (ids.length === 0) return map;
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT generation_id, platform FROM share_events WHERE generation_id IN (${placeholders})`,
      )
      .all(...ids) as Array<{ generation_id: string; platform: PlatformId }>;
    for (const row of rows)
      map.set(row.generation_id, [...(map.get(row.generation_id) ?? []), row.platform]);
    return map;
  }

  sharedDays(repoId: number | null): Set<string> {
    const rows = (
      repoId === null
        ? this.db.prepare("SELECT DISTINCT shared_day FROM share_events").all()
        : this.db
            .prepare("SELECT DISTINCT shared_day FROM share_events WHERE repo_id = ?")
            .all(repoId)
    ) as Array<{ shared_day: string }>;
    return new Set(rows.map((row) => row.shared_day));
  }
}

export class UsageStore {
  constructor(private readonly db: Db) {}

  recordRun(kind: "generation" | "voice", referenceId: string | null, now = new Date()): void {
    this.db
      .prepare("INSERT INTO ai_runs (kind, reference_id, month, created_at) VALUES (?, ?, ?, ?)")
      .run(kind, referenceId, monthOf(now), now.toISOString());
  }

  recordUsage(
    referenceId: string | null,
    usage: UsageSummary[],
    labels: string[],
    now = new Date(),
  ): void {
    const statement = this.db.prepare(
      `INSERT INTO usage_events (reference_id, label, model, input_tokens, output_tokens, cache_read_tokens,
         cache_write_tokens, cost_usd, month, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    usage.forEach((item, index) => {
      statement.run(
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

  runsInMonth(month: string): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS n FROM ai_runs WHERE month = ?").get(month) as {
        n: number;
      }
    ).n;
  }

  monthTotals(month: string): {
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
         FROM usage_events WHERE month = ?`,
      )
      .get(month) as {
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

  get(): VoiceState {
    const row = this.db
      .prepare(
        "SELECT profile_json, source, samples_count, updated_at FROM voice_profile WHERE id = 1",
      )
      .get() as
      | {
          profile_json: string;
          source: VoiceState["source"];
          samples_count: number;
          updated_at: string;
        }
      | undefined;
    if (!row)
      return { profile: defaultVoiceProfile, source: "default", samplesCount: 0, updatedAt: null };
    const parsed = VoiceProfileSchema.safeParse(JSON.parse(row.profile_json));
    return {
      profile: parsed.success ? parsed.data : defaultVoiceProfile,
      source: row.source,
      samplesCount: row.samples_count,
      updatedAt: row.updated_at,
    };
  }

  save(profile: VoiceProfile, source: "learned" | "manual", samplesCount: number): VoiceState {
    this.db
      .prepare(
        `INSERT INTO voice_profile (id, profile_json, source, samples_count, updated_at) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET profile_json = excluded.profile_json, source = excluded.source,
           samples_count = excluded.samples_count, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(profile), source, samplesCount, new Date().toISOString());
    return this.get();
  }
}
