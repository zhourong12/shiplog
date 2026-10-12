import { describe, expect, it } from "vitest";
import type { Collection, CommitRecord } from "../shared/schemas.js";
import { buildBaselineChangelog, parseCommitSubject } from "./baseline/changelog.js";
import { pickSnippet, renderCodeCard } from "./cards/codeCard.js";
import { renderStatsCard } from "./cards/statsCard.js";
import {
  buildActivity,
  changeBreakdown,
  currentStreak,
  detectMilestones,
  longestStreak,
} from "./insights.js";

function commit(partial: Partial<CommitRecord> & { subject: string }): CommitRecord {
  return {
    sha: partial.sha ?? partial.subject.padEnd(40, "0").slice(0, 40),
    shortSha: (partial.sha ?? "abcdef0").slice(0, 7),
    authorName: "dev",
    authoredAt: "2026-10-11T10:00:00Z",
    body: "",
    files: [],
    patch: "",
    prNumber: null,
    url: null,
    ...partial,
  };
}

function collectionWith(commits: CommitRecord[], extra: Partial<Collection> = {}): Collection {
  return {
    repoLabel: "shiplog",
    source: "local",
    window: { since: "2026-10-11T00:00:00.000Z", until: "2026-10-12T00:00:00.000Z" },
    commits,
    tags: [],
    totals: { commits: commits.length, additions: 10, deletions: 2, filesChanged: 2 },
    truncated: false,
    diffTruncated: false,
    excludedFileCount: 0,
    redactionCount: 0,
    lifetimeCommits: null,
    firstCommitAt: null,
    ...extra,
  };
}

describe("baseline changelog", () => {
  it("parses conventional commits and falls back to keywords", () => {
    expect(parseCommitSubject("feat(ui)!: new editor")).toEqual({
      kind: "feature",
      scope: "ui",
      breaking: true,
      description: "new editor",
    });
    expect(parseCommitSubject("修复登录页白屏").kind).toBe("fix");
    expect(parseCommitSubject("新增导出按钮").kind).toBe("feature");
    expect(parseCommitSubject("wip").kind).toBe("other");
  });

  it("groups commits by kind with short SHAs and PR numbers", () => {
    const markdown = buildBaselineChangelog(
      collectionWith(
        [
          commit({ sha: "1111111aaaa", subject: "fix: crash on empty repo" }),
          commit({ sha: "2222222bbbb", subject: "feat(cards): stats card (#9)", prNumber: 9 }),
          commit({ sha: "3333333cccc", subject: "wip" }),
        ],
        { tags: [{ name: "v0.1.0", createdAt: "2026-10-11T12:00:00Z" }] },
      ),
    );
    expect(markdown).toContain("发布：`v0.1.0`");
    expect(markdown.indexOf("### 新功能")).toBeLessThan(markdown.indexOf("### 问题修复"));
    expect(markdown).toContain("- **cards**：stats card (#9) `2222222`");
    expect(markdown).toContain("### 其他改动");
  });

  it("says so honestly when there were no commits", () => {
    expect(
      buildBaselineChangelog(
        collectionWith([], { totals: { commits: 0, additions: 0, deletions: 0, filesChanged: 0 } }),
      ),
    ).toContain("没有新的提交");
  });
});

