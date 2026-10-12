import type { Draft } from "../../shared/schemas.js";
import { checkClaims, type ClaimContext } from "./claimGuard.js";
import { checkPlatformRules } from "../../shared/platformRules.js";

/** Run every deterministic check and set the draft status from the result. */
export function guardDraft(draft: Omit<Draft, "issues" | "status">, context: ClaimContext): Draft {
  const issues = [...checkPlatformRules(draft), ...checkClaims(draft, context)];
  const status = issues.some((issue) => issue.severity === "error") ? "needs_review" : "ok";
  return { ...draft, issues, status };
}

export function hasErrors(draft: Draft): boolean {
  return draft.issues.some((issue) => issue.severity === "error");
}
