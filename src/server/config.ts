import { dirname, join, resolve } from "node:path";
import type { Plan } from "../shared/schemas.js";
import { configuredModel, isAiConfigured } from "./ai/llm.js";

export interface GithubOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** github.com, or a GitHub Enterprise host. */
  oauthBaseUrl: string;
}

export interface StripeConfig {
  secretKey: string;
  priceId: string;
  webhookSecret: string;
}

export interface SmtpConfig {
  url: string;
  from: string;
}

export interface AppConfig {
  port: number;
  host: string;
  /** Where users reach the app; used for OAuth and payment redirects and links in emails. */
  publicBaseUrl: string;
  dbPath: string;
  keyFilePath: string;
  /**
   * "local": one implicit user, optional SHIPLOG_APP_TOKEN, local repositories allowed.
   * "github": multi-user SaaS with GitHub login; local repositories are always disabled.
   */
  authMode: "local" | "github";
  github: GithubOAuthConfig | null;
  stripe: StripeConfig | null;
  smtp: SmtpConfig | null;
  /** Plan of the local user in local mode. In GitHub mode the plan comes from billing. */
  plan: Plan;
  appToken: string | null;
  /** Empty means local repositories are disabled. */
  localRoots: string[];
  githubApiBaseUrl: string;
  aiConfigured: boolean;
  model: string;
  schedulerEnabled: boolean;
  isProduction: boolean;
}

function trimmed(value: string | undefined): string | null {
  const result = value?.trim();
  return result ? result : null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): AppConfig {
  const isProduction = env.NODE_ENV === "production";
  const port = Number(env.PORT) || 8792;
  const dbPath = resolve(cwd, trimmed(env.SHIPLOG_DB_PATH) ?? "var/shiplog.db");
  const roots = env.SHIPLOG_LOCAL_ROOTS?.split(",")
    .map((root) => root.trim())
    .filter(Boolean)
    .map((root) => resolve(cwd, root));

  const clientId = trimmed(env.GITHUB_CLIENT_ID);
  const clientSecret = trimmed(env.GITHUB_CLIENT_SECRET);
  const github =
    clientId && clientSecret
      ? {
          clientId,
          clientSecret,
          oauthBaseUrl: trimmed(env.GITHUB_OAUTH_BASE_URL) ?? "https://github.com",
        }
      : null;
  const authMode = github ? "github" : "local";

  const stripeKey = trimmed(env.STRIPE_SECRET_KEY);
  const stripePrice = trimmed(env.STRIPE_PRICE_ID);
  const stripeWebhook = trimmed(env.STRIPE_WEBHOOK_SECRET);
  const smtpUrl = trimmed(env.SMTP_URL);

  return {
    port,
    host: trimmed(env.HOST) ?? "127.0.0.1",
    publicBaseUrl: (trimmed(env.PUBLIC_BASE_URL) ?? `http://127.0.0.1:${port}`).replace(/\/$/, ""),
    dbPath,
    keyFilePath: join(dirname(dbPath), ".encryption-key"),
    authMode,
    github,
    stripe:
      stripeKey && stripePrice && stripeWebhook
        ? { secretKey: stripeKey, priceId: stripePrice, webhookSecret: stripeWebhook }
        : null,
    smtp: smtpUrl
      ? { url: smtpUrl, from: trimmed(env.SMTP_FROM) ?? "ShipLog <no-reply@localhost>" }
      : null,
    plan: env.SHIPLOG_PLAN === "pro" ? "pro" : "free",
    appToken: trimmed(env.SHIPLOG_APP_TOKEN),
    // A multi-user server must never read its own filesystem on behalf of users.
    // Local development defaults to sibling folders of the working directory.
    localRoots:
      authMode === "github" ? [] : (roots ?? (isProduction ? [] : [dirname(resolve(cwd))])),
    githubApiBaseUrl: trimmed(env.GITHUB_API_BASE_URL) ?? "https://api.github.com",
    aiConfigured: isAiConfigured(env),
    model: configuredModel(env),
    schedulerEnabled: env.SHIPLOG_SCHEDULER !== "off",
    isProduction,
  };
}

/**
 * Settings that would only fail later, at a bad moment (a user's first login, a payment),
 * reported at startup instead. Errors stop the server; warnings are printed.
 */
export function configProblems(
  config: AppConfig,
  env: NodeJS.ProcessEnv = process.env,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const encryptionKey = env.SHIPLOG_ENCRYPTION_KEY?.trim();
  if (encryptionKey && encryptionKey.length < 24) {
    errors.push("SHIPLOG_ENCRYPTION_KEY 至少需要 24 位。");
  }
  if (config.isProduction && !encryptionKey) {
    (config.authMode === "github" ? errors : warnings).push(
      "生产环境未配置 SHIPLOG_ENCRYPTION_KEY：无法保存 GitHub 令牌和 Webhook 地址。",
    );
  }
  const localUrl = /^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(config.publicBaseUrl);
  if (config.authMode === "github" && config.isProduction && localUrl) {
    warnings.push(
      "PUBLIC_BASE_URL 还是本机地址：GitHub 登录回调、付款跳转和提醒里的链接都会打不开。",
    );
  }
  const stripeVars = [env.STRIPE_SECRET_KEY, env.STRIPE_PRICE_ID, env.STRIPE_WEBHOOK_SECRET];
  if (!config.stripe && stripeVars.some((value) => value?.trim())) {
    warnings.push(
      "Stripe 配置不完整（需要 STRIPE_SECRET_KEY、STRIPE_PRICE_ID 和 STRIPE_WEBHOOK_SECRET），付款未启用。",
    );
  }
  if (config.stripe && config.authMode !== "github") {
    warnings.push("付款需要 GitHub 登录（多用户模式），自用模式下已忽略 Stripe 配置。");
  }
  if (config.isProduction && config.authMode === "local" && !config.appToken) {
    warnings.push(
      "自用模式未设置 SHIPLOG_APP_TOKEN：能访问这个端口的人都能使用你的 AI 额度和仓库。",
    );
  }
  return { errors, warnings };
}
