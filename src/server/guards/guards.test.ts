import { describe, expect, it } from "vitest";
import type { ChangeStory, Collection } from "../../shared/schemas.js";
import { buildClaimContext, checkClaims, extractNumbers } from "./claimGuard.js";
import { guardDraft } from "./index.js";
import {
  checkPlatformRules,
  composeText,
  composeUrl,
  splitThread,
  xWeightedLength,
} from "./platformRules.js";

describe("xWeightedLength", () => {
  it("counts Latin as 1, CJK as 2, URLs as 23 and emoji as 2", () => {
    expect(xWeightedLength("hello")).toBe(5);
    expect(xWeightedLength("你好")).toBe(4);
    expect(xWeightedLength("see https://example.com/a/very/long/path?x=1")).toBe(4 + 23);
    expect(xWeightedLength("🚀")).toBe(2);
    expect(xWeightedLength("👩‍💻 ok")).toBe(2 + 3);
  });
});

describe("checkPlatformRules", () => {
  it("flags each X post over 280 weighted characters", () => {
    const body = ["短句", "中".repeat(141), "ok"].join("\n---\n");
    const issues = checkPlatformRules({ platform: "x", title: null, body, hashtags: [] });
    expect(issues).toEqual([expect.objectContaining({ code: "too_long", severity: "error" })]);
    expect(issues[0]?.message).toContain("第 2 条");
    expect(splitThread(body)).toHaveLength(3);
  });

  it("requires a title of at most 20 characters on Xiaohongshu", () => {
    expect(
      checkPlatformRules({ platform: "xiaohongshu", title: null, body: "正文", hashtags: [] }),
    ).toEqual([expect.objectContaining({ code: "title_missing" })]);
    expect(
      checkPlatformRules({
        platform: "xiaohongshu",
        title: "一".repeat(21),
        body: "正文",
        hashtags: [],
      }),
    ).toEqual([expect.objectContaining({ code: "title_too_long" })]);
  });

  it("enforces the Product Hunt 260 character description limit", () => {
    const issues = checkPlatformRules({
      platform: "producthunt",
      title: "Ship daily",
      body: "a".repeat(261),
      hashtags: [],
    });
    expect(issues).toEqual([expect.objectContaining({ code: "too_long", severity: "error" })]);
  });

  it("warns instead of failing on soft limits", () => {
    const issues = checkPlatformRules({
      platform: "jike",
      title: null,
      body: "字".repeat(600),
      hashtags: [],
    });
    expect(issues).toEqual([expect.objectContaining({ code: "too_long", severity: "warning" })]);
  });

  it("composes platform-specific hashtags and compose links", () => {
    expect(
      composeText({
        platform: "xiaohongshu",
        body: "正文",
        hashtags: ["独立开发", "#buildinpublic"],
      }),
    ).toBe("正文\n\n#独立开发# #buildinpublic#");
    expect(composeText({ platform: "v2ex", body: "正文", hashtags: ["ignored"] })).toBe("正文");
    expect(composeUrl({ platform: "x", body: "first\n---\nsecond", hashtags: [] })).toBe(
      "https://x.com/intent/post?text=first",
    );
    expect(composeUrl({ platform: "changelog", body: "x", hashtags: [] })).toBeNull();
  });
});

const collection: Collection = {
  repoLabel: "demo",
  source: "local",
  window: { since: "2026-10-11T00:00:00.000Z", until: "2026-10-12T00:00:00.000Z" },
  commits: [
    {
      sha: "a".repeat(40),
      shortSha: "aaaaaaa",
      authorName: "dev",
      authoredAt: "2026-10-11T10:00:00Z",
      subject: "perf: cache parsed config, startup 1200ms -> 300ms",
      body: "",
      files: [
        { path: "src/config.ts", additions: 30, deletions: 8, binary: false, excludedReason: null },
      ],
      patch: "@@ -10,7 +10,9 @@\n-const TIMEOUT = 5000;\n+const TIMEOUT = 8000;",
      prNumber: 42,
      url: null,
    },
  ],
  tags: [{ name: "v1.4.0", createdAt: "2026-10-11T12:00:00Z" }],
  totals: { commits: 1, additions: 30, deletions: 8, filesChanged: 1 },
  truncated: false,
  diffTruncated: false,
  excludedFileCount: 0,
  redactionCount: 0,
  lifetimeCommits: 100,
  firstCommitAt: null,
};

const stories: ChangeStory[] = [
  {
    id: "s1",
    title: "启动更快了",
    kind: "perf",
    userFacing: true,
    shareability: "high",
    summary: "缓存配置解析",
    angle: "",
    commitShas: ["a".repeat(40)],
    facts: [{ id: "f1", text: "启动时间从 1200ms 降到 300ms", sourceShas: ["a".repeat(40)] }],
  },
];

describe("claim guard", () => {
  const context = buildClaimContext(collection, stories, []);

  it("extracts numbers but skips list and thread numbering", () => {
    expect(extractNumbers("1/3 启动提升 75%\n2. 修了 1,234 行\nv2 版本 a1b2")).toEqual([
      "75",
      "1234",
    ]);
  });

  it("accepts numbers backed by commits, diffs, stats, tags and facts", () => {
    const issues = checkClaims(
      {
        platform: "jike",
        title: null,
        body: "启动从 1200ms 降到 300ms，超时调到 8000，发布 1.4.0，PR 42，新增 30 行，第 100 次提交，10 月 11 日",
        hashtags: [],
        factIds: ["f1"],
      },
      context,
    );
    expect(issues).toEqual([]);
  });

  it("blocks invented numbers such as a made-up percentage", () => {
    const issues = checkClaims(
      {
        platform: "jike",
        title: null,
        body: "启动速度提升 40%，用户增长 300 人",
        hashtags: [],
        factIds: ["f1"],
      },
      context,
    );
    expect(issues).toEqual([
      expect.objectContaining({ code: "unsupported_number", severity: "error" }),
    ]);
    expect(issues[0]?.message).toContain("40");
    // 300 is in the commit message, so only 40 is unsupported.
    expect(issues[0]?.message).not.toContain("300");
  });

  it("blocks secrets and flags unknown facts or missing evidence", () => {
    const secret = `gh${"p"}_${"Q".repeat(36)}`;
    const issues = checkClaims(
      { platform: "x", title: null, body: `token ${secret}`, hashtags: [], factIds: ["f9"] },
      context,
    );
    expect(issues.map((issue) => issue.code)).toEqual(["secret_detected", "unknown_fact"]);
    const noFacts = checkClaims(
      { platform: "x", title: null, body: "更新", hashtags: [], factIds: [] },
      context,
    );
    expect(noFacts.map((issue) => issue.code)).toEqual(["no_facts"]);
  });

  it("guardDraft marks drafts with errors as needs_review", () => {
    const draft = guardDraft(
      {
        platform: "jike",
        title: null,
        body: "性能提升 40%",
        hashtags: [],
        factIds: ["f1"],
        edited: false,
      },
      context,
    );
    expect(draft.status).toBe("needs_review");
    const clean = guardDraft(
      {
        platform: "jike",
        title: null,
        body: "启动快了很多",
        hashtags: [],
        factIds: ["f1"],
        edited: false,
      },
      context,
    );
    expect(clean.status).toBe("ok");
  });
});
