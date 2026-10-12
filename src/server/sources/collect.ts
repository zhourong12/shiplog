import type {
  Collection,
  CollectionWindow,
  CommitFile,
  CommitRecord,
  TagRecord,
} from "../../shared/schemas.js";
import { excludedReasonForPath, filterPatch } from "../prep/filter.js";
import { redactSecrets } from "../prep/redact.js";

/** Raw commit as returned by a source, before filtering and redaction. */
export interface RawCommit {
  sha: string;
  authorName: string;
  authoredAt: string;
  subject: string;
  body: string;
  files: Array<Pick<CommitFile, "path" | "additions" | "deletions" | "binary">>;
  rawPatch: string;
  url: string | null;
}

export interface RawCollection {
  repoLabel: string;
  source: "local" | "github";
  window: CollectionWindow;
  commits: RawCommit[];
  tags: TagRecord[];
  truncated: boolean;
  lifetimeCommits: number | null;
  firstCommitAt: string | null;
}

export const MAX_COMMITS = 120;

export function prNumberFromSubject(subject: string): number | null {
  const match =
    /\(#(\d{1,7})\)\s*$/.exec(subject) ?? /^Merge pull request #(\d{1,7})\b/.exec(subject);
  return match?.[1] ? Number(match[1]) : null;
}

/**
 * Turn source output into the collection the rest of the pipeline uses:
 * mark excluded files, filter and redact patches and messages, and add up totals.
 */
export function finalizeCollection(raw: RawCollection): Collection {
  let excludedFileCount = 0;
  let redactionCount = 0;
  let diffTruncated = false;
  const commits: CommitRecord[] = raw.commits.map((commit) => {
    const files: CommitFile[] = commit.files.map((file) => {
      const excludedReason = excludedReasonForPath(file.path, file.binary);
      if (excludedReason) excludedFileCount += 1;
      return { ...file, excludedReason };
    });
    const filtered = filterPatch(commit.rawPatch);
    if (filtered.truncated) diffTruncated = true;
    const patch = redactSecrets(filtered.text);
    const subject = redactSecrets(commit.subject);
    const body = redactSecrets(commit.body);
    redactionCount += patch.count + subject.count + body.count;
    return {
      sha: commit.sha,
      shortSha: commit.sha.slice(0, 7),
      authorName: commit.authorName,
      authoredAt: commit.authoredAt,
      subject: subject.text,
      body: body.text,
      files,
      patch: patch.text,
      prNumber: prNumberFromSubject(commit.subject),
      url: commit.url,
    };
  });
  const filePaths = new Set<string>();
  let additions = 0;
  let deletions = 0;
  for (const commit of commits) {
    for (const file of commit.files) {
      filePaths.add(file.path);
      additions += file.additions;
      deletions += file.deletions;
    }
  }
  return {
    repoLabel: raw.repoLabel,
    source: raw.source,
    window: raw.window,
    commits,
    tags: raw.tags,
    totals: { commits: commits.length, additions, deletions, filesChanged: filePaths.size },
    truncated: raw.truncated,
    diffTruncated,
    excludedFileCount,
    redactionCount,
    lifetimeCommits: raw.lifetimeCommits,
    firstCommitAt: raw.firstCommitAt,
  };
}

export class SourceError extends Error {
  constructor(
    readonly code:
      | "repo_not_found"
      | "not_a_git_repo"
      | "path_not_allowed"
      | "git_failed"
      | "github_auth"
      | "github_forbidden"
      | "github_not_found"
      | "github_rate_limited"
      | "github_unavailable"
      | "github_bad_response",
    message: string,
  ) {
    super(message);
    this.name = "SourceError";
  }
}
