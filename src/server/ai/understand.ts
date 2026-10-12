import type {
  ChangeStory,
  Collection,
  Milestone,
  UsageSummary,
  VoiceProfile,
} from "../../shared/schemas.js";
import { unsupportedNumbers, type ClaimContext } from "../guards/claimGuard.js";
import type { StructuredLlm } from "./llm.js";
import {
  UnderstandOutputSchema,
  buildUnderstandPrompt,
  understandSystemPrompt,
  type UnderstandOutput,
} from "./prompts.js";

export interface UnderstandResult {
  dayHeadline: string;
  stories: ChangeStory[];
  droppedFacts: number;
  usage: UsageSummary;
}

/** Map a SHA from the model (full or abbreviated) to a commit in the collection. */
function resolveSha(candidate: string, shas: string[]): string | null {
  const value = candidate.trim().toLowerCase();
  if (value.length < 7) return null;
  return shas.find((sha) => sha.toLowerCase().startsWith(value)) ?? null;
}

/**
 * Keep only what the commits support: unknown SHAs are dropped, and facts without a
 * valid source or with numbers the commits do not contain are removed.
 */
export function normalizeStories(
  output: UnderstandOutput,
  collection: Collection,
  context: ClaimContext,
): { stories: ChangeStory[]; droppedFacts: number } {
  const shas = collection.commits.map((commit) => commit.sha);
  let droppedFacts = 0;
  let factCounter = 0;
  const stories: ChangeStory[] = [];
  output.stories.forEach((story, index) => {
    const commitShas = [
      ...new Set(
        story.commitShas
          .map((sha) => resolveSha(sha, shas))
          .filter((sha): sha is string => sha !== null),
      ),
    ];
    if (commitShas.length === 0) return;
    const facts = story.facts.flatMap((fact) => {
      const sourceShas = [
        ...new Set(
          fact.sourceShas
            .map((sha) => resolveSha(sha, shas))
            .filter((sha): sha is string => sha !== null),
        ),
      ];
      if (sourceShas.length === 0 || unsupportedNumbers(fact.text, context).length > 0) {
        droppedFacts += 1;
        return [];
      }
      factCounter += 1;
      return [{ id: `f${factCounter}`, text: fact.text.trim(), sourceShas }];
    });
    stories.push({
      id: `s${index + 1}`,
      title: story.title.trim(),
      kind: story.kind,
      userFacing: story.userFacing,
      shareability: story.shareability,
      summary: story.summary.trim(),
      angle: story.angle.trim(),
      commitShas,
      facts,
    });
  });
  const order = { high: 0, medium: 1, low: 2, skip: 3 } as const;
  stories.sort((a, b) => order[a.shareability] - order[b.shareability]);
  return { stories, droppedFacts };
}

export async function understandCommits(input: {
  llm: StructuredLlm;
  collection: Collection;
  milestones: Milestone[];
  productContext: string | null;
  language: VoiceProfile["language"];
  context: ClaimContext;
}): Promise<UnderstandResult> {
  const result = await input.llm.generate({
    label: "understand",
    system: understandSystemPrompt,
    user: buildUnderstandPrompt(
      input.collection,
      input.milestones,
      input.productContext,
      input.language,
    ),
    schema: UnderstandOutputSchema,
    maxTokens: 8000,
  });
  const normalized = normalizeStories(result.data, input.collection, input.context);
  return {
    dayHeadline: result.data.dayHeadline.trim(),
    stories: normalized.stories,
    droppedFacts: normalized.droppedFacts,
    usage: result.usage,
  };
}
