import type {
  ChangeStory,
  Collection,
  Draft,
  GuardIssue,
  Milestone,
} from "../../shared/schemas.js";
import { containsSecret } from "../prep/redact.js";

/**
 * Numbers like 40, 1,234, 3.5, 2.0.1, optionally glued to a unit ("300ms", "2x", "10k").
 * Digits inside identifiers, hashes and paths are not claims and are skipped.
 */
const numberPattern =
  /(?<![A-Za-z0-9_.#/@-])(\d+(?:[.,]\d+)*)(?:ms|s|x|k|K|M|MB|KB|GB|px|h|min|fps|qps|rps)?(?![A-Za-z0-9_])/g;

function normalizeNumber(raw: string): string {
  // "1,234" -> "1234"; keep dots so versions stay distinct from integers.
  return /^\d{1,3}(,\d{3})+$/.test(raw) ? raw.replace(/,/g, "") : raw;
}

export function extractNumbers(text: string): string[] {
  const numbers: string[] = [];
  for (const line of text.split("\n")) {
    // Thread numbering ("1/5") and list numbering ("1." "2、") are structure, not claims.
    const content = line.replace(/^\s*(\d+\s*\/\s*\d+|\d+[.、)]\s)/, "");
    for (const match of content.matchAll(numberPattern)) {
      if (match[1]) numbers.push(normalizeNumber(match[1]));
    }
  }
  return numbers;
}

export interface ClaimContext {
  numbers: Set<string>;
  factIds: Set<string>;
}

/** Collect every number a draft is allowed to use: from commits, diffs, tags and git statistics. */
export function buildClaimContext(
  collection: Collection,
  stories: ChangeStory[],
  milestones: Milestone[],
  extraNumbers: number[] = [],
): ClaimContext {
  const corpus: string[] = [];
  for (const commit of collection.commits) {
    corpus.push(commit.subject, commit.body);
    if (commit.prNumber) corpus.push(String(commit.prNumber));
    // Changed lines can support a claim ("timeout set to 3000"); hunk headers cannot.
    for (const line of commit.patch.split("\n")) {
      if (/^[+-](?![+-])/.test(line)) corpus.push(line);
    }
  }
  for (const tag of collection.tags) corpus.push(tag.name);
  // Story facts are model output, so they never count as evidence for numbers.
  for (const milestone of milestones) corpus.push(milestone.value, milestone.label);

  const numbers = new Set<string>();
  // "v1.4.0" in the sources supports "1.4.0" in a draft.
  const corpusText = corpus.join("\n").replace(/\bv(?=\d)/g, "");
  for (const value of extractNumbers(corpusText)) numbers.add(value);
  const { totals } = collection;
  const derived = [
    totals.commits,
    totals.additions,
    totals.deletions,
    totals.filesChanged,
    totals.additions + totals.deletions,
    stories.length,
    collection.tags.length,
    ...stories.map((story) => story.commitShas.length),
    ...extraNumbers,
  ];
  if (collection.lifetimeCommits !== null) derived.push(collection.lifetimeCommits);
  for (const value of derived) numbers.add(String(value));
  for (const iso of [collection.window.since, collection.window.until]) {
    const [year, month, day] = iso.slice(0, 10).split("-");
    for (const part of [year, month, day]) {
      if (part) {
        numbers.add(part);
        numbers.add(String(Number(part)));
      }
    }
  }
  return {
    numbers,
    factIds: new Set(stories.flatMap((story) => story.facts.map((fact) => fact.id))),
  };
}

/** Numbers this small are everyday wording ("一两个"、"2 个坑"), not checkable claims. */
const TRIVIAL_MAX = 2;

export function checkClaims(
  draft: Pick<Draft, "platform" | "title" | "body" | "hashtags" | "factIds">,
  context: ClaimContext,
): GuardIssue[] {
  const issues: GuardIssue[] = [];
  const text = [draft.title ?? "", draft.body, draft.hashtags.join(" ")].join("\n");
  const unsupported = new Set(unsupportedNumbers(text, context));
  if (unsupported.size > 0) {
    issues.push({
      code: "unsupported_number",
      severity: "error",
      message: `这些数字在提交记录里找不到依据：${[...unsupported].join("、")}。请删除或改成有依据的数字。`,
    });
  }
  if (containsSecret(text)) {
    issues.push({
      code: "secret_detected",
      severity: "error",
      message: "草稿里疑似包含密钥或令牌，发布前必须删除。",
    });
  }
  const unknown = draft.factIds.filter((id) => !context.factIds.has(id));
  if (unknown.length > 0) {
    issues.push({
      code: "unknown_fact",
      severity: "warning",
      message: `引用了不存在的事实：${unknown.join("、")}。`,
    });
  }
  if (context.factIds.size > 0 && draft.factIds.length === 0 && draft.platform !== "changelog") {
    issues.push({
      code: "no_facts",
      severity: "warning",
      message: "这份草稿没有标注依据的事实，请核对内容是否都来自本次提交。",
    });
  }
  return issues;
}

/** Numbers in a model-written fact that the commits do not support. */
export function unsupportedNumbers(text: string, context: ClaimContext): string[] {
  return extractNumbers(text).filter((value) => {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric <= TRIVIAL_MAX && !value.includes(".")) return false;
    return !context.numbers.has(value);
  });
}
