import type {
  Draft,
  GenerationResult,
  InsightsReport,
  PlatformId,
  PostMetrics,
  PostMetricsInput,
  PostPerformance,
  StoryKind,
} from "../../shared/schemas.js";
import type { Db } from "../db/database.js";

/**
 * A deliberately simple weighted sum: comments and saves take more effort than a like, and a
 * repost carries the post to new readers. Raw scores differ wildly between platforms, so they
 * are only ever compared within one platform.
 */
export function engagementScore(
  metrics: Pick<PostMetrics, "likes" | "comments" | "reposts" | "saves">,
): number {
  return metrics.likes + 2 * metrics.comments + 3 * metrics.reposts + 2 * metrics.saves;
}

interface MetricsRow {
  generation_id: string;
  platform: PlatformId;
  post_url: string | null;
  views: number | null;
  likes: number;
  comments: number;
  reposts: number;
  saves: number;
  recorded_at: string;
}

function toMetrics(row: MetricsRow): PostMetrics {
  const metrics = {
    postUrl: row.post_url,
    views: row.views,
    likes: row.likes,
    comments: row.comments,
    reposts: row.reposts,
    saves: row.saves,
    recordedAt: row.recorded_at,
  };
  return { ...metrics, score: engagementScore(metrics) };
}

export interface StoredMetrics {
  generationId: string;
  platform: PlatformId;
  metrics: PostMetrics;
}

export class MetricsStore {
  constructor(private readonly db: Db) {}

  save(
    userId: number,
    generationId: string,
    platform: PlatformId,
    input: PostMetricsInput,
    now: Date,
  ): PostMetrics {
    this.db
      .prepare(
        `INSERT INTO post_metrics (user_id, generation_id, platform, post_url, views, likes, comments,
           reposts, saves, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, generation_id, platform) DO UPDATE SET post_url = excluded.post_url,
           views = excluded.views, likes = excluded.likes, comments = excluded.comments,
           reposts = excluded.reposts, saves = excluded.saves, recorded_at = excluded.recorded_at`,
      )
      .run(
        userId,
        generationId,
        platform,
        input.postUrl,
        input.views,
        input.likes,
        input.comments,
        input.reposts,
        input.saves,
        now.toISOString(),
      );
    return this.forGeneration(userId, generationId)[platform]!;
  }

  delete(userId: number, generationId: string, platform: PlatformId): void {
    this.db
      .prepare("DELETE FROM post_metrics WHERE user_id = ? AND generation_id = ? AND platform = ?")
      .run(userId, generationId, platform);
  }

  forGeneration(userId: number, generationId: string): Partial<Record<PlatformId, PostMetrics>> {
    const rows = this.db
      .prepare("SELECT * FROM post_metrics WHERE user_id = ? AND generation_id = ?")
      .all(userId, generationId) as unknown as MetricsRow[];
    return Object.fromEntries(rows.map((row) => [row.platform, toMetrics(row)]));
  }

  recent(userId: number, limit = 200): StoredMetrics[] {
    const rows = this.db
      .prepare("SELECT * FROM post_metrics WHERE user_id = ? ORDER BY recorded_at DESC LIMIT ?")
      .all(userId, limit) as unknown as MetricsRow[];
    return rows.map((row) => ({
      generationId: row.generation_id,
      platform: row.platform,
      metrics: toMetrics(row),
    }));
  }

  /** Posts the author marked as shared but has not reported numbers for. */
  pendingShares(
    userId: number,
    limit = 5,
  ): Array<{ generationId: string; platform: PlatformId; sharedDay: string }> {
    const rows = this.db
      .prepare(
        `SELECT s.generation_id, s.platform, s.shared_day FROM share_events s
         LEFT JOIN post_metrics m
           ON m.user_id = s.user_id AND m.generation_id = s.generation_id AND m.platform = s.platform
         WHERE s.user_id = ? AND m.generation_id IS NULL
         ORDER BY s.shared_at DESC LIMIT ?`,
      )
      .all(userId, limit) as Array<{
      generation_id: string;
      platform: PlatformId;
      shared_day: string;
    }>;
    return rows.map((row) => ({
      generationId: row.generation_id,
      platform: row.platform,
      sharedDay: row.shared_day,
    }));
  }
}

export interface TrackedPost {
  result: GenerationResult;
  draft: Draft;
  metrics: PostMetrics;
}

/** The story kinds a draft draws on: stories whose facts it cites, else the day's shareable ones. */
export function draftKinds(result: GenerationResult, draft: Draft): StoryKind[] {
  const cited = result.stories.filter((story) =>
    story.facts.some((fact) => draft.factIds.includes(fact.id)),
  );
  const stories =
    cited.length > 0
      ? cited
      : result.stories.filter(
          (story) => story.shareability === "high" || story.shareability === "medium",
        );
  return [...new Set(stories.map((story) => story.kind))];
}

