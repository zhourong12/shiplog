import { z } from "zod";
import type { CollectionWindow, TagRecord } from "../../shared/schemas.js";
import { MAX_COMMITS, SourceError, type RawCollection, type RawCommit } from "./collect.js";

const commitListItemSchema = z.object({
  sha: z.string(),
  html_url: z.string().nullable().optional(),
  commit: z.object({
    message: z.string(),
    author: z.object({ name: z.string().nullable().optional(), date: z.string() }).nullable(),
  }),
  parents: z.array(z.object({ sha: z.string() })).optional(),
});

const commitDetailSchema = commitListItemSchema.extend({
  files: z
    .array(
      z.object({
        filename: z.string(),
        additions: z.number(),
        deletions: z.number(),
        patch: z.string().optional(),
      }),
    )
    .optional(),
});

const releaseSchema = z.object({
  tag_name: z.string(),
  published_at: z.string().nullable(),
  draft: z.boolean(),
});

const repoSchema = z.object({ full_name: z.string(), created_at: z.string().optional() });

export interface GithubOptions {
  owner: string;
  repo: string;
  token: string | null;
  window: CollectionWindow;
  baseUrl?: string;
  maxCommits?: number;
  /** Detail calls (files + patch) are one request per commit; cap them. */
  maxDetailCommits?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export const githubNamePattern = /^[A-Za-z0-9_.-]{1,100}$/;

async function githubGet<T>(
  options: GithubOptions,
  path: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = (options.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "shiplog",
  };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  let response: Response;
  try {
    response = await fetchImpl(`${base}${path}`, {
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
  } catch {
    throw new SourceError("github_unavailable", "无法连接 GitHub，请稍后重试。");
  }
  if (response.status === 401) throw new SourceError("github_auth", "GitHub 令牌无效或已过期。");
  if (response.status === 403 || response.status === 429) {
    if (response.headers.get("x-ratelimit-remaining") === "0" || response.status === 429) {
      throw new SourceError("github_rate_limited", "GitHub 接口调用次数已用完，请稍后再试。");
    }
    throw new SourceError("github_forbidden", "GitHub 令牌没有读取该仓库的权限。");
  }
  if (response.status === 404) {
    throw new SourceError("github_not_found", "找不到该仓库，或令牌无权访问。");
  }
  if (!response.ok) {
    throw new SourceError("github_unavailable", `GitHub 返回异常状态 ${response.status}。`);
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new SourceError("github_bad_response", "GitHub 返回内容过大。");
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SourceError("github_bad_response", "GitHub 返回的数据无法解析。");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success)
    throw new SourceError("github_bad_response", "GitHub 返回的数据格式不符合预期。");
  return parsed.data;
}

function splitMessage(message: string): { subject: string; body: string } {
  const [subject = "", ...rest] = message.split("\n");
  return { subject: subject.trim(), body: rest.join("\n").trim() };
}

/** Rebuild a unified diff from GitHub's per-file patches so it filters like local output. */
function patchFromFiles(files: Array<{ filename: string; patch?: string }>): string {
  return files
    .filter((file) => file.patch)
    .map((file) => `diff --git a/${file.filename} b/${file.filename}\n${file.patch}`)
    .join("\n");
}

export async function checkGithubRepo(options: Omit<GithubOptions, "window">): Promise<string> {
  const repo = await githubGet(
    { ...options, window: { since: "", until: "" } },
    `/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}`,
    repoSchema,
  );
  return repo.full_name;
}

export async function collectGithub(options: GithubOptions): Promise<RawCollection> {
  if (!githubNamePattern.test(options.owner) || !githubNamePattern.test(options.repo)) {
    throw new SourceError("github_not_found", "仓库名称格式不正确。");
  }
  const maxCommits = options.maxCommits ?? MAX_COMMITS;
  const maxDetail = options.maxDetailCommits ?? 30;
  const repoPath = `/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}`;
  const query = new URLSearchParams({
    since: options.window.since,
    until: options.window.until,
    per_page: "100",
  });

  const listed: Array<z.infer<typeof commitListItemSchema>> = [];
  for (let page = 1; page <= 3 && listed.length <= maxCommits; page += 1) {
    query.set("page", String(page));
    const items = await githubGet(
      options,
      `${repoPath}/commits?${query.toString()}`,
      z.array(commitListItemSchema),
    );
    listed.push(...items);
    if (items.length < 100) break;
  }
  const nonMerge = listed.filter((item) => (item.parents?.length ?? 1) <= 1);
  const truncated = nonMerge.length > maxCommits || nonMerge.length > maxDetail;
  const selected = nonMerge.slice(0, Math.min(maxCommits, maxDetail));

  const commits: RawCommit[] = [];
  for (const item of selected) {
    const detail = await githubGet(
      options,
      `${repoPath}/commits/${encodeURIComponent(item.sha)}`,
      commitDetailSchema,
    );
    const { subject, body } = splitMessage(detail.commit.message);
    const files = detail.files ?? [];
    commits.push({
      sha: detail.sha,
      authorName: detail.commit.author?.name ?? "",
      authoredAt: detail.commit.author?.date ?? "",
      subject,
      body,
      files: files.map((file) => ({
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        binary: file.patch === undefined && file.additions + file.deletions === 0,
      })),
      rawPatch: patchFromFiles(files),
      url: detail.html_url ?? null,
    });
  }

  const releases = await githubGet(
    options,
    `${repoPath}/releases?per_page=20`,
    z.array(releaseSchema),
  ).catch(() => []);
  const since = Date.parse(options.window.since);
  const until = Date.parse(options.window.until);
  const tags: TagRecord[] = releases
    .filter((release) => !release.draft && release.published_at)
    .map((release) => ({ name: release.tag_name, createdAt: release.published_at ?? "" }))
    .filter((tag) => {
      const time = Date.parse(tag.createdAt);
      return time >= since && time <= until;
    });

  return {
    repoLabel: `${options.owner}/${options.repo}`,
    source: "github",
    window: options.window,
    commits,
    tags,
    truncated,
    lifetimeCommits: null,
    firstCommitAt: null,
  };
}

/** Days with commits, from the commit list only (no per-commit detail calls). */
export async function githubCommitDays(
  options: Omit<GithubOptions, "window"> & { since: string },
): Promise<Record<string, number>> {
  const repoPath = `/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}`;
  const counts: Record<string, number> = {};
  const query = new URLSearchParams({ since: options.since, per_page: "100" });
  for (let page = 1; page <= 3; page += 1) {
    query.set("page", String(page));
    const items = await githubGet(
      { ...options, window: { since: options.since, until: "" } },
      `${repoPath}/commits?${query.toString()}`,
      z.array(commitListItemSchema),
    );
    for (const item of items) {
      if ((item.parents?.length ?? 1) > 1) continue;
      const day = item.commit.author?.date.slice(0, 10);
      if (day) counts[day] = (counts[day] ?? 0) + 1;
    }
    if (items.length < 100) break;
  }
  return counts;
}
