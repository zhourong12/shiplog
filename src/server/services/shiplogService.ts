import { basename } from "node:path";
import type {
  ActivityReport,
  Collection,
  CollectionWindow,
  Draft,
  GenerationResult,
  GithubRepoOption,
  MeReport,
  Plan,
  PlatformId,
  PreviewReport,
  RepoSummary,
  UsageReport,
  VoiceState,
} from "../../shared/schemas.js";
import { AiError, type StructuredLlm } from "../ai/llm.js";
import { buildUnderstandPrompt } from "../ai/prompts.js";
import { learnVoice, splitSamples } from "../ai/voice.js";
import { exchangeCode, fetchProfile, listUserRepos } from "../auth/githubOAuth.js";
import { SESSION_TTL_MS } from "../auth/cookies.js";
import { buildBaselineChangelog } from "../baseline/changelog.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/database.js";
import { CredentialStore, resolveEncryptionKey } from "../db/secrets.js";
import {
  GenerationStore,
  LOCAL_USER_ID,
  RepoStore,
  SessionStore,
  UsageStore,
  UserStore,
  VoiceStore,
  monthOf,
  type UserRecord,
} from "../db/stores.js";
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

/** Personal access token pasted in settings (local mode). */
const GITHUB_PAT = "github_token";
/** OAuth token from "Sign in with GitHub", stored as JSON {token, scopes}. */
const GITHUB_OAUTH = "github_oauth";

export interface CurrentUser {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  plan: Plan;
  isLocal: boolean;
}

export interface ServiceDeps {
  db: Db;
  config: AppConfig;
  /** Returns null when AI is not configured. */
  llmFactory: () => StructuredLlm | null;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export class ShipLogService {
  readonly users: UserStore;
  readonly sessions: SessionStore;
  readonly repos: RepoStore;
  readonly generations: GenerationStore;
  readonly usage: UsageStore;
  readonly voice: VoiceStore;
  readonly credentials: CredentialStore;
  readonly now: () => Date;

  constructor(readonly deps: ServiceDeps) {
    this.users = new UserStore(deps.db);
    this.sessions = new SessionStore(deps.db);
    this.repos = new RepoStore(deps.db);
    this.generations = new GenerationStore(deps.db);
    this.usage = new UsageStore(deps.db);
    this.voice = new VoiceStore(deps.db);
    this.credentials = new CredentialStore(deps.db, () =>
      resolveEncryptionKey(process.env, deps.config.keyFilePath),
    );
    this.now = deps.now ?? (() => new Date());
  }

  get config(): AppConfig {
    return this.deps.config;
  }

  // ---------------------------------------------------------------- users

  toCurrentUser(record: UserRecord): CurrentUser {
    const isLocal = this.config.authMode === "local";
    return {
      id: record.id,
      login: record.login,
      name: record.name,
      avatarUrl: record.avatarUrl,
      // Local mode is self-hosted: the operator picks the plan. Hosted plans come from billing.
      plan: isLocal ? this.config.plan : record.plan,
      isLocal,
    };
  }

  localUser(): CurrentUser {
    const record = this.users.get(LOCAL_USER_ID);
    if (!record) throw new Error("Local user is missing; the database was not migrated.");
    return this.toCurrentUser(record);
  }

  userForSession(token: string | undefined): CurrentUser | null {
    if (!token) return null;
    const userId = this.sessions.userIdFor(token, this.now());
    if (userId === null) return null;
    const record = this.users.get(userId);
    return record ? this.toCurrentUser(record) : null;
  }

  /** Complete GitHub sign-in: exchange the code, upsert the user, keep the token, open a session. */
  async loginWithGithub(
    code: string,
    redirectUri: string,
  ): Promise<{ user: CurrentUser; session: string; expiresAt: Date }> {
    const github = this.config.github;
    if (!github) throw new HttpError(404, "auth_disabled", "未开启 GitHub 登录。");
    const token = await exchangeCode(github, code, redirectUri, this.deps.fetchImpl);
    const profile = await fetchProfile(
      this.config.githubApiBaseUrl,
      token.token,
      this.deps.fetchImpl,
    );
    const record = this.users.upsertGithubUser(profile);
    this.credentials.set(
      record.id,
      GITHUB_OAUTH,
      JSON.stringify({ token: token.token, scopes: token.scopes }),
      token.scopes.join(" "),
    );
    this.sessions.purgeExpired(this.now());
    const session = this.sessions.create(record.id, SESSION_TTL_MS, this.now());
    return {
      user: this.toCurrentUser(record),
      session: session.token,
      expiresAt: session.expiresAt,
    };
  }

  logout(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }

  private oauthToken(user: CurrentUser): { token: string; scopes: string[] } | null {
    const raw = this.readCredential(user, GITHUB_OAUTH);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { token?: unknown; scopes?: unknown };
      if (typeof parsed.token !== "string") return null;
      return {
        token: parsed.token,
        scopes: Array.isArray(parsed.scopes) ? parsed.scopes.map(String) : [],
      };
    } catch {
      return null;
    }
  }

