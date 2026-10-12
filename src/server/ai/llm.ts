import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import type { UsageSummary } from "../../shared/schemas.js";

export type AiErrorCode =
  | "ai_not_configured"
  | "ai_auth"
  | "ai_rate_limited"
  | "ai_timeout"
  | "ai_network"
  | "ai_refused"
  | "ai_truncated"
  | "ai_invalid_output"
  | "ai_upstream";

export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AiError";
  }
}

export interface StructuredRequest<T> {
  /** Static instructions; cached across requests. Keep volatile data out of it. */
  system: string;
  /** Per-request data. */
  user: string;
  schema: z.ZodType<T>;
  maxTokens: number;
  label: string;
}

export interface StructuredResult<T> {
  data: T;
  usage: UsageSummary;
}

/** The only thing the pipeline needs from a model. Tests inject a fake. */
export interface StructuredLlm {
  readonly model: string;
  generate<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

/** USD per million tokens (first-party API list prices, 2026-10). */
const pricing: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
};

export function estimateCostUsd(
  model: string,
  usage: Omit<UsageSummary, "model" | "costUsd">,
): number | null {
  const price = pricing[model];
  if (!price) return null;
  const cacheWritePrice = price.input * 1.25;
  const cost =
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.cacheRead +
      usage.cacheWriteTokens * cacheWritePrice) /
    1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AnthropicLlmOptions {
  apiKey?: string;
  model?: string;
  effort?: Effort;
  client?: Anthropic;
}

export function isAiConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.SHIPLOG_AI_ENABLED === "true",
  );
}

export function configuredModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.SHIPLOG_MODEL?.trim() || "claude-opus-5-5";
}

function configuredEffort(env: NodeJS.ProcessEnv = process.env): Effort {
  const value = env.SHIPLOG_EFFORT?.trim();
  return value === "low" || value === "high" || value === "xhigh" || value === "max"
    ? value
    : "medium";
}

function mapError(error: unknown): AiError {
  if (error instanceof AiError) return error;
  if (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError
  ) {
    return new AiError("ai_auth", "Claude API Key 无效或没有权限。");
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new AiError("ai_rate_limited", "Claude 调用过于频繁，请稍后再试。");
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new AiError("ai_timeout", "Claude 响应超时，请稍后重试。");
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new AiError("ai_network", "无法连接 Claude 服务。");
  }
  if (error instanceof Anthropic.BadRequestError) {
    return new AiError("ai_upstream", "Claude 拒绝了这次请求的参数，请检查模型配置。");
  }
  if (error instanceof Anthropic.APIError) {
    return new AiError("ai_upstream", `Claude 服务暂时不可用（${error.status ?? "未知状态"}）。`);
  }
  return new AiError("ai_upstream", "调用 Claude 时出现未知错误。");
}

/**
 * Claude via the official SDK: structured outputs validated by Zod, cached system prompt,
 * server-side refusal fallback, and explicit handling of refusal / max_tokens stops.
 */
export class AnthropicLlm implements StructuredLlm {
  readonly model: string;
  private readonly effort: Effort;
  private readonly client: Anthropic;

  constructor(options: AnthropicLlmOptions = {}) {
    this.model = options.model ?? configuredModel();
    this.effort = options.effort ?? configuredEffort();
    this.client =
      options.client ??
      new Anthropic({
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        timeout: 60_000,
        maxRetries: 2,
      });
  }

  async generate<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    let message;
    try {
      message = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: request.maxTokens,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: this.effort, format: betaZodOutputFormat(request.schema) },
        system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: request.user }],
      });
    } catch (error) {
      throw mapError(error);
    }
    if (message.stop_reason === "refusal") {
      throw new AiError("ai_refused", "Claude 拒绝处理这段内容，请检查提交信息里是否有异常内容。");
    }
    if (message.stop_reason === "max_tokens") {
      throw new AiError("ai_truncated", "生成内容过长被截断，请缩小时间范围后重试。");
    }
    const data = message.parsed_output;
    if (data === null || data === undefined) {
      throw new AiError("ai_invalid_output", "Claude 返回的结构不符合预期。");
    }
    // The fallback chain may serve the request on another model; bill by what actually ran.
    const servedModel = message.model ?? this.model;
    const usage = {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
    };
    return {
      data: data as T,
      usage: { model: servedModel, ...usage, costUsd: estimateCostUsd(servedModel, usage) },
    };
  }
}
