import { basename } from "node:path";
import type {
  ActivityReport,
  Collection,
  CollectionWindow,
  Draft,
  GenerationResult,
  PlatformId,
  PreviewReport,
  RepoSummary,
  UsageReport,
  VoiceState,
} from "../../shared/schemas.js";
import { AiError, type StructuredLlm } from "../ai/llm.js";
import { buildUnderstandPrompt } from "../ai/prompts.js";
import { learnVoice, splitSamples } from "../ai/voice.js";
import { buildBaselineChangelog } from "../baseline/changelog.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/database.js";
import { CredentialStore, resolveEncryptionKey } from "../db/secrets.js";
import { GenerationStore, RepoStore, UsageStore, VoiceStore, monthOf } from "../db/stores.js";
import { guardDraft } from "../guards/index.js";
import { buildActivity, currentStreak, detectMilestones, longestStreak } from "../insights.js";
import { runPipeline } from "../pipeline.js";
import { finalizeCollection, SourceError } from "../sources/collect.js";
import {
  checkGithubRepo,
  collectGithub,
  githubCommitDays,
  githubNamePattern,
} from "../sources/github.js";
import {
  collectLocalGit,
  isPathAllowed,
  localCommitDays,
  resolveRepoRoot,
} from "../sources/localGit.js";
import { HttpError } from "./errors.js";
import { planLimits } from "./plans.js";

const GITHUB_TOKEN = "github_token";

