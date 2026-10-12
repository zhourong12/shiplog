import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { finalizeCollection, prNumberFromSubject } from "./collect.js";
import { collectGithub } from "./github.js";
import {
  collectLocalGit,
  isPathAllowed,
  localCommitDays,
  parseLogWithNumstat,
} from "./localGit.js";

function git(cwd: string, args: string[], date?: string) {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Dev",
      GIT_AUTHOR_EMAIL: "dev@example.com",
      GIT_COMMITTER_NAME: "Dev",
      GIT_COMMITTER_EMAIL: "dev@example.com",
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
    },
  });
}

describe("local git source", () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "shiplog-git-"));
    git(repo, ["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "app.ts"), "export const a = 1;\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "chore: init"], "2026-10-01T09:00:00+00:00");
    writeFileSync(join(repo, "app.ts"), "export const a = 1;\nexport const timeout = 3000;\n");
    writeFileSync(join(repo, "package-lock.json"), '{"lockfileVersion": 3}\n');
    const fakeKey = `sk-${"ant"}-${"k".repeat(30)}`;
    writeFileSync(join(repo, "config.ts"), `export const key = "${fakeKey}";\n`);
    git(repo, ["add", "."]);
    git(
      repo,
      ["commit", "-q", "-m", "feat(api): add timeout option (#12)", "-m", "Body line"],
      "2026-10-11T10:00:00+00:00",
    );
    git(repo, ["tag", "v0.2.0"], "2026-10-11T11:00:00+00:00");
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("collects commits in the window with numstat, patches and tags", async () => {
    const raw = await collectLocalGit({
      repoPath: repo,
      window: { since: "2026-10-10T00:00:00Z", until: "2026-10-12T00:00:00Z" },
    });
    expect(raw.commits).toHaveLength(1);
    expect(raw.lifetimeCommits).toBe(2);
    expect(raw.firstCommitAt).toContain("2026-10-01");
    const commit = raw.commits[0]!;
    expect(commit.subject).toBe("feat(api): add timeout option (#12)");
    expect(commit.body).toBe("Body line");
    expect(commit.files.map((file) => file.path).sort()).toEqual([
      "app.ts",
      "config.ts",
      "package-lock.json",
    ]);
    expect(commit.rawPatch).toContain("+export const timeout = 3000;");
    expect(raw.tags.map((tag) => tag.name)).toEqual(["v0.2.0"]);

    const collection = finalizeCollection(raw);
    const finalCommit = collection.commits[0]!;
    expect(finalCommit.prNumber).toBe(12);
    expect(finalCommit.patch).not.toContain("lockfileVersion");
    expect(finalCommit.patch).not.toContain(`sk-${"ant"}`);
    expect(collection.redactionCount).toBe(1);
    expect(collection.excludedFileCount).toBe(1);
    expect(collection.totals).toEqual({ commits: 1, additions: 3, deletions: 0, filesChanged: 3 });
  });

  it("reports commit days and rejects non-repositories", async () => {
    const days = await localCommitDays(repo, "2026-09-01T00:00:00Z");
    expect(days).toEqual({ "2026-10-01": 1, "2026-10-11": 1 });
    const notRepo = mkdtempSync(join(tmpdir(), "shiplog-plain-"));
    await expect(
      collectLocalGit({
        repoPath: notRepo,
        window: { since: "2026-10-10T00:00:00Z", until: "2026-10-12T00:00:00Z" },
      }),
    ).rejects.toMatchObject({ code: "not_a_git_repo" });
    rmSync(notRepo, { recursive: true, force: true });
  });

  it("only allows paths inside configured roots", () => {
    expect(isPathAllowed("/home/me/code/app", ["/home/me/code"])).toBe(true);
    expect(isPathAllowed("/home/me/code", ["/home/me/code"])).toBe(true);
    expect(isPathAllowed("/home/me/code/../secrets", ["/home/me/code"])).toBe(false);
    expect(isPathAllowed("/etc", ["/home/me/code"])).toBe(false);
    expect(isPathAllowed("/home/me/code-other", ["/home/me/code"])).toBe(false);
  });

  it("parses numstat with binary files", () => {
    const parsed = parseLogWithNumstat(
      "\x1eabc\x1fDev\x1f2026-10-11T10:00:00Z\x1fsubject\x1f\x1f\n3\t1\tsrc/a.ts\n-\t-\timg.png\n",
    );
    expect(parsed[0]?.files).toEqual([
      { path: "src/a.ts", additions: 3, deletions: 1, binary: false },
      { path: "img.png", additions: 0, deletions: 0, binary: true },
    ]);
  });

  it("reads PR numbers from squash and merge subjects", () => {
    expect(prNumberFromSubject("feat: x (#123)")).toBe(123);
    expect(prNumberFromSubject("Merge pull request #7 from a/b")).toBe(7);
    expect(prNumberFromSubject("fix: issue 12")).toBeNull();
  });
});

