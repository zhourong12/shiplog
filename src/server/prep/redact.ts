/**
 * Secret redaction for anything that is sent to the model or shown in a draft.
 * The patterns favour recall: a false positive costs a "[已脱敏]" marker in a diff,
 * a false negative leaks a credential to a third party.
 */

interface SecretRule {
  kind: string;
  pattern: RegExp;
  /** Index of the capture group to replace; whole match when omitted. */
  group?: number;
}

const rules: SecretRule[] = [
  {
    kind: "private_key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  { kind: "aws_access_key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { kind: "github_token", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { kind: "anthropic_key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "openai_style_key", pattern: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "stripe_key", pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { kind: "slack_token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  {
    kind: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    kind: "url_credentials",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]{3,})(@)/gi,
    group: 2,
  },
  {
    kind: "assignment",
    pattern:
      /\b((?:[A-Za-z0-9_]*?)(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth)[A-Za-z0-9_]*\s*[:=]\s*["'`]?)((?![^\s"'`,;]*\()[^\s"'`,;()]{8,})/gi,
    group: 2,
  },
];

/** Values that look like references or placeholders rather than real secrets. */
const placeholderPattern =
  /^(?:process\.env|os\.environ|import\.meta\.env|env\.|\$\{|\$\(|<|%|\{\{|your[-_]|example|changeme|placeholder|xxx+|\*{3,}|replace[-_]?me|undefined|null|true|false|redacted|\[已脱敏)/i;

export const REDACTED = "[已脱敏]";

/**
 * Unquoted right-hand sides such as `response.data.token` or `accessToken` are code, not
 * secrets. Real credentials almost always contain digits, so letters-only identifiers and
 * member expressions are left alone.
 */
function looksLikeCode(value: string): boolean {
  return (
    /^[A-Za-z_$][A-Za-z_$]*$/.test(value) || /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(value)
  );
}

export interface RedactionResult {
  text: string;
  count: number;
  kinds: string[];
}

export function redactSecrets(input: string): RedactionResult {
  let text = input;
  let count = 0;
  const kinds = new Set<string>();
  for (const rule of rules) {
    text = text.replace(rule.pattern, (...args: unknown[]) => {
      const match = String(args[0]);
      if (rule.group === undefined) {
        count += 1;
        kinds.add(rule.kind);
        return REDACTED;
      }
      const groups = args.slice(1, -2).map((value) => (value === undefined ? "" : String(value)));
      const secret = groups[rule.group - 1] ?? "";
      if (!secret || placeholderPattern.test(secret) || secret.includes(REDACTED)) return match;
      if (rule.kind === "assignment" && !/["'`]$/.test(groups[0] ?? "") && looksLikeCode(secret)) {
        return match;
      }
      count += 1;
      kinds.add(rule.kind);
      return groups.map((value, index) => (index === rule.group! - 1 ? REDACTED : value)).join("");
    });
  }
  return { text, count, kinds: [...kinds] };
}

export function containsSecret(input: string): boolean {
  return redactSecrets(input).count > 0;
}