  private readCredential(user: CurrentUser, name: string): string | null {
    try {
      return this.credentials.get(user.id, name);
    } catch {
      throw new HttpError(
        500,
        "credential_unreadable",
        "无法解密已保存的 GitHub 令牌，请重新保存或重新登录。",
      );
    }
  }

  /** OAuth token first (hosted), then a pasted personal access token (self-hosted). */
  githubToken(user: CurrentUser): string | null {
    return this.oauthToken(user)?.token ?? this.readCredential(user, GITHUB_PAT);
  }

  me(user: CurrentUser | null): MeReport {
    const billingEnabled = this.config.stripe !== null && this.config.authMode === "github";
    const record = user ? this.users.get(user.id) : null;
    const oauth = user ? this.oauthToken(user) : null;
    return {
      authMode: this.config.authMode,
      authenticated: user !== null,
      user: user
        ? { id: user.id, login: user.login, name: user.name, avatarUrl: user.avatarUrl }
        : null,
      plan: user?.plan ?? "free",
      github: {
        oauth: oauth !== null,
        privateRepos: oauth?.scopes.includes("repo") ?? false,
        pat: user ? this.credentials.status(user.id, GITHUB_PAT).configured : false,
      },
      billing: {
        enabled: billingEnabled,
        status: record?.planStatus ?? null,
        renewsAt: record?.planRenewsAt ?? null,
        canManage: billingEnabled && Boolean(record?.stripeCustomerId),
      },
    };
  }

  limits(user: CurrentUser) {
    return planLimits[user.plan];
  }

  githubPatStatus(user: CurrentUser) {
    return this.credentials.status(user.id, GITHUB_PAT);
  }

  saveGithubPat(user: CurrentUser, token: string) {
    this.credentials.set(user.id, GITHUB_PAT, token);
    return this.githubPatStatus(user);
  }

  deleteGithubPat(user: CurrentUser): void {
    this.credentials.delete(user.id, GITHUB_PAT);
  }

  async listGithubRepos(user: CurrentUser): Promise<GithubRepoOption[]> {
    const token = this.githubToken(user);
    if (!token) {
      throw new HttpError(400, "github_not_connected", "请先用 GitHub 登录或保存 GitHub 令牌。");
    }
    return listUserRepos(this.config.githubApiBaseUrl, token, this.deps.fetchImpl);
  }

  // ---------------------------------------------------------------- repositories

  requireRepo(user: CurrentUser, id: number): RepoSummary {
    const repo = this.repos.get(user.id, id);
    if (!repo) throw new HttpError(404, "repo_not_found", "找不到这个仓库。");
    return repo;
  }

  async addLocalRepo(
    user: CurrentUser,
    localPath: string,
    productContext: string | null,
  ): Promise<RepoSummary> {
    this.assertRepoQuota(user);
    if (this.config.localRoots.length === 0) {
      throw new HttpError(403, "local_disabled", "当前部署未开启本地仓库，请改用 GitHub 仓库。");
    }
    if (!isPathAllowed(localPath, this.config.localRoots)) {
      throw new HttpError(
        403,
        "path_not_allowed",
        "该目录不在允许读取的范围内（SHIPLOG_LOCAL_ROOTS）。",
      );
    }
    const root = await resolveRepoRoot(localPath);
    if (!isPathAllowed(root, this.config.localRoots)) {
      throw new HttpError(403, "path_not_allowed", "该仓库根目录不在允许读取的范围内。");
    }
    return this.repos.create(user.id, {
      kind: "local",
      label: basename(root),
      localPath: root,
      productContext,
    });
  }