describe("github source", () => {
  const window = { since: "2026-10-10T00:00:00Z", until: "2026-10-12T00:00:00Z" };

  function jsonResponse(body: unknown, init: ResponseInit = {}) {
    return new Response(JSON.stringify(body), { status: 200, ...init });
  }

  it("lists commits, loads details and releases with auth headers", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("/commits?")) {
        return jsonResponse([
          {
            sha: "1".repeat(40),
            commit: { message: "feat: one", author: { name: "A", date: "2026-10-11T01:00:00Z" } },
            parents: [{ sha: "0" }],
          },
          {
            sha: "2".repeat(40),
            commit: {
              message: "Merge branch",
              author: { name: "A", date: "2026-10-11T02:00:00Z" },
            },
            parents: [{ sha: "0" }, { sha: "9" }],
          },
        ]);
      }
      if (href.includes(`/commits/${"1".repeat(40)}`)) {
        return jsonResponse({
          sha: "1".repeat(40),
          html_url: "https://github.com/o/r/commit/1",
          commit: {
            message: "feat: one\n\nDetails",
            author: { name: "A", date: "2026-10-11T01:00:00Z" },
          },
          files: [
            { filename: "src/a.ts", additions: 5, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" },
          ],
        });
      }
      if (href.includes("/releases")) {
        return jsonResponse([
          { tag_name: "v1.0.0", published_at: "2026-10-11T05:00:00Z", draft: false },
          { tag_name: "v0.9.0", published_at: "2026-09-01T05:00:00Z", draft: false },
        ]);
      }
      return new Response("not found", { status: 404 });
    });

    const raw = await collectGithub({
      owner: "o",
      repo: "r",
      token: "test-token",
      window,
      fetchImpl,
    });
    expect(raw.commits).toHaveLength(1);
    expect(raw.commits[0]).toMatchObject({
      subject: "feat: one",
      body: "Details",
      url: "https://github.com/o/r/commit/1",
    });
    expect(raw.commits[0]?.rawPatch).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(raw.tags).toEqual([{ name: "v1.0.0", createdAt: "2026-10-11T05:00:00Z" }]);
    const firstCall = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((firstCall[1].headers as Record<string, string>).Authorization).toBe(
      "Bearer test-token",
    );
  });

  it.each([
    [401, {}, "github_auth"],
    [403, { "x-ratelimit-remaining": "0" }, "github_rate_limited"],
    [403, {}, "github_forbidden"],
    [404, {}, "github_not_found"],
    [502, {}, "github_unavailable"],
  ])("maps HTTP %s to %s", async (status, headers, code) => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status, headers }));
    await expect(
      collectGithub({ owner: "o", repo: "r", token: null, window, fetchImpl }),
    ).rejects.toMatchObject({ code });
  });

  it("rejects malformed responses and invalid names", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ not: "a list" }), { status: 200 }),
    );
    await expect(
      collectGithub({ owner: "o", repo: "r", token: null, window, fetchImpl }),
    ).rejects.toMatchObject({
      code: "github_bad_response",
    });
    await expect(
      collectGithub({ owner: "../x", repo: "r", token: null, window, fetchImpl }),
    ).rejects.toMatchObject({
      code: "github_not_found",
    });
  });
});
