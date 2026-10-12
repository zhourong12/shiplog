#!/usr/bin/env node
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { defaultVoiceProfile, platformIds, type PlatformId } from "../shared/schemas.js";
import { AnthropicLlm, configuredModel, isAiConfigured } from "../server/ai/llm.js";
import { buildUnderstandPrompt } from "../server/ai/prompts.js";
import { renderStatsCard } from "../server/cards/statsCard.js";
import {
  composeText,
  platformSpecs,
  splitThread,
  xWeightedLength,
} from "../server/guards/platformRules.js";
import {
  buildActivity,
  changeBreakdown,
  currentStreak,
  detectMilestones,
} from "../server/insights.js";
import { runPipeline } from "../server/pipeline.js";
import { finalizeCollection } from "../server/sources/collect.js";
import { collectLocalGit, localCommitDays } from "../server/sources/localGit.js";
import { HttpError } from "../server/services/errors.js";
import { parseSince, validateWindow } from "../server/services/window.js";

const help = `ShipLog 码上说 —— 把 git 提交写成开发日记

用法：
  shiplog draft     [--repo .] [--since 24h] [--until <ISO>] [--platforms jike,x] [--context "一句话介绍"] [--json]
  shiplog changelog [--repo .] [--since 7d]
  shiplog preview   [--repo .] [--since 24h]     显示将发送给 AI 的内容（已过滤、已脱敏），不调用 AI
  shiplog card      [--repo .] [--since 7d] [--out shiplog-card.svg] [--theme light|dark]

时间可以写 24h、3d、1w，或 ISO 日期。未设置 ANTHROPIC_API_KEY 时 draft 只输出更新日志。
平台：${platformIds.join(", ")}`;

function fail(message: string): never {
  console.error(`错误：${message}`);
  process.exit(1);
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: "string", default: "." },
      since: { type: "string" },
      until: { type: "string" },
      platforms: { type: "string", default: "jike,x,changelog" },
      context: { type: "string" },
      json: { type: "boolean", default: false },
      out: { type: "string", default: "shiplog-card.svg" },
      theme: { type: "string", default: "light" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const command = positionals[0];
  if (!command || values.help) {
    console.log(help);
    return;
  }

  const now = new Date();
  const since = parseSince(
    values.since ?? (command === "changelog" || command === "card" ? "7d" : "24h"),
    now,
  );
  const until = values.until ? parseSince(values.until, now) : now;
  const window = validateWindow(since.toISOString(), until.toISOString());
  const collection = finalizeCollection(await collectLocalGit({ repoPath: values.repo, window }));
  const today = now.toISOString().slice(0, 10);
  const days = await localCommitDays(
    values.repo,
    new Date(now.getTime() - 90 * 86_400_000).toISOString(),
  );
  const commitStreak = currentStreak(Object.keys(days), today);
  const recent = buildActivity(days, new Set(), today, 14);

  if (command === "preview") {
    console.log(
      buildUnderstandPrompt(collection, detectMilestones(collection), values.context ?? null, "zh"),
    );
    console.error(
      `\n— ${collection.totals.commits} 次提交；已排除 ${collection.excludedFileCount} 个文件；脱敏 ${collection.redactionCount} 处。`,
    );
    return;
  }

  if (command === "card") {
    const svg = renderStatsCard({
      repoLabel: collection.repoLabel,
      windowLabel: `${window.since.slice(0, 10)} ~ ${window.until.slice(0, 10)}`,
      totals: collection.totals,
      breakdown: changeBreakdown(collection),
      activity: recent,
      commitStreak,
      theme: values.theme === "dark" ? "dark" : "light",
    });
    writeFileSync(values.out, svg);
    console.log(`数据卡已写入 ${values.out}`);
    return;
  }

  if (command !== "draft" && command !== "changelog")
    fail(`未知命令 ${command}。运行 shiplog --help 查看用法。`);

  const platforms = (values.platforms ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const invalid = platforms.filter((item) => !(platformIds as readonly string[]).includes(item));
  if (invalid.length > 0) fail(`不支持的平台：${invalid.join(", ")}`);

  const llm =
    command === "draft" && isAiConfigured() ? new AnthropicLlm({ model: configuredModel() }) : null;
  const result = await runPipeline({
    collection,
    platforms: platforms as PlatformId[],
    voice: defaultVoiceProfile,
    productContext: values.context ?? null,
    llm,
    baselineReason: command === "changelog" ? "仅生成更新日志。" : undefined,
    repoId: null,
    activity: { recent, commitStreak },
  });

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.mode === "baseline" || command === "changelog") {
    if (result.baselineReason && command === "draft")
      console.error(`提示：${result.baselineReason}\n`);
    console.log(result.changelog);
    return;
  }
  console.log(`# ${result.dayHeadline ?? collection.repoLabel}\n`);
  for (const draft of result.drafts) {
    const spec = platformSpecs[draft.platform];
    const status = draft.status === "ok" ? "✓ 通过检查" : "⚠ 需要人工修改";
    console.log(`## ${spec.label}（${status}）`);
    if (draft.title) console.log(`标题：${draft.title}`);
    const text = composeText(draft);
    console.log(text);
    if (spec.thread) {
      console.log(
        `（${splitThread(text)
          .map((part) => xWeightedLength(part))
          .join(" / ")} 加权字符）`,
      );
    }
    for (const issue of draft.issues)
      console.log(`  ${issue.severity === "error" ? "✗" : "!"} ${issue.message}`);
    console.log("");
  }
  const cost = result.usage.reduce((sum, item) => sum + (item.costUsd ?? 0), 0);
  console.error(`本次调用 ${result.usage.length} 次模型，约 $${cost.toFixed(4)}。`);
}

main().catch((error: unknown) => {
  if (error instanceof HttpError) fail(error.message);
  fail(error instanceof Error ? error.message : String(error));
});
