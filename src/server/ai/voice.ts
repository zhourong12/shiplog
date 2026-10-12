import { VoiceProfileSchema, type UsageSummary, type VoiceProfile } from "../../shared/schemas.js";
import { redactSecrets } from "../prep/redact.js";
import type { StructuredLlm } from "./llm.js";
import { buildVoicePrompt, voiceSystemPrompt } from "./prompts.js";

export const MAX_VOICE_SAMPLES = 10;
export const MAX_VOICE_SAMPLE_CHARS = 2000;

/** Split pasted posts on blank-line separators ("---" lines or two empty lines). */
export function splitSamples(text: string): string[] {
  return text
    .split(/\n\s*---+\s*\n|\n\s*\n\s*\n/)
    .map((sample) => sample.trim())
    .filter((sample) => sample.length >= 10)
    .slice(0, MAX_VOICE_SAMPLES)
    .map((sample) => sample.slice(0, MAX_VOICE_SAMPLE_CHARS));
}

export async function learnVoice(
  llm: StructuredLlm,
  samples: string[],
): Promise<{ profile: VoiceProfile; usage: UsageSummary }> {
  const cleaned = samples.map((sample) => redactSecrets(sample).text);
  const result = await llm.generate({
    label: "voice",
    system: voiceSystemPrompt,
    user: buildVoicePrompt(cleaned),
    schema: VoiceProfileSchema,
    maxTokens: 3000,
  });
  return { profile: result.data, usage: result.usage };
}
