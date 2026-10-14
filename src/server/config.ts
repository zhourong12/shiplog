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
