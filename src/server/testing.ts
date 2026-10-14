import type { AppConfig } from "./config.js";

/** A complete AppConfig for tests; override only what a test cares about. */
export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    publicBaseUrl: "http://127.0.0.1:8792",
    dbPath: ":memory:",
    keyFilePath: "/nonexistent/.encryption-key",
    authMode: "local",
    github: null,
    stripe: null,
    smtp: null,
    plan: "free",
    appToken: null,
    localRoots: [],
    githubApiBaseUrl: "https://api.github.invalid",
    aiConfigured: false,
    model: "fake",
    schedulerEnabled: false,
    isProduction: false,
    ...overrides,
  };
}
