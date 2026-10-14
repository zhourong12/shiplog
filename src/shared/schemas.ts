import { z } from "zod";

/** Platforms ShipLog writes drafts for. Order is the default display order. */
export const platformIds = [
  "jike",
  "xiaohongshu",
  "x",
  "v2ex",
  "changelog",
  "producthunt",
] as const;
export const PlatformIdSchema = z.enum(platformIds);
export type PlatformId = z.infer<typeof PlatformIdSchema>;

export const storyKinds = [
  "feature",
  "fix",
  "perf",
  "refactor",
  "docs",
  "test",
  "chore",
  "infra",
] as const;
export const StoryKindSchema = z.enum(storyKinds);
export type StoryKind = z.infer<typeof StoryKindSchema>;

export const shareabilityLevels = ["high", "medium", "low", "skip"] as const;
export const ShareabilitySchema = z.enum(shareabilityLevels);
export type Shareability = z.infer<typeof ShareabilitySchema>;

export interface CommitFile {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
  /** Set when the file is excluded from the AI payload (lockfile, secret file, build output…). */
  excludedReason: ExcludedReason | null;
}

export type ExcludedReason = "lockfile" | "secret_file" | "binary" | "generated" | "vendor";

export interface CommitRecord {
  sha: string;
  shortSha: string;
  authorName: string;
  authoredAt: string;
  subject: string;
  body: string;
  files: CommitFile[];
  /** Filtered, redacted and truncated unified diff. Empty when unavailable. */
  patch: string;
  prNumber: number | null;
  url: string | null;
}

export interface TagRecord {
  name: string;
  createdAt: string;
}

export interface CollectionWindow {
  since: string;
  until: string;
}

export interface CollectionTotals {
  commits: number;
  additions: number;
  deletions: number;
  filesChanged: number;
}

export interface Collection {
  repoLabel: string;
  source: "local" | "github";
  window: CollectionWindow;
  commits: CommitRecord[];
  tags: TagRecord[];
  totals: CollectionTotals;
  /** True when the window had more commits than the collection cap. */
  truncated: boolean;
  /** True when some diffs were cut to fit the size budget (commit list is complete). */
  diffTruncated: boolean;
  excludedFileCount: number;
  redactionCount: number;
  /** Lifetime commit count of the default branch, when the source can tell. */
  lifetimeCommits: number | null;
  firstCommitAt: string | null;
}

export interface FactClaim {
  id: string;
  text: string;
  sourceShas: string[];
}

export interface ChangeStory {
  id: string;
  title: string;
  kind: StoryKind;
  userFacing: boolean;
  shareability: Shareability;
  summary: string;
  angle: string;
  commitShas: string[];
  facts: FactClaim[];
}

export type GuardIssueCode =
  | "too_long"
  | "title_too_long"
  | "title_missing"
  | "too_many_parts"
  | "too_many_hashtags"
  | "unsupported_number"
  | "misquoted_code"
  | "secret_detected"
  | "unknown_fact"
  | "no_facts"
  | "empty";

export interface GuardIssue {
  code: GuardIssueCode;
  severity: "error" | "warning";
  message: string;
}

export interface Draft {
  platform: PlatformId;
  title: string | null;
  body: string;
  hashtags: string[];
  factIds: string[];
  issues: GuardIssue[];
  status: "ok" | "needs_review";
  edited: boolean;
}

export const VoiceProfileSchema = z.object({
  language: z.enum(["zh", "en", "mixed"]),
  tone: z.string(),
  sentenceStyle: z.string(),
  emojiUsage: z.enum(["none", "light", "heavy"]),
  catchphrases: z.array(z.string()),
  dos: z.array(z.string()),
  donts: z.array(z.string()),
});
export type VoiceProfile = z.infer<typeof VoiceProfileSchema>;

export const defaultVoiceProfile: VoiceProfile = {
  language: "zh",
  tone: "真诚、具体、略带自嘲的独立开发者口吻",
  sentenceStyle: "短句为主，先说结果再说过程",
  emojiUsage: "light",
  catchphrases: [],
  dos: ["讲清楚这次改动对用户意味着什么", "保留一个真实的小细节或踩坑"],
  donts: ["不夸大效果", "不编造数据", "不使用营销腔"],
};

export interface Milestone {
  kind: "lifetime_commits" | "first_release" | "release" | "project_birthday";
  label: string;
  value: string;
}

export interface UsageSummary {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
}

export interface GenerationResult {
  id: string;
  repoId: number | null;
  repoLabel: string;
  createdAt: string;
  mode: "ai" | "baseline";
  /** Why AI was not used, in business language. Null in AI mode. */
  baselineReason: string | null;
  window: CollectionWindow;
  totals: CollectionTotals;
  truncated: boolean;
  excludedFileCount: number;
  redactionCount: number;
  milestones: Milestone[];
  dayHeadline: string | null;
  stories: ChangeStory[];
  drafts: Draft[];
  changelog: string;
  commits: Array<
    Pick<CommitRecord, "sha" | "shortSha" | "subject" | "authoredAt" | "prNumber" | "url"> & {
      snippet: CodeSnippet | null;
    }
  >;
  breakdown: {
    topFiles: Array<{ path: string; lines: number }>;
    languages: Array<{ language: string; lines: number }>;
  };
  /** Last 14 days of commit activity at generation time, oldest first. */
  recentActivity: ActivityDay[];
  commitStreak: number;
  /** Numbers drafts may cite; kept so edited drafts can be re-checked later. */
  claimNumbers: string[];
  usage: UsageSummary[];
}

export interface CodeSnippet {
  path: string;
  lines: Array<{ kind: "add" | "del" | "ctx"; text: string }>;
}

export interface ActivityDay {
  day: string;
  commits: number;
  shared: boolean;
}

export type Plan = "free" | "pro";

export interface PlanLimits {
  maxRepos: number | null;
  aiRunsPerMonth: number | null;
  voiceLearning: boolean;
}

export interface UsageReport {
  plan: Plan;
  limits: PlanLimits;
  month: string;
  aiRuns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  unpricedCalls: number;
}

export interface RepoSummary {
  id: number;
  kind: "local" | "github";
  label: string;
  localPath: string | null;
  githubOwner: string | null;
  githubRepo: string | null;
  productContext: string | null;
  createdAt: string;
  lastGeneratedAt: string | null;
}

export interface GenerationSummary {
  id: string;
  repoId: number | null;
  repoLabel: string;
  createdAt: string;
  mode: "ai" | "baseline";
  window: CollectionWindow;
  commits: number;
  dayHeadline: string | null;
  sharedPlatforms: PlatformId[];
}

export interface HealthReport {
  ok: true;
  version: string;
  ai: { configured: boolean; model: string | null };
  plan: Plan;
  authRequired: boolean;
  localReposEnabled: boolean;
}

export interface ActivityReport {
  days: ActivityDay[];
  commitStreak: number;
  longestCommitStreak: number;
  shareStreak: number;
}

export interface PreviewReport {
  totals: CollectionTotals;
  commits: Array<Pick<CommitRecord, "sha" | "shortSha" | "subject" | "authoredAt">>;
  milestones: Milestone[];
  changelog: string;
  aiPayload: string;
  redactionCount: number;
  excludedFileCount: number;
  truncated: boolean;
}

export interface VoiceState {
  profile: VoiceProfile;
  source: "default" | "learned" | "manual";
  samplesCount: number;
  updatedAt: string | null;
}