export interface ServiceDeps {
  db: Db;
  config: AppConfig;
  /** Returns null when AI is not configured. */
  llmFactory: () => StructuredLlm | null;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export class ShipLogService {
  readonly repos: RepoStore;
  readonly generations: GenerationStore;
  readonly usage: UsageStore;
  readonly voice: VoiceStore;
  readonly credentials: CredentialStore;
  private readonly now: () => Date;

  constructor(private readonly deps: ServiceDeps) {
    this.repos = new RepoStore(deps.db);
    this.generations = new GenerationStore(deps.db);
    this.usage = new UsageStore(deps.db);
    this.voice = new VoiceStore(deps.db);
    this.credentials = new CredentialStore(deps.db, () =>
      resolveEncryptionKey(process.env, deps.config.keyFilePath),
    );
    this.now = deps.now ?? (() => new Date());
  }

  get limits() {
    return planLimits[this.deps.config.plan];
  }

  private githubToken(): string | null {
    try {
      return this.credentials.get(GITHUB_TOKEN);
    } catch {
      throw new HttpError(
        500,
        "credential_unreadable",
        "无法解密已保存的 GitHub 令牌，请重新保存。",
      );
    }
  }

  requireRepo(id: number): RepoSummary {
    const repo = this.repos.get(id);
    if (!repo) throw new HttpError(404, "repo_not_found", "找不到这个仓库。");
    return repo;
  }

  async addLocalRepo(localPath: string, productContext: string | null): Promise<RepoSummary> {
    this.assertRepoQuota();
    if (this.deps.config.localRoots.length === 0) {
      throw new HttpError(403, "local_disabled", "当前部署未开启本地仓库，请改用 GitHub 仓库。");
    }
    if (!isPathAllowed(localPath, this.deps.config.localRoots)) {
      throw new HttpError(
        403,
        "path_not_allowed",
        "该目录不在允许读取的范围内（SHIPLOG_LOCAL_ROOTS）。",
      );
    }
    const root = await resolveRepoRoot(localPath);
    if (!isPathAllowed(root, this.deps.config.localRoots)) {
      throw new HttpError(403, "path_not_allowed", "该仓库根目录不在允许读取的范围内。");
    }
    return this.repos.create({
      kind: "local",
      label: basename(root),
      localPath: root,
      productContext,
    });
  }

  async addGithubRepo(
    owner: string,
    repo: string,
    productContext: string | null,
  ): Promise<RepoSummary> {
    this.assertRepoQuota();
    if (!githubNamePattern.test(owner) || !githubNamePattern.test(repo)) {
      throw new HttpError(400, "invalid_repo", "仓库名称格式不正确，应为 owner/repo。");
    }
    const fullName = await checkGithubRepo({
      owner,
      repo,
      token: this.githubToken(),
      baseUrl: this.deps.config.githubApiBaseUrl,
      fetchImpl: this.deps.fetchImpl,
    });
    return this.repos.create({
      kind: "github",
      label: fullName,
      githubOwner: owner,
      githubRepo: repo,
      productContext,
    });
  }

  private assertRepoQuota(): void {
    const max = this.limits.maxRepos;
    if (max !== null && this.repos.count() >= max) {
      throw new HttpError(
        403,
        "plan_required",
        `免费版最多连接 ${max} 个仓库，升级 Pro 可连接更多。`,
      );
    }
  }

  async collect(repo: RepoSummary, window: CollectionWindow): Promise<Collection> {
    if (repo.kind === "local") {
      if (!repo.localPath || !isPathAllowed(repo.localPath, this.deps.config.localRoots)) {
        throw new HttpError(403, "path_not_allowed", "该仓库目录已不在允许读取的范围内。");
      }
      return finalizeCollection(await collectLocalGit({ repoPath: repo.localPath, window }));
    }
    return finalizeCollection(
      await collectGithub({
        owner: repo.githubOwner ?? "",
        repo: repo.githubRepo ?? "",
        token: this.githubToken(),
        window,
        baseUrl: this.deps.config.githubApiBaseUrl,
        fetchImpl: this.deps.fetchImpl,
      }),
    );
  }

  private async commitDays(repo: RepoSummary, since: string): Promise<Record<string, number>> {
    if (repo.kind === "local") return localCommitDays(repo.localPath ?? "", since);
    return githubCommitDays({
      owner: repo.githubOwner ?? "",
      repo: repo.githubRepo ?? "",
      token: this.githubToken(),
      since,
      baseUrl: this.deps.config.githubApiBaseUrl,
      fetchImpl: this.deps.fetchImpl,
    });
  }

  async activity(repoId: number, today: string, days = 84): Promise<ActivityReport> {
    const repo = this.requireRepo(repoId);
    const since = new Date(`${today}T00:00:00Z`);
    since.setUTCDate(since.getUTCDate() - (days + 1));
    const commitDays = await this.commitDays(repo, since.toISOString());
    const sharedDays = this.generations.sharedDays(repoId);
    return {
      days: buildActivity(commitDays, sharedDays, today, days),
      commitStreak: currentStreak(Object.keys(commitDays), today),
      longestCommitStreak: longestStreak(Object.keys(commitDays)),
      shareStreak: currentStreak(sharedDays, today),
    };
  }

  async preview(repoId: number, window: CollectionWindow): Promise<PreviewReport> {
    const repo = this.requireRepo(repoId);
    const collection = await this.collect(repo, window);
    const milestones = detectMilestones(collection);
    return {
      totals: collection.totals,
      commits: collection.commits.map(({ sha, shortSha, subject, authoredAt }) => ({
        sha,
        shortSha,
        subject,
        authoredAt,
      })),
      milestones,
      changelog: buildBaselineChangelog(collection),
      aiPayload: buildUnderstandPrompt(
        collection,
        milestones,
        repo.productContext,
        this.voice.get().profile.language,
      ),
      redactionCount: collection.redactionCount,
      excludedFileCount: collection.excludedFileCount,
      truncated: collection.truncated,
    };
  }

  async generate(
    repoId: number,
    window: CollectionWindow,
    platforms: PlatformId[],
    today: string,
  ): Promise<GenerationResult> {
    const repo = this.requireRepo(repoId);
    const collection = await this.collect(repo, window);
    const activity = await this.activity(repoId, today, 14).catch(() => null);

    let llm = this.deps.llmFactory();
    let baselineReason: string | undefined;
    const month = monthOf(this.now());
    const runLimit = this.limits.aiRunsPerMonth;
    if (llm && runLimit !== null && this.usage.runsInMonth(month) >= runLimit) {
      llm = null;
      baselineReason = `本月 ${runLimit} 次 AI 生成额度已用完，已生成更新日志和数据卡；升级 Pro 可继续使用 AI。`;
    }

    const result = await runPipeline({
      collection,
      platforms,
      voice: this.voice.get().profile,
      productContext: repo.productContext,
      llm,
      baselineReason,
      repoId,
      activity: activity
        ? { recent: activity.days, commitStreak: activity.commitStreak }
        : undefined,
      now: this.now(),
    });
    this.generations.save(result);
    // Quota counts runs that actually spent tokens, not configuration errors.
    if (result.usage.length > 0) this.usage.recordRun("generation", result.id, this.now());
    if (result.usage.length > 0) {
      const labels = ["understand", "write", "repair"];
      this.usage.recordUsage(result.id, result.usage, labels, this.now());
    }
    return result;
  }

  getGeneration(id: string): GenerationResult {
    const result = this.generations.get(id);
    if (!result) throw new HttpError(404, "generation_not_found", "找不到这次生成记录。");
    return result;
  }

  /** Save a hand edit and re-run the same deterministic checks against the stored evidence. */
  editDraft(
    id: string,
    platform: PlatformId,
    patch: { title: string | null; body: string; hashtags: string[] },
  ): Draft {
    const result = this.getGeneration(id);
    const index = result.drafts.findIndex((draft) => draft.platform === platform);
    if (index === -1) throw new HttpError(404, "draft_not_found", "这次生成没有该平台的草稿。");
    const existing = result.drafts[index]!;
    const draft = guardDraft(
      {
        platform,
        title: patch.title?.trim() || null,
        body: patch.body,
        hashtags: patch.hashtags.map((tag) => tag.replace(/^#+|#+$/g, "").trim()).filter(Boolean),
        factIds: existing.factIds,
        edited: true,
      },
      {
        numbers: new Set(result.claimNumbers),
        factIds: new Set(result.stories.flatMap((story) => story.facts.map((fact) => fact.id))),
      },
    );
    result.drafts[index] = draft;
    this.generations.save(result);
    return draft;
  }

  share(id: string, platform: PlatformId, day: string): void {
    const result = this.getGeneration(id);
    this.generations.recordShare(id, result.repoId, platform, day);
  }

  async learnVoice(samplesText: string): Promise<VoiceState> {
    if (!this.limits.voiceLearning) {
      throw new HttpError(403, "plan_required", "风格学习是 Pro 功能；免费版可以手动编辑风格卡。");
    }
    const llm = this.deps.llmFactory();
    if (!llm)
      throw new HttpError(503, "ai_not_configured", "未配置 Claude API Key，无法学习风格。");
    const samples = splitSamples(samplesText);
    if (samples.length < 2) {
      throw new HttpError(
        400,
        "not_enough_samples",
        "请至少粘贴 2 条过去的帖子，用单独一行 --- 分隔。",
      );
    }
    try {
      const { profile, usage } = await learnVoice(llm, samples);
      this.usage.recordRun("voice", null, this.now());
      this.usage.recordUsage(null, [usage], ["voice"], this.now());
      return this.voice.save(profile, "learned", samples.length);
    } catch (error) {
      if (error instanceof AiError) throw new HttpError(502, error.code, error.message);
      throw error;
    }
  }

  usageReport(): UsageReport {
    const month = monthOf(this.now());
    return {
      plan: this.deps.config.plan,
      limits: this.limits,
      month,
      aiRuns: this.usage.runsInMonth(month),
      ...this.usage.monthTotals(month),
    };
  }
}

export function toHttpError(error: unknown): HttpError | null {
  if (error instanceof HttpError) return error;
  if (error instanceof SourceError) {
    const status =
      error.code === "path_not_allowed" || error.code === "github_forbidden"
        ? 403
        : error.code === "repo_not_found" || error.code === "github_not_found"
          ? 404
          : error.code === "github_auth"
            ? 401
            : error.code === "github_rate_limited"
              ? 429
              : error.code === "not_a_git_repo"
                ? 400
                : 502;
    return new HttpError(status, error.code, error.message);
  }
  if (error instanceof AiError) return new HttpError(502, error.code, error.message);
  return null;
}
