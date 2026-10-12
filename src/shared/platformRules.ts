import type { Draft, GuardIssue, PlatformId } from "./schemas.js";

export interface PlatformSpec {
  id: PlatformId;
  label: string;
  titleRequired: boolean;
  titleMax: number | null;
  /** Hard limit; exceeding it is an error. */
  bodyMax: number | null;
  /** Soft limit; exceeding it is a warning. */
  bodySoftMax: number | null;
  hashtagMax: number | null;
  /** X counts weighted characters per post and threads posts; others count characters. */
  thread: { partMax: number; maxParts: number } | null;
  /** What the writer should aim for, in the model prompt. */
  styleHint: string;
}

/**
 * Publishing rules as published by each platform (checked 2026-10). Platforms change these;
 * keep them in one place so a change is a one-line edit.
 */
export const platformSpecs: Record<PlatformId, PlatformSpec> = {
  jike: {
    id: "jike",
    label: "即刻",
    titleRequired: false,
    titleMax: null,
    bodyMax: 2000,
    bodySoftMax: 500,
    hashtagMax: 3,
    thread: null,
    styleHint: "像发给朋友的近况：口语、短段落、一两个细节，结尾可以抛一个问题。不需要标题。",
  },
  xiaohongshu: {
    id: "xiaohongshu",
    label: "小红书",
    titleRequired: true,
    titleMax: 20,
    bodyMax: 1000,
    bodySoftMax: 600,
    hashtagMax: 10,
    thread: null,
    styleHint:
      "标题抓眼球但不夸张（20 字以内）；正文分段、可用少量 emoji 做小标题；会配一张开发数据卡图片；末尾给 3-6 个话题标签。",
  },
  x: {
    id: "x",
    label: "X",
    titleRequired: false,
    titleMax: null,
    bodyMax: null,
    bodySoftMax: null,
    hashtagMax: 2,
    thread: { partMax: 280, maxParts: 6 },
    styleHint:
      "build in public 风格的推文串：第一条就讲清楚做成了什么；多条之间用单独一行 --- 分隔；每条不超过 280 加权字符（中文算 2）。",
  },
  v2ex: {
    id: "v2ex",
    label: "V2EX 分享创造",
    titleRequired: true,
    titleMax: 120,
    bodyMax: 20000,
    bodySoftMax: 3000,
    hashtagMax: 0,
    thread: null,
    styleHint:
      "朴素、技术向的 Markdown 帖子：做了什么、怎么做的、踩了什么坑、欢迎反馈。不用话题标签。",
  },
  changelog: {
    id: "changelog",
    label: "更新日志",
    titleRequired: true,
    titleMax: 80,
    bodyMax: null,
    bodySoftMax: null,
    hashtagMax: 0,
    thread: null,
    styleHint:
      "面向用户的 Markdown 更新日志：按“新功能 / 改进 / 修复”分组，每条一句话，写用户能感知到的变化。",
  },
  producthunt: {
    id: "producthunt",
    label: "Product Hunt",
    titleRequired: true,
    titleMax: 60,
    bodyMax: 260,
    bodySoftMax: null,
    hashtagMax: 0,
    thread: null,
    styleHint:
      "英文。title 是不超过 60 字符的 tagline；body 是不超过 260 字符的产品描述，突出这次更新带来的价值。",
  },
};

export const THREAD_SEPARATOR = /\n\s*---\s*\n/;

export function splitThread(body: string): string[] {
  return body
    .split(THREAD_SEPARATOR)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function charCount(text: string): number {
  return [...text].length;
}

const urlPattern = /https?:\/\/[^\s]+/g;
const lightWeightRanges: Array<[number, number]> = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247],
];
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const emojiPattern = /\p{Extended_Pictographic}/u;

/**
 * X ("twitter-text" v3) weighted length: URLs count 23, emoji count 2, CJK and most
 * non-Latin characters count 2, Latin characters count 1.
 */
export function xWeightedLength(text: string): number {
  let total = 0;
  const withoutUrls = text.replace(urlPattern, () => {
    total += 23;
    return "";
  });
  for (const { segment } of segmenter.segment(withoutUrls)) {
    if (emojiPattern.test(segment)) {
      total += 2;
      continue;
    }
    for (const char of segment) {
      const code = char.codePointAt(0) ?? 0;
      const light = lightWeightRanges.some(([start, end]) => code >= start && code <= end);
      total += light ? 1 : 2;
    }
  }
  return total;
}