describe("insights", () => {
  it("detects lifetime commit milestones, releases and anniversaries", () => {
    const milestones = detectMilestones(
      collectionWith([commit({ subject: "a" }), commit({ subject: "b" })], {
        lifetimeCommits: 101,
        tags: [{ name: "v1.0.0", createdAt: "2026-10-11T12:00:00Z" }],
        firstCommitAt: "2025-10-11T08:00:00Z",
      }),
    );
    expect(milestones.map((m) => m.label)).toEqual(["第 100 次提交", "发布 v1.0.0", "项目 1 周年"]);
  });

  it("computes current and longest streaks", () => {
    const days = [
      "2026-10-08",
      "2026-10-09",
      "2026-10-10",
      "2026-10-11",
      "2026-10-01",
      "2026-10-02",
    ];
    expect(currentStreak(days, "2026-10-11")).toBe(4);
    expect(currentStreak(days, "2026-10-12")).toBe(4);
    expect(currentStreak(days, "2026-10-14")).toBe(0);
    expect(longestStreak(days)).toBe(4);
  });

  it("builds a fixed-length activity series", () => {
    const series = buildActivity({ "2026-10-11": 3 }, new Set(["2026-10-10"]), "2026-10-11", 3);
    expect(series).toEqual([
      { day: "2026-10-09", commits: 0, shared: false },
      { day: "2026-10-10", commits: 0, shared: true },
      { day: "2026-10-11", commits: 3, shared: false },
    ]);
  });

  it("breaks changes down by file and language, ignoring excluded files", () => {
    const breakdown = changeBreakdown(
      collectionWith([
        commit({
          subject: "x",
          files: [
            { path: "src/a.ts", additions: 10, deletions: 5, binary: false, excludedReason: null },
            { path: "src/b.py", additions: 3, deletions: 0, binary: false, excludedReason: null },
            {
              path: "package-lock.json",
              additions: 900,
              deletions: 900,
              binary: false,
              excludedReason: "lockfile",
            },
          ],
        }),
      ]),
    );
    expect(breakdown.topFiles).toEqual([
      { path: "src/a.ts", lines: 15 },
      { path: "src/b.py", lines: 3 },
    ]);
    expect(breakdown.languages).toEqual([
      { language: "TypeScript", lines: 15 },
      { language: "Python", lines: 3 },
    ]);
  });
});

describe("cards", () => {
  it("renders an escaped stats card with every headline number", () => {
    const svg = renderStatsCard({
      repoLabel: "a<b>&c",
      windowLabel: "2026-10-11",
      totals: { commits: 7, additions: 1234, deletions: 56, filesChanged: 9 },
      breakdown: {
        topFiles: [{ path: "src/server/pipeline.ts", lines: 300 }],
        languages: [
          { language: "TypeScript", lines: 300 },
          { language: "CSS", lines: 20 },
        ],
      },
      activity: buildActivity({ "2026-10-11": 4 }, new Set(), "2026-10-11", 14),
      commitStreak: 3,
    });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("a&lt;b&gt;&amp;c");
    expect(svg).toContain("+1,234");
    expect(svg).toContain("连续开发 3 天");
    expect(svg).toContain("TypeScript 94%");
    expect(svg).not.toContain("<script");
  });

  it("picks the hunk with the most additions and renders a code card", () => {
    const snippet = pickSnippet({
      patch: [
        "diff --git a/a.ts b/a.ts",
        "@@ -1,2 +1,2 @@",
        "-old",
        "+new",
        "diff --git a/b.ts b/b.ts",
        "@@ -5,1 +5,4 @@",
        " context",
        "+one",
        "+two <tag>",
        "+three",
      ].join("\n"),
    });
    expect(snippet?.path).toBe("b.ts");
    expect(snippet?.lines.filter((line) => line.kind === "add")).toHaveLength(3);
    const svg = renderCodeCard({ title: "新功能", repoLabel: "demo", snippet: snippet! });
    expect(svg).toContain("two &lt;tag&gt;");
    expect(pickSnippet({ patch: "" })).toBeNull();
  });

  it("prefers source files over config files for code cards", () => {
    const snippet = pickSnippet({
      patch: [
        "diff --git a/package.json b/package.json",
        "@@ -1 +1,5 @@",
        "+a",
        "+b",
        "+c",
        "+d",
        "diff --git a/src/app.ts b/src/app.ts",
        "@@ -1 +1,2 @@",
        "+export const ship = true;",
      ].join("\n"),
    });
    expect(snippet?.path).toBe("src/app.ts");
  });
});