function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Score each post against the author's own average on the same platform. */
export function buildPerformances(posts: TrackedPost[]): PostPerformance[] {
  const byPlatform = new Map<PlatformId, number[]>();
  for (const post of posts) {
    byPlatform.set(post.draft.platform, [
      ...(byPlatform.get(post.draft.platform) ?? []),
      post.metrics.score,
    ]);
  }
  return posts.map(({ result, draft, metrics }) => {
    const scores = byPlatform.get(draft.platform) ?? [];
    const average = scores.reduce((sum, score) => sum + score, 0) / (scores.length || 1);
    return {
      generationId: result.id,
      repoLabel: result.repoLabel,
      platform: draft.platform,
      createdAt: result.createdAt,
      headline: result.dayHeadline ?? result.repoLabel,
      excerpt: excerpt(draft.title ?? draft.body, 120),
      kinds: draftKinds(result, draft),
      metrics,
      lift: scores.length >= 2 && average > 0 ? round(metrics.score / average) : null,
    };
  });
}

/** Kinds that clearly beat the author's averages, worth leaning into when writing. */
export function favoredKinds(performances: PostPerformance[]): StoryKind[] {
  return kindStats(performances)
    .filter((item) => item.posts >= 2 && item.avgLift >= 1.2)
    .map((item) => item.kind);
}

function kindStats(performances: PostPerformance[]): InsightsReport["kinds"] {
  const stats = new Map<StoryKind, { posts: number; lift: number }>();
  for (const performance of performances) {
    if (performance.lift === null) continue;
    for (const kind of performance.kinds) {
      const entry = stats.get(kind) ?? { posts: 0, lift: 0 };
      stats.set(kind, { posts: entry.posts + 1, lift: entry.lift + performance.lift });
    }
  }
  return [...stats.entries()]
    .map(([kind, entry]) => ({
      kind,
      posts: entry.posts,
      avgLift: round(entry.lift / entry.posts),
    }))
    .sort((a, b) => b.avgLift - a.avgLift || b.posts - a.posts);
}

export interface Exemplar {
  platform: PlatformId;
  title: string | null;
  body: string;
  metrics: PostMetrics;
}

/** The author's best posts on each requested platform, for the writer to learn from. */
export function pickExemplars(
  posts: TrackedPost[],
  platforms: PlatformId[],
  perPlatform = 2,
): Exemplar[] {
  return platforms.flatMap((platform) =>
    posts
      .filter((post) => post.draft.platform === platform && post.metrics.score > 0)
      .sort((a, b) => b.metrics.score - a.metrics.score)
      .slice(0, perPlatform)
      .map((post) => ({
        platform,
        title: post.draft.title,
        body: post.draft.body.length > 600 ? `${post.draft.body.slice(0, 600)}…` : post.draft.body,
        metrics: post.metrics,
      })),
  );
}

export function buildInsights(input: {
  posts: TrackedPost[];
  pending: InsightsReport["pending"];
  allowed: boolean;
}): InsightsReport {
  const performances = buildPerformances(input.posts);
  const totals = { views: 0, likes: 0, comments: 0, reposts: 0, saves: 0 };
  const platforms = new Map<PlatformId, { posts: number; total: number; best: number }>();
  for (const { draft, metrics } of input.posts) {
    totals.views += metrics.views ?? 0;
    totals.likes += metrics.likes;
    totals.comments += metrics.comments;
    totals.reposts += metrics.reposts;
    totals.saves += metrics.saves;
    const entry = platforms.get(draft.platform) ?? { posts: 0, total: 0, best: 0 };
    platforms.set(draft.platform, {
      posts: entry.posts + 1,
      total: entry.total + metrics.score,
      best: Math.max(entry.best, metrics.score),
    });
  }
  const allPlatforms = [...platforms.keys()];
  return {
    tracked: input.posts.length,
    totals,
    platforms: [...platforms.entries()]
      .map(([platform, entry]) => ({
        platform,
        posts: entry.posts,
        avgScore: round(entry.total / entry.posts),
        bestScore: entry.best,
      }))
      .sort((a, b) => b.posts - a.posts || b.avgScore - a.avgScore),
    kinds: kindStats(performances),
    // Posts at or above their platform's average; a lone post on a platform counts as par.
    top: performances
      .filter((item) => item.metrics.score > 0 && (item.lift === null || item.lift >= 1))
      .sort((a, b) => (b.lift ?? 1) - (a.lift ?? 1) || b.metrics.score - a.metrics.score)
      .slice(0, 5),
    pending: input.pending,
    learning: {
      allowed: input.allowed,
      exemplars: input.allowed ? pickExemplars(input.posts, allPlatforms).length : 0,
    },
  };
}
