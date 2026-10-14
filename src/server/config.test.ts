import { describe, expect, it } from "vitest";
import { configProblems, loadConfig } from "./config.js";

const hosted = {
  NODE_ENV: "production",
  GITHUB_CLIENT_ID: "id",
  GITHUB_CLIENT_SECRET: "secret",
  PUBLIC_BASE_URL: "https://shiplog.example",
  SHIPLOG_ENCRYPTION_KEY: "a-long-enough-encryption-key-0123",
};

describe("config", () => {
  it("switches to multi-user mode with GitHub sign-in and never reads local folders then", () => {
    const config = loadConfig({ ...hosted, SHIPLOG_LOCAL_ROOTS: "/srv" }, "/app");
    expect(config).toMatchObject({ authMode: "github", localRoots: [], isProduction: true });
  });

  it("accepts a complete hosted setup", () => {
    expect(configProblems(loadConfig(hosted, "/app"), hosted)).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it("refuses to start a hosted server that could not store tokens", () => {
    const env = { ...hosted, SHIPLOG_ENCRYPTION_KEY: "" };
    expect(configProblems(loadConfig(env, "/app"), env).errors).toHaveLength(1);
    const short = { ...hosted, SHIPLOG_ENCRYPTION_KEY: "short" };
    expect(configProblems(loadConfig(short, "/app"), short).errors).toHaveLength(1);
  });

  it("warns about settings that would break later", () => {
    const env = {
      ...hosted,
      PUBLIC_BASE_URL: "http://127.0.0.1:8792",
      STRIPE_SECRET_KEY: "sk_test_x",
    };
    const { errors, warnings } = configProblems(loadConfig(env, "/app"), env);
    expect(errors).toEqual([]);
    expect(warnings.join("\n")).toMatch(/PUBLIC_BASE_URL/);
    expect(warnings.join("\n")).toMatch(/Stripe 配置不完整/);
  });

  it("warns when a self-hosted production server is open to anyone", () => {
    const env = { NODE_ENV: "production", SHIPLOG_ENCRYPTION_KEY: hosted.SHIPLOG_ENCRYPTION_KEY };
    const { warnings } = configProblems(loadConfig(env, "/app"), env);
    expect(warnings.join("\n")).toMatch(/SHIPLOG_APP_TOKEN/);
  });
});
