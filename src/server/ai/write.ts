import type {
  ChangeStory,
  Draft,
  Milestone,
  PlatformId,
  UsageSummary,
  VoiceProfile,
} from "../../shared/schemas.js";
import type { ClaimContext } from "../guards/claimGuard.js";
import { guardDraft, hasErrors } from "../guards/index.js";
import { AiError, type StructuredLlm } from "./llm.js";
import {
  WriteOutputSchema,
  buildRepairPrompt,
  buildWritePrompt,
  writeSystemPrompt,
  type WriteOutput,
} from "./prompts.js";

export interface WriteResult {
  drafts: Draft[];
  usage: UsageSummary[];
  repaired: boolean;
}

function toDrafts(
  output: WriteOutput,
  platforms: PlatformId[],
  context: ClaimContext,
): Map<PlatformId, Draft> {
  const drafts = new Map<PlatformId, Draft>();
  for (const item of output.drafts) {
    if (!platforms.includes(item.platform) || drafts.has(item.platform)) continue;
    drafts.set(
      item.platform,
      guardDraft(
        {
          platform: item.platform,
          title: item.title?.trim() || null,
          body: item.body.trim(),
          hashtags: item.hashtags.map((tag) => tag.replace(/^#+|#+$/g, "").trim()).filter(Boolean),
          factIds: [...new Set(item.factIds)],
          edited: false,
        },
        context,
      ),
    );
  }
  return drafts;
}

/**
 * Write drafts, check them, and give the model one chance to fix the drafts that failed.
 * Whatever still fails is returned with its issues so the UI can show what to fix.
 */
export async function writeDrafts(input: {
  llm: StructuredLlm;
  stories: ChangeStory[];
  dayHeadline: string | null;
  voice: VoiceProfile;
  platforms: PlatformId[];
  milestones: Milestone[];
  context: ClaimContext;
  repoLabel: string;
  productContext: string | null;
}): Promise<WriteResult> {
  const prompt = buildWritePrompt({
    stories: input.stories,
    dayHeadline: input.dayHeadline,
    voice: input.voice,
    platforms: input.platforms,
    allowedNumbers: [...input.context.numbers].sort((a, b) => Number(a) - Number(b)),
    milestones: input.milestones,
    repoLabel: input.repoLabel,
    productContext: input.productContext,
  });
  const usage: UsageSummary[] = [];
  const first = await input.llm.generate({
    label: "write",
    system: writeSystemPrompt,
    user: prompt,
    schema: WriteOutputSchema,
    maxTokens: 12000,
  });
  usage.push(first.usage);
  const drafts = toDrafts(first.data, input.platforms, input.context);

  const failing = [...drafts.values()].filter(hasErrors);
  let repaired = false;
  if (failing.length > 0) {
    let retry;
    try {
      retry = await input.llm.generate({
        label: "repair",
        system: writeSystemPrompt,
        user: buildRepairPrompt(prompt, failing),
        schema: WriteOutputSchema,
        maxTokens: 12000,
      });
    } catch (error) {
      // A failed repair keeps the first drafts; their issues are already attached.
      if (error instanceof AiError)
        return { drafts: orderDrafts(drafts, input.platforms), usage, repaired: false };
      throw error;
    }
    usage.push(retry.usage);
    const fixed = toDrafts(
      retry.data,
      failing.map((draft) => draft.platform),
      input.context,
    );
    for (const [platform, draft] of fixed) {
      const previous = drafts.get(platform);
      // Keep the repaired version unless it is worse than the original.
      if (!previous || draft.issues.length <= previous.issues.length) drafts.set(platform, draft);
    }
    repaired = true;
  }

  return { drafts: orderDrafts(drafts, input.platforms), usage, repaired };
}

function orderDrafts(drafts: Map<PlatformId, Draft>, platforms: PlatformId[]): Draft[] {
  return platforms
    .map((platform) => drafts.get(platform))
    .filter((draft): draft is Draft => draft !== undefined);
}