  async addGithubRepo(
    user: CurrentUser,
    owner: string,
    repo: string,
    productContext: string | null,
  ): Promise<RepoSummary> {
    this.assertRepoQuota(user);
    if (!githubNamePattern.test(owner) || !githubNamePattern.test(repo)) {
      throw new HttpError(400, "invalid_repo", "仓库名称格式不正确，应为 owner/repo。");
    }
    const fullName = await checkGithubRepo({
      owner,
      repo,
      token: this.githubToken(user),
      baseUrl: this.config.githubApiBaseUrl,
      fetchImpl: this.deps.fetchImpl,
    });
    return this.repos.create(user.id, {
      kind: "github",
      label: fullName,
      githubOwner: owner,
      githubRepo: repo,
      productContext,
    });
  }

  private assertRepoQuota(user: CurrentUser): void {
    const max = this.limits(user).maxRepos;
    if (max !== null && this.repos.count(user.id) >= max) {
      throw new HttpError(
        403,
        "plan_required",
        `免费版最多连接 ${max} 个仓库，升级 Pro 可连接更多。`,
      );
    }
  }

  async collect(
    user: CurrentUser,
    repo: RepoSummary,
    window: CollectionWindow,
  ): Promise<Collection> {
    if (repo.kind === "local") {
      if (!repo.localPath || !isPathAllowed(repo.localPath, this.config.localRoots)) {
        throw new HttpError(403, "path_not_allowed", "该仓库目录已不在允许读取的范围内。");
      }
      return finalizeCollection(await collectLocalGit({ repoPath: repo.localPath, window }));
    }
    return finalizeCollection(
      await collectGithub({
        owner: repo.githubOwner ?? "",
        repo: repo.githubRepo ?? "",
        token: this.githubToken(user),
        window,
        baseUrl: this.config.githubApiBaseUrl,
        fetchImpl: this.deps.fetchImpl,
      }),
    );
  }

  private async commitDays(
    user: CurrentUser,
    repo: RepoSummary,
    since: string,
  ): Promise<Record<string, number>> {
    if (repo.kind === "local") {
      if (!repo.localPath || !isPathAllowed(repo.localPath, this.config.localRoots)) {
        throw new HttpError(403, "path_not_allowed", "该仓库目录已不在允许读取的范围内。");
      }
      return localCommitDays(repo.localPath, since);
    }
    return githubCommitDays({
      owner: repo.githubOwner ?? "",
      repo: repo.githubRepo ?? "",
      token: this.githubToken(user),
      since,
      baseUrl: this.config.githubApiBaseUrl,
      fetchImpl: this.deps.fetchImpl,
    });
  }

  async activity(
    user: CurrentUser,
    repoId: number,
    today: string,
    days = 84,
  ): Promise<ActivityReport> {
    const repo = this.requireRepo(user, repoId);
    const since = new Date(`${today}T00:00:00Z`);
    since.setUTCDate(since.getUTCDate() - (days + 1));
    const commitDays = await this.commitDays(user, repo, since.toISOString());
    const sharedDays = this.generations.sharedDays(user.id, repoId);
    return {
      days: buildActivity(commitDays, sharedDays, today, days),
      commitStreak: currentStreak(Object.keys(commitDays), today),
      longestCommitStreak: longestStreak(Object.keys(commitDays)),
      shareStreak: currentStreak(sharedDays, today),
    };
  }

