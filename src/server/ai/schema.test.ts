import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { describe, expect, it } from "vitest";
import { VoiceProfileSchema } from "../../shared/schemas.js";
import { UnderstandOutputSchema, WriteOutputSchema } from "./prompts.js";

describe("structured output schemas", () => {
  it.each([
    ["understand", UnderstandOutputSchema],
    ["write", WriteOutputSchema],
    ["voice", VoiceProfileSchema],
  ])("%s converts to a strict JSON schema", (_name, schema) => {
    const format = betaZodOutputFormat(schema);
    const json = JSON.stringify(format);
    expect(json).toContain('"additionalProperties":false');
    // Structured outputs reject numeric range keywords.
    expect(json).not.toMatch(/"(minimum|maximum|multipleOf)"/);
  });
});
