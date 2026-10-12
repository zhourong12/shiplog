import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { CollectionWindow, TagRecord } from "../../shared/schemas.js";
import { MAX_COMMITS, SourceError, type RawCollection, type RawCommit } from "./collect.js";

const execFileAsync = promisify(execFile);

const RECORD = "\x1e";
const FIELD = "\x1f";

async function git(cwd: string, args: string[], timeoutMs = 20_000): Promise<string> {
  try {
    // execFile never goes through a shell, so arguments cannot inject commands.
    const { stdout } = await execFileAsync("git", ["-c", "core.quotepath=off", ...args], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C.UTF-8" },
    });
    return stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new SourceError("git_failed", `读取 git 记录失败：${message}`);
  }
}

/** Only allow repositories under configured roots, so the API cannot read arbitrary paths. */
export function isPathAllowed(repoPath: string, allowedRoots: string[]): boolean {
  const target = resolve(repoPath);
  return allowedRoots.some((root) => {
    const rel = relative(resolve(root), target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

export async function resolveRepoRoot(repoPath: string): Promise<string> {
  const info = await stat(repoPath).catch(() => null);
  if (!info?.isDirectory()) throw new SourceError("repo_not_found", "仓库目录不存在。");
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: repoPath,
      timeout: 10_000,
    });
    return stdout.trim();
  } catch {
    throw new SourceError("not_a_git_repo", "该目录不是 git 仓库。");
  }
}

/** Parse `git log --format=<RS>sha<US>author<US>date<US>subject<US>body<US> --numstat`. */
export function parseLogWithNumstat(output: string): Array<Omit<RawCommit, "rawPatch" | "url">> {
  const commits: Array<Omit<RawCommit, "rawPatch" | "url">> = [];
  for (const record of output.split(RECORD)) {
    if (!record.trim()) continue;
    const parts = record.split(FIELD);
    const [sha, authorName, authoredAt, subject, body] = parts;
    const numstat = parts[5] ?? "";
    if (!sha || !authoredAt) continue;
    const files = numstat
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [adds, dels, ...pathParts] = line.split("\t");
        const path = pathParts.join("\t");
        const binary = adds === "-" || dels === "-";
        return {
          path,
          additions: binary ? 0 : Number(adds) || 0,
          deletions: binary ? 0 : Number(dels) || 0,
          binary,
        };
      })
      .filter((file) => file.path.length > 0);
    commits.push({
      sha: sha.trim(),
      authorName: authorName ?? "",
      authoredAt: authoredAt.trim(),
      subject: (subject ?? "").trim(),
      body: (body ?? "").trim(),
      files,
    });
  }
  return commits;
}

export interface LocalGitOptions {
  repoPath: string;
  window: CollectionWindow;
  includePatches?: boolean;
  maxCommits?: number;
}

export async function collectLocalGit(options: LocalGitOptions): Promise<RawCollection> {
  const root = await resolveRepoRoot(options.repoPath);
  const maxCommits = options.maxCommits ?? MAX_COMMITS;
  const hasHead = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(
    () => true,
    () => false,
  );
  if (!hasHead) {
    return {
      repoLabel: basename(root),
      source: "local",
      window: options.window,
      commits: [],
      tags: [],
      truncated: false,
      lifetimeCommits: 0,
      firstCommitAt: null,
    };
  }
  const log = await git(root, [
    "log",
    "--no-merges",
    "--no-renames",
    `--since=${options.window.since}`,
    `--until=${options.window.until}`,
    `--max-count=${maxCommits + 1}`,
    `--format=${RECORD}%H${FIELD}%an${FIELD}%aI${FIELD}%s${FIELD}%b${FIELD}`,
    "--numstat",
  ]);
  const parsed = parseLogWithNumstat(log);
  const truncated = parsed.length > maxCommits;
  const selected = parsed.slice(0, maxCommits);

  const commits: RawCommit[] = [];
  for (const commit of selected) {
    let rawPatch = "";
    if (options.includePatches !== false) {
      rawPatch = await git(root, [
        "show",
        "--no-renames",
        "--format=",
        "--unified=2",
        "--no-color",
        commit.sha,
      ]).catch(() => "");
    }
    commits.push({ ...commit, rawPatch, url: null });
  }

  const [lifetime, firstCommit, tagOutput] = await Promise.all([
    git(root, ["rev-list", "--count", "HEAD"]).catch(() => ""),
    git(root, ["log", "--reverse", "--format=%aI", "--max-parents=0", "HEAD"]).catch(() => ""),
    git(root, [
      "for-each-ref",
      "--sort=creatordate",
      `--format=%(refname:short)${FIELD}%(creatordate:iso-strict)`,
      "refs/tags",
    ]).catch(() => ""),
  ]);
  const since = Date.parse(options.window.since);
  const until = Date.parse(options.window.until);
  const tags: TagRecord[] = tagOutput
    .split("\n")
    .map((line) => line.split(FIELD))
    .filter((parts): parts is [string, string] => Boolean(parts[0] && parts[1]))
    .map(([name, createdAt]) => ({ name, createdAt }))
    .filter((tag) => {
      const time = Date.parse(tag.createdAt);
      return time >= since && time <= until;
    });

  return {
    // The folder name, never the remote URL: remotes can embed credentials.
    repoLabel: basename(root),
    source: "local",
    window: options.window,
    commits,
    tags,
    truncated,
    lifetimeCommits: Number(lifetime.trim()) || null,
    firstCommitAt: firstCommit.split("\n")[0]?.trim() || null,
  };
}

/** Days (YYYY-MM-DD, local server time) with at least one commit, with counts. */
export async function localCommitDays(
  repoPath: string,
  sinceIso: string,
): Promise<Record<string, number>> {
  const root = await resolveRepoRoot(repoPath);
  const output = await git(root, [
    "log",
    "--no-merges",
    `--since=${sinceIso}`,
    "--format=%aI",
  ]).catch(() => "");
  const counts: Record<string, number> = {};
  for (const line of output.split("\n")) {
    const day = line.trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) counts[day] = (counts[day] ?? 0) + 1;
  }
  return counts;
}
