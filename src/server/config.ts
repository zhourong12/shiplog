import { dirname, join, resolve } from "node:path";
import type { Plan } from "../shared/schemas.js";
import { configuredModel, isAiConfigured } from "./ai/llm.js";

export interface AppConfig {
  port: number;
  host: string;
  dbPath: string;
  keyFilePath: string;
  plan: Plan;
  appToken: string | null;
  /** Empty means local repositories are disabled. */
  localRoots: string[];
  githubApiBaseUrl: string;
  aiConfigured: boolean;
  model: string;
  isProduction: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): AppConfig {
  const isProduction = env.NODE_ENV === "production";
  const dbPath = resolve(cwd, env.SHIPLOG_DB_PATH?.trim() || "var/shiplog.db");
  const roots = env.SHIPLOG_LOCAL_ROOTS?.split(",")
    .map((root) => root.trim())
    .filter(Boolean)
    .map((root) => resolve(cwd, root));
  return {
    port: Number(env.PORT) || 8792,
    host: env.HOST?.trim() || "127.0.0.1",
    dbPath,
    keyFilePath: join(dirname(dbPath), ".encryption-key"),
    plan: env.SHIPLOG_PLAN === "pro" ? "pro" : "free",
    appToken: env.SHIPLOG_APP_TOKEN?.trim() || null,
    // Development defaults to sibling folders of the working directory; production must opt in.
    localRoots: roots ?? (isProduction ? [] : [dirname(resolve(cwd))]),
    githubApiBaseUrl: env.GITHUB_API_BASE_URL?.trim() || "https://api.github.com",
    aiConfigured: isAiConfigured(env),
    model: configuredModel(env),
    isProduction,
  };
}
