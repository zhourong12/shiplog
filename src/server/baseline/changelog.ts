import type { Collection, CommitRecord, StoryKind } from "../../shared/schemas.js";

export interface ParsedSubject {
  kind: StoryKind | "other";
  scope: string | null;
  breaking: boolean;
  description: string;
}

const conventionalTypes: Record<string, StoryKind> = {
  feat: "feature",
  feature: "feature",
  fix: "fix",
  bugfix: "fix",
  hotfix: "fix",
  perf: "perf",
  refactor: "refactor",
  docs: "docs",
  doc: "docs",
  test: "test",
  tests: "test",
  chore: "chore",
  style: "chore",
  build: "infra",
  ci: "infra",
  ops: "infra",
  deps: "chore",
  revert: "fix",
};

const keywordRules: Array<{ kind: StoryKind; pattern: RegExp }> = [
  { kind: "fix", pattern: /\b(fix(es|ed)?|bug|hotfix|patch|crash)\b|修复|修正|解决/i },
  { kind: "perf", pattern: /\b(perf|performance|faster|speed ?up|optimi[sz]e)\b|性能|优化|提速/i },
  { kind: "docs", pattern: /\b(docs?|readme|changelog)\b|文档|说明/i },
  { kind: "test", pattern: /\b(tests?|spec|coverage)\b|测试/i },
  {
    kind: "refactor",
    pattern: /\b(refactor|cleanup|clean up|rename|restructure)\b|重构|整理|清理/i,
  },
  { kind: "infra", pattern: /\b(ci|build|deploy|docker|workflow|pipeline)\b|部署|构建|流水线/i },
  {
    kind: "feature",
    pattern: /\b(add(s|ed)?|new|support|introduce|implement|enable)\b|新增|支持|实现|上线|加入/i,
  },
];

export function parseCommitSubject(subject: string): ParsedSubject {
  const match = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/.exec(subject.trim());
  if (match) {
    const type = (match[1] ?? "").toLowerCase();
    const kind = conventionalTypes[type];
    if (kind) {
      return {
        kind,
        scope: match[2] ?? null,
        breaking: Boolean(match[3]),
        description: (match[4] ?? "").trim(),
      };
    }
  }
  const keyword = keywordRules.find((rule) => rule.pattern.test(subject));
  return {
    kind: keyword?.kind ?? "other",
    scope: null,
    breaking: /BREAKING CHANGE/i.test(subject),
    description: subject.trim(),
  };
}

export const kindLabels: Record<StoryKind | "other", string> = {
  feature: "新功能",
  fix: "问题修复",
  perf: "性能",
  refactor: "重构",
  docs: "文档",
  test: "测试",
  chore: "日常维护",
  infra: "构建与部署",
  other: "其他改动",
};

const kindOrder: Array<StoryKind | "other"> = [
  "feature",
  "fix",
  "perf",
  "refactor",
  "docs",
  "test",
  "infra",
  "chore",
  "other",
];

export function groupCommitsByKind(commits: CommitRecord[]): Array<{
  kind: StoryKind | "other";
  items: Array<{ commit: CommitRecord; parsed: ParsedSubject }>;
}> {
  const groups = new Map<
    StoryKind | "other",
    Array<{ commit: CommitRecord; parsed: ParsedSubject }>
  >();
  for (const commit of commits) {
    const parsed = parseCommitSubject(commit.subject);
    const items = groups.get(parsed.kind) ?? [];
    items.push({ commit, parsed });
    groups.set(parsed.kind, items);
  }
  return kindOrder
    .filter((kind) => groups.has(kind))
    .map((kind) => ({ kind, items: groups.get(kind) ?? [] }));
}

function formatDay(iso: string): string {
  return iso.slice(0, 10);
}

/** Deterministic, AI-free changelog in Markdown. Every line maps to one commit. */
export function buildBaselineChangelog(collection: Collection): string {
  const { window, commits, tags, totals } = collection;
  const header = `## ${collection.repoLabel} 更新日志（${formatDay(window.since)} ~ ${formatDay(window.until)}）`;
  if (commits.length === 0) {
    return `${header}\n\n这段时间没有新的提交。`;
  }
  const lines: string[] = [header, ""];
  if (tags.length > 0) {
    lines.push(`发布：${tags.map((tag) => `\`${tag.name}\``).join("、")}`, "");
  }
  lines.push(
    `共 ${totals.commits} 次提交，${totals.filesChanged} 个文件，+${totals.additions} / -${totals.deletions} 行。`,
    "",
  );
  for (const group of groupCommitsByKind(commits)) {
    lines.push(`### ${kindLabels[group.kind]}`);
    for (const { commit, parsed } of group.items) {
      const scope = parsed.scope ? `**${parsed.scope}**：` : "";
      const breaking = parsed.breaking ? "（不兼容变更）" : "";
      const pr = commit.prNumber ? ` (#${commit.prNumber})` : "";
      const description = parsed.description.replace(/\s*\(#\d+\)\s*$/, "");
      lines.push(`- ${scope}${description}${breaking}${pr} \`${commit.shortSha}\``);
    }
    lines.push("");
  }
  if (collection.truncated) {
    lines.push("> 提交较多，仅列出最近的部分记录。");
  }
  return lines.join("\n").trim();
}