  async preview(
    user: CurrentUser,
    repoId: number,
    window: CollectionWindow,
  ): Promise<PreviewReport> {
    const repo = this.requireRepo(user, repoId);
    const collection = await this.collect(user, repo, window);
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
        this.voice.get(user.id).profile.language,
      ),
      redactionCount: collection.redactionCount,
      excludedFileCount: collection.excludedFileCount,
      truncated: collection.truncated,
    };
  }

  /** Whether the user may spend an AI run now; the reason is shown when they may not. */
  aiAvailability(user: CurrentUser): { llm: StructuredLlm | null; reason?: string } {
    const llm = this.deps.llmFactory();
    if (!llm) return { llm: null };
    const runLimit = this.limits(user).aiRunsPerMonth;
    if (runLimit !== null && this.usage.runsInMonth(user.id, monthOf(this.now())) >= runLimit) {
      return {
        llm: null,
        reason: `本月 ${runLimit} 次 AI 生成额度已用完，已生成更新日志和数据卡；升级 Pro 可继续使用 AI。`,
      };
    }
    return { llm };
  }

  async generate(
    user: CurrentUser,
    repoId: number,
    window: CollectionWindow,
    platforms: PlatformId[],
    today: string,
  ): Promise<GenerationResult> {
    return (await this.generateIfAny(user, repoId, window, platforms, today, false))!;
  }

  /** Like generate, but returns null (and saves nothing) when skipIfEmpty and there are no commits. */
  async generateIfAny(
    user: CurrentUser,
    repoId: number,
    window: CollectionWindow,
    platforms: PlatformId[],
    today: string,
    skipIfEmpty: boolean,
  ): Promise<GenerationResult | null> {
    const repo = this.requireRepo(user, repoId);
    const collection = await this.collect(user, repo, window);
    if (skipIfEmpty && collection.commits.length === 0) return null;
    const activity = await this.activity(user, repoId, today, 14).catch(() => null);
    const { llm, reason } = this.aiAvailability(user);

    const result = await runPipeline({
      collection,
      platforms,
      voice: this.voice.get(user.id).profile,
      productContext: repo.productContext,
      llm,
      baselineReason: reason,
      repoId,
      activity: activity
        ? { recent: activity.days, commitStreak: activity.commitStreak }
        : undefined,
      now: this.now(),
    });
    this.generations.save(user.id, result);
    // Quota counts runs that actually spent tokens, not configuration errors.
    if (result.usage.length > 0) {
      this.usage.recordRun(user.id, "generation", result.id, this.now());
      this.usage.recordUsage(
        user.id,
        result.id,
        result.usage,
        ["understand", "write", "repair"],
        this.now(),
      );
    }
    return result;
  }

  getGeneration(user: CurrentUser, id: string): GenerationResult {
    const result = this.generations.get(user.id, id);
    if (!result) throw new HttpError(404, "generation_not_found", "找不到这次生成记录。");
    return result;
  }

  /** Save a hand edit and re-run the same deterministic checks against the stored evidence. */
  editDraft(
    user: CurrentUser,
    id: string,
    platform: PlatformId,
    patch: { title: string | null; body: string; hashtags: string[] },
  ): Draft {
    const result = this.getGeneration(user, id);
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
    this.generations.save(user.id, result);
    return draft;
  }

  share(user: CurrentUser, id: string, platform: PlatformId, day: string): void {
    const result = this.getGeneration(user, id);
    this.generations.recordShare(user.id, id, result.repoId, platform, day);
  }

  async learnVoice(user: CurrentUser, samplesText: string): Promise<VoiceState> {
    if (!this.limits(user).voiceLearning) {
      throw new HttpError(403, "plan_required", "风格学习是 Pro 功能；免费版可以手动编辑风格卡。");
    }
    const llm = this.deps.llmFactory();
    if (!llm) {
      throw new HttpError(503, "ai_not_configured", "未配置 Claude API Key，无法学习风格。");
    }
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
      this.usage.recordRun(user.id, "voice", null, this.now());
      this.usage.recordUsage(user.id, null, [usage], ["voice"], this.now());
      return this.voice.save(user.id, profile, "learned", samples.length);
    } catch (error) {
      if (error instanceof AiError) throw new HttpError(502, error.code, error.message);
      throw error;
    }
  }

  usageReport(user: CurrentUser): UsageReport {
    const month = monthOf(this.now());
    return {
      plan: user.plan,
      limits: this.limits(user),
      month,
      aiRuns: this.usage.runsInMonth(user.id, month),
      ...this.usage.monthTotals(user.id, month),
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
          : error.code === "github_rate_limited"
            ? 429
            : error.code === "not_a_git_repo" || error.code === "github_auth"
              ? 400
              : 502;
    return new HttpError(status, error.code, error.message);
  }
  if (error instanceof AiError) return new HttpError(502, error.code, error.message);
  return null;
}
