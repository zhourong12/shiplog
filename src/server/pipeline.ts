import { randomUUID } from "node:crypto";
import type {
  ActivityDay,
  Collection,
  GenerationResult,
  PlatformId,
  UsageSummary,
  VoiceProfile,
} from "../shared/schemas.js";
import { pickSnippet } from "./cards/codeCard.js";
import { understandCommits } from "./ai/understand.js";
import { AiError, type StructuredLlm } from "./ai/llm.js";
import { writeDrafts } from "./ai/write.js";
import { buildBaselineChangelog } from "./baseline/changelog.js";
import { buildClaimContext } from "./guards/claimGuard.js";
import { changeBreakdown, detectMilestones } from "./insights.js";

export interface PipelineInput {
  collection: Collection;
  platforms: PlatformId[];
  voice: VoiceProfile;
  productContext: string | null;
  /** Null runs the AI-free baseline. */
  llm: StructuredLlm | null;
  /** Business-language reason shown when llm is null. */
  baselineReason?: string;
  repoId: number | null;
  /** Recent commit activity (oldest first) and the current streak, when the caller has them. */
  activity?: { recent: ActivityDay[]; commitStreak: number };
  now?: Date;
}

/**
 * collect (done by the caller) → baseline changelog and milestones → understand → write
 * → deterministic checks → one repair round. The baseline is always produced, so a failed
 * or unconfigured AI step still leaves the user with something true and useful.
 */
export async function runPipeline(input: PipelineInput): Promise<GenerationResult> {
  const { collection } = input;
  const milestones = detectMilestones(collection);
  const changelog = buildBaselineChangelog(collection);
  const commitStreak = input.activity?.commitStreak ?? 0;
  const extraNumbers = commitStreak > 0 ? [commitStreak] : [];
  const baseContext = buildClaimContext(collection, [], milestones, extraNumbers);
  const base: GenerationResult = {
    id: randomUUID(),
    repoId: input.repoId,
    repoLabel: collection.repoLabel,
    createdAt: (input.now ?? new Date()).toISOString(),
    mode: "baseline",
    baselineReason: null,
    window: collection.window,
    totals: collection.totals,
    truncated: collection.truncated,
    excludedFileCount: collection.excludedFileCount,
    redactionCount: collection.redactionCount,
    milestones,
    dayHeadline: null,
    stories: [],
    drafts: [],
    changelog,
    commits: collection.commits.map((commit) => ({
      sha: commit.sha,
      shortSha: commit.shortSha,
      subject: commit.subject,
      authoredAt: commit.authoredAt,
      prNumber: commit.prNumber,
      url: commit.url,
      snippet: pickSnippet(commit),
    })),
    breakdown: changeBreakdown(collection),
    recentActivity: input.activity?.recent.slice(-14) ?? [],
    commitStreak,
    claimNumbers: sortedNumbers(baseContext.numbers),
    usage: [],
  };

  if (!input.llm) {
    return {
      ...base,
      baselineReason: input.baselineReason ?? "未配置 AI，仅生成更新日志和数据卡。",
    };
  }
  if (collection.commits.length === 0) {
    return { ...base, baselineReason: "这段时间没有新的提交，未调用 AI。" };
  }

  const usage: UsageSummary[] = [];
  try {
    return await runAiSteps(input, base, baseContext, usage);
  } catch (error) {
    if (!(error instanceof AiError)) throw error;
    // Keep the baseline and whatever the failed attempt cost, and say what happened.
    return {
      ...base,
      baselineReason: `AI 生成失败：${error.message}已保留更新日志和数据卡。`,
      usage,
    };
  }
}

async function runAiSteps(
  input: PipelineInput,
  base: GenerationResult,
  baseContext: ReturnType<typeof buildClaimContext>,
  usage: UsageSummary[],
): Promise<GenerationResult> {
  const llm = input.llm!;
  const { collection } = input;
  const milestones = base.milestones;
  const understood = await understandCommits({
    llm,
    collection,
    milestones,
    productContext: input.productContext,
    language: input.voice.language,
    context: baseContext,
  });
  usage.push(understood.usage);

  const context = buildClaimContext(
    collection,
    understood.stories,
    milestones,
    base.commitStreak > 0 ? [base.commitStreak] : [],
  );
  const shareable = understood.stories.filter((story) => story.shareability !== "skip");
  const written = await writeDrafts({
    llm,
    stories: shareable.length > 0 ? shareable : understood.stories,
    dayHeadline: understood.dayHeadline,
    voice: input.voice,
    platforms: input.platforms,
    milestones,
    context,
    repoLabel: collection.repoLabel,
    productContext: input.productContext,
  });
  usage.push(...written.usage);

  return {
    ...base,
    mode: "ai",
    dayHeadline: understood.dayHeadline,
    stories: understood.stories,
    drafts: written.drafts,
    usage,
  };
}

function sortedNumbers(numbers: Set<string>): string[] {
  return [...numbers].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
}
