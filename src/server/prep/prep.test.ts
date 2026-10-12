import { describe, expect, it } from "vitest";
import { excludedReasonForPath, filterPatch } from "./filter.js";
import { REDACTED, containsSecret, redactSecrets } from "./redact.js";

// Built at runtime so the repository never contains a literal that looks like a live key.
const fake = {
  github: `gh${"p"}_${"A1b2C3d4E5".repeat(4)}`,
  githubPat: `github_${"pat"}_${"11ABCDEFG0".repeat(3)}`,
  aws: `AK${"IA"}${"QWERTYUIOP123456"}`,
  anthropic: `sk-${"ant"}-api03-${"x".repeat(32)}`,
  openai: `sk-${"proj"}-${"Z".repeat(40)}`,
  stripe: `sk_${"live"}_${"9".repeat(24)}`,
  google: `AI${"za"}${"S".repeat(35)}`,
  jwt: `ey${"J"}hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${"d".repeat(20)}`,
};

describe("redactSecrets", () => {
  it.each(Object.entries(fake))("redacts %s tokens", (_kind, secret) => {
    const result = redactSecrets(`const value = "${secret}";`);
    expect(result.text).not.toContain(secret);
    expect(result.text).toContain(REDACTED);
    expect(result.count).toBeGreaterThan(0);
  });

  it("redacts private key blocks", () => {
    const block = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEA",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    expect(redactSecrets(`+${block}`).text).toBe(`+${REDACTED}`);
  });

  it("redacts secret assignments and URL passwords but keeps the key names", () => {
    const result = redactSecrets(
      [
        "+DB_PASSWORD=hunter2hunter2",
        '+  apiKey: "abcd1234efgh5678"',
        "+postgres://app:s3cretpass@db:5432/app",
      ].join("\n"),
    );
    expect(result.text).toContain(`DB_PASSWORD=${REDACTED}`);
    expect(result.text).toContain(`apiKey: "${REDACTED}"`);
    expect(result.text).toContain(`postgres://app:${REDACTED}@db`);
    expect(result.text).not.toMatch(/hunter2|abcd1234|s3cretpass/);
  });

  it("leaves ordinary code and environment references alone", () => {
    const code = [
      "+const token = process.env.GITHUB_TOKEN;",
      "+const password = readPassword();",
      "+const token = response.data.accessToken;",
      "+const authHeader = buildHeader;",
      "+export function tokenize(text: string) { return text.split(' '); }",
      "+// rename secretSauce to recipe",
      '+const api_key = "${API_KEY}";',
    ].join("\n");
    const result = redactSecrets(code);
    expect(result.count).toBe(0);
    expect(result.text).toBe(code);
    expect(containsSecret(code)).toBe(false);
  });
});

describe("excludedReasonForPath", () => {
  it.each([
    ["package-lock.json", "lockfile"],
    ["apps/web/pnpm-lock.yaml", "lockfile"],
    [".env.production", "secret_file"],
    ["config/server.key", "secret_file"],
    ["public/logo.png", "binary"],
    ["dist/index.js", "vendor"],
    ["src/vendor/lib.js", "vendor"],
    ["static/app.min.js", "generated"],
    ["src/__snapshots__/a.test.ts.snap", "generated"],
  ])("%s -> %s", (path, reason) => {
    expect(excludedReasonForPath(path)).toBe(reason);
  });

  it("keeps normal source files", () => {
    expect(excludedReasonForPath("src/server/app.ts")).toBeNull();
    expect(excludedReasonForPath("README.md")).toBeNull();
  });
});

describe("filterPatch", () => {
  const diff = [
    "diff --git a/src/app.ts b/src/app.ts",
    "index 111..222 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,2 +1,3 @@",
    " const a = 1;",
    "+const b = 2;",
    "diff --git a/package-lock.json b/package-lock.json",
    "--- a/package-lock.json",
    "+++ b/package-lock.json",
    "@@ -1 +1 @@",
    '-"version": "1.0.0"',
    '+"version": "1.0.1"',
    "diff --git a/.env b/.env",
    "+SECRET=abc",
  ].join("\n");

  it("drops excluded files and index lines", () => {
    const { text } = filterPatch(diff);
    expect(text).toContain("+const b = 2;");
    expect(text).not.toContain("package-lock");
    expect(text).not.toContain("SECRET");
    expect(text).not.toMatch(/^index /m);
  });

  it("truncates long lines and oversized commits", () => {
    const long = `diff --git a/a.ts b/a.ts\n+${"x".repeat(1000)}`;
    const result = filterPatch(long, {
      maxCharsPerFile: 5000,
      maxCharsPerCommit: 10000,
      maxLineLength: 50,
    });
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("长行已截断");

    const many = Array.from(
      { length: 10 },
      (_, i) => `diff --git a/f${i}.ts b/f${i}.ts\n+${"y".repeat(300)}`,
    ).join("\n");
    const capped = filterPatch(many, {
      maxCharsPerFile: 5000,
      maxCharsPerCommit: 1000,
      maxLineLength: 5000,
    });
    expect(capped.truncated).toBe(true);
    expect(capped.text.length).toBeLessThanOrEqual(1000);
  });
});