function formatHashtag(tag: string, platform: PlatformId): string {
  const clean = tag.replace(/^#+/, "").trim();
  // 小红书 topics close with a trailing #; other platforms use a single leading #.
  return platform === "xiaohongshu" ? `#${clean}#` : `#${clean}`;
}

/** Text that will actually be posted: body plus hashtags where the platform uses them. */
export function composeText(draft: Pick<Draft, "platform" | "body" | "hashtags">): string {
  const spec = platformSpecs[draft.platform];
  const tags =
    spec.hashtagMax === 0 ? [] : draft.hashtags.map((tag) => formatHashtag(tag, draft.platform));
  if (tags.length === 0) return draft.body.trim();
  return `${draft.body.trim()}\n\n${tags.join(" ")}`;
}

export function checkPlatformRules(
  draft: Pick<Draft, "platform" | "title" | "body" | "hashtags">,
): GuardIssue[] {
  const spec = platformSpecs[draft.platform];
  const issues: GuardIssue[] = [];
  const title = draft.title?.trim() ?? "";
  if (!draft.body.trim()) {
    issues.push({ code: "empty", severity: "error", message: "正文为空。" });
    return issues;
  }
  if (spec.titleRequired && !title) {
    issues.push({ code: "title_missing", severity: "error", message: `${spec.label}需要标题。` });
  }
  if (spec.titleMax !== null && charCount(title) > spec.titleMax) {
    issues.push({
      code: "title_too_long",
      severity: "error",
      message: `标题 ${charCount(title)} 字，超过${spec.label}的 ${spec.titleMax} 字上限。`,
    });
  }
  if (spec.hashtagMax !== null && draft.hashtags.length > spec.hashtagMax) {
    issues.push({
      code: "too_many_hashtags",
      severity: "warning",
      message: `话题标签 ${draft.hashtags.length} 个，${spec.label}建议不超过 ${spec.hashtagMax} 个。`,
    });
  }
  if (spec.thread) {
    const parts = splitThread(composeText(draft));
    if (parts.length > spec.thread.maxParts) {
      issues.push({
        code: "too_many_parts",
        severity: "warning",
        message: `推文串共 ${parts.length} 条，建议不超过 ${spec.thread.maxParts} 条。`,
      });
    }
    parts.forEach((part, index) => {
      const weighted = xWeightedLength(part);
      if (weighted > spec.thread!.partMax) {
        issues.push({
          code: "too_long",
          severity: "error",
          message: `第 ${index + 1} 条推文 ${weighted} 加权字符，超过 ${spec.thread!.partMax} 上限。`,
        });
      }
    });
    return issues;
  }
  const length = charCount(composeText(draft));
  if (spec.bodyMax !== null && length > spec.bodyMax) {
    issues.push({
      code: "too_long",
      severity: "error",
      message: `正文 ${length} 字，超过${spec.label}的 ${spec.bodyMax} 字上限。`,
    });
  } else if (spec.bodySoftMax !== null && length > spec.bodySoftMax) {
    issues.push({
      code: "too_long",
      severity: "warning",
      message: `正文 ${length} 字，${spec.label}上建议控制在 ${spec.bodySoftMax} 字以内。`,
    });
  }
  return issues;
}

/** Where the user finishes posting. Only X supports a prefilled compose link. */
export function composeUrl(draft: Pick<Draft, "platform" | "body" | "hashtags">): string | null {
  switch (draft.platform) {
    case "x": {
      const first = splitThread(composeText(draft))[0] ?? "";
      return `https://x.com/intent/post?text=${encodeURIComponent(first)}`;
    }
    case "jike":
      return "https://web.okjike.com/";
    case "xiaohongshu":
      return "https://creator.xiaohongshu.com/publish/publish";
    case "v2ex":
      return "https://www.v2ex.com/write";
    case "producthunt":
      return "https://www.producthunt.com/posts/new";
    case "changelog":
      return null;
  }
}
