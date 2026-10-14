import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Response as AgentResponse } from "superagent";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Plan } from "../shared/schemas.js";
import type { StructuredLlm, StructuredRequest } from "./ai/llm.js";
import { createApp } from "./app.js";
import type { AppConfig } from "./config.js";
import { DatabaseSync } from "node:sqlite";
import { migrate, migrations, openDatabase, type Db } from "./db/database.js";
import { LOCAL_USER_ID } from "./db/stores.js";
import { ShipLogService } from "./services/shiplogService.js";
import { testConfig } from "./testing.js";

let root: string;
let repoPath: string;
let otherRepoPath: string;
const now = new Date();
const day = (offset: number) => new Date(now.getTime() + offset * 86_400_000).toISOString();

function git(cwd: string, args: string[], date = now.toISOString()) {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Dev",
      GIT_AUTHOR_EMAIL: "dev@example.com",
      GIT_COMMITTER_NAME: "Dev",
      GIT_COMMITTER_EMAIL: "dev@example.com",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  });
}

function makeRepo(name: string): string {
  const path = join(root, name);
  execFileSync("mkdir", ["-p", path]);
  git(path, ["init", "-q", "-b", "main"]);
  writeFileSync(join(path, "index.ts"), "export const ready = true;\n");
  git(path, ["add", "."]);
  git(path, ["commit", "-q", "-m", "feat: first feature"], day(-0.1));
  const fakeKey = `sk-${"ant"}-${"q".repeat(30)}`;
  writeFileSync(
    join(path, "config.ts"),
    `export const key = "${fakeKey}";\nexport const retries = 3;\n`,
  );
  git(path, ["add", "."]);
  git(path, ["commit", "-q", "-m", "fix: retry uploads 3 times"], day(-0.05));
  return path;
}

beforeAll(() => {
  process.env.SHIPLOG_ENCRYPTION_KEY = "test-encryption-key-0123456789";
  root = mkdtempSync(join(tmpdir(), "shiplog-app-"));
  repoPath = makeRepo("app");
  otherRepoPath = makeRepo("other");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.SHIPLOG_ENCRYPTION_KEY;
});

const usage = {
  model: "fake",
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.002,
};

class ScriptedLlm implements StructuredLlm {
  readonly model = "fake";
  calls: string[] = [];
  async generate<T>(request: StructuredRequest<T>) {
    this.calls.push(request.label);
    const sha = /sha="([0-9a-f]{40})"/.exec(request.user)?.[1] ?? "";
    const outputs: Record<string, unknown> = {
      understand: {
        dayHeadline: "上传更稳了",
        stories: [
          {
            title: "上传失败自动重试",
            kind: "fix",
            userFacing: true,
            shareability: "high",
            summary: "上传失败会自动重试",
            angle: "",
            commitShas: [sha],
            facts: [{ text: "上传失败最多重试 3 次", sourceShas: [sha] }],
          },
        ],
      },
      write: {
        drafts: [
          {
            platform: "jike",
            title: null,
            body: "上传失败现在会自动重试 3 次。",
            hashtags: ["独立开发"],
            factIds: ["f1"],
          },
        ],
      },
      voice: {
        language: "zh",
        tone: "轻松",
        sentenceStyle: "短句",
        emojiUsage: "none",
        catchphrases: [],
        dos: [],
        donts: [],
      },
    };
    return { data: request.schema.parse(outputs[request.label]), usage };
  }
}

function setup(options: { plan?: Plan; appToken?: string | null; aiConfigured?: boolean } = {}) {
  const db: Db = openDatabase(":memory:");
  const config: AppConfig = testConfig({
    keyFilePath: join(root, ".key"),
    plan: options.plan ?? "free",
    appToken: options.appToken ?? null,
    localRoots: [root],
    aiConfigured: options.aiConfigured ?? true,
  });
  const llm = new ScriptedLlm();
  const service = new ShipLogService({
    db,
    config,
    llmFactory: () => (config.aiConfigured ? llm : null),
  });
  return { app: createApp({ service, config }), db, llm, service };
}

const windowBody = () => ({ since: day(-1), until: day(0.01) });

/** supertest does not buffer image/* bodies as text; collect them explicitly. */
function textParser(res: AgentResponse, callback: (error: Error | null, body: string) => void) {
  const stream = res as unknown as NodeJS.ReadableStream;
  let data = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => (data += chunk));
  stream.on("end", () => callback(null, data));
}

describe("API", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("reports health without auth and enforces the app token elsewhere", async () => {
    const secured = setup({ appToken: "secret-app-token" });
    const health = await request(secured.app).get("/api/health").expect(200);
    expect(health.body.data).toMatchObject({
      ok: true,
      authMode: "local",
      authRequired: true,
      ai: { configured: true },
    });
    await request(secured.app).get("/api/repos").expect(401);
    await request(secured.app)
      .get("/api/repos")
      .set("Authorization", "Bearer wrong-token")
      .expect(401);
    await request(secured.app)
      .get("/api/repos")
      .set("Authorization", "Bearer secret-app-token")
      .expect(200);
  });

  it("adds a local repository inside the allowed roots only, and enforces the free repo limit", async () => {
    const created = await request(ctx.app)
      .post("/api/repos")
      .send({ kind: "local", localPath: repoPath })
      .expect(201);
    expect(created.body.data).toMatchObject({ kind: "local", label: "app" });
    await request(ctx.app)
      .post("/api/repos")
      .send({ kind: "local", localPath: "/etc" })
      .expect(403);
    const limited = await request(ctx.app)
      .post("/api/repos")
      .send({ kind: "local", localPath: otherRepoPath })
      .expect(403);
    expect(limited.body.error.code).toBe("plan_required");
    const pro = setup({ plan: "pro" });
    await request(pro.app)
      .post("/api/repos")
      .send({ kind: "local", localPath: repoPath })
      .expect(201);
    await request(pro.app)
      .post("/api/repos")
      .send({ kind: "local", localPath: otherRepoPath })
      .expect(201);
  });

  it("previews the redacted AI payload without calling the model", async () => {
    const repo = await request(ctx.app)
      .post("/api/repos")
      .send({ kind: "local", localPath: repoPath });
    const preview = await request(ctx.app)
      .post(`/api/repos/${repo.body.data.id}/preview`)
      .send(windowBody())
      .expect(200);
    expect(preview.body.data.totals.commits).toBe(2);
    expect(preview.body.data.redactionCount).toBe(1);
    expect(preview.body.data.aiPayload).not.toContain(`sk-${"ant"}`);
    expect(preview.body.data.aiPayload).toContain("[已脱敏]");
    expect(ctx.llm.calls).toEqual([]);
  });

  it("generates, stores, edits with re-checks, shares and renders cards", async () => {
    const repo = await request(ctx.app)
      .post("/api/repos")
      .send({ kind: "local", localPath: repoPath });
    const id = repo.body.data.id;
    const generated = await request(ctx.app)
      .post(`/api/repos/${id}/generate`)
      .send({ ...windowBody(), platforms: ["jike"] })
      .expect(200);
    const result = generated.body.data;
    expect(result.mode).toBe("ai");
    expect(result.drafts[0]).toMatchObject({ platform: "jike", status: "ok" });
    expect(result.commitStreak).toBeGreaterThanOrEqual(1);
    expect(ctx.llm.calls).toEqual(["understand", "write"]);

    const list = await request(ctx.app).get(`/api/generations?repoId=${id}`).expect(200);
    expect(list.body.data[0]).toMatchObject({ id: result.id, mode: "ai", commits: 2 });

    const edited = await request(ctx.app)
      .patch(`/api/generations/${result.id}/drafts/jike`)
      .send({ title: null, body: "上传成功率提升 99%", hashtags: ["#独立开发#"] })
      .expect(200);
    expect(edited.body.data).toMatchObject({
      status: "needs_review",
      edited: true,
      hashtags: ["独立开发"],
    });
    expect(edited.body.data.issues[0].code).toBe("unsupported_number");

    await request(ctx.app)
      .post(`/api/generations/${result.id}/share`)
      .send({ platform: "jike" })
      .expect(204);
    const detail = await request(ctx.app).get(`/api/generations/${result.id}`).expect(200);
    expect(detail.body.data.sharedPlatforms).toEqual(["jike"]);
    expect(detail.body.data.drafts[0].edited).toBe(true);

    const activity = await request(ctx.app).get(`/api/repos/${id}/activity?days=14`).expect(200);
    expect(activity.body.data.shareStreak).toBe(1);
    expect(activity.body.data.days).toHaveLength(14);

    const stats = await request(ctx.app)
      .get(`/api/generations/${result.id}/cards/stats.svg?theme=dark`)
      .buffer(true)
      .parse(textParser)
      .expect(200);
    expect(stats.headers["content-type"]).toContain("image/svg+xml");
    expect(stats.body).toContain("次提交");
    const code = await request(ctx.app)
      .get(`/api/generations/${result.id}/cards/code.svg`)
      .buffer(true)
      .parse(textParser)
      .expect(200);
    expect(code.body).toContain("[已脱敏]");

    const usageReport = await request(ctx.app).get("/api/usage").expect(200);
    expect(usageReport.body.data).toMatchObject({ plan: "free", aiRuns: 1, costUsd: 0.004 });
  });

  it("falls back to the baseline when the free monthly quota is used up", async () => {
    const repo = await request(ctx.app)
      .post("/api/repos")
      .send({ kind: "local", localPath: repoPath });
    for (let index = 0; index < 10; index += 1)
      ctx.service.usage.recordRun(LOCAL_USER_ID, "generation", null);
    const generated = await request(ctx.app)
      .post(`/api/repos/${repo.body.data.id}/generate`)
      .send({ ...windowBody(), platforms: ["x"] })
      .expect(200);
    expect(generated.body.data.mode).toBe("baseline");
    expect(generated.body.data.baselineReason).toContain("额度已用完");
    expect(ctx.llm.calls).toEqual([]);
  });

  it("runs the baseline when AI is not configured", async () => {
    const offline = setup({ aiConfigured: false });
    const repo = await request(offline.app)
      .post("/api/repos")
      .send({ kind: "local", localPath: repoPath });
    const generated = await request(offline.app)
      .post(`/api/repos/${repo.body.data.id}/generate`)
      .send({ ...windowBody(), platforms: ["x"] })
      .expect(200);
    expect(generated.body.data).toMatchObject({ mode: "baseline", drafts: [] });
    expect(generated.body.data.changelog).toContain("### 问题修复");
  });

  it("validates input", async () => {
    const repo = await request(ctx.app)
      .post("/api/repos")
      .send({ kind: "local", localPath: repoPath });
    const id = repo.body.data.id;
    await request(ctx.app)
      .post(`/api/repos/${id}/generate`)
      .send({ ...windowBody(), platforms: ["myspace"] })
      .expect(400);
    const tooLong = await request(ctx.app)
      .post(`/api/repos/${id}/generate`)
      .send({ since: day(-60), until: day(0), platforms: ["x"] })
      .expect(400);
    expect(tooLong.body.error.code).toBe("invalid_window");
    await request(ctx.app).post("/api/repos/abc/preview").send(windowBody()).expect(400);
    await request(ctx.app).get("/api/generations/nope").expect(404);
    await request(ctx.app).get("/api/nothing-here").expect(404);
  });

  it("stores the GitHub token encrypted and only exposes a hint", async () => {
    const token = `ghp_${"T0k3n".repeat(8)}`;
    const saved = await request(ctx.app).put("/api/credentials/github").send({ token }).expect(200);
    expect(saved.body.data).toMatchObject({ configured: true, hint: token.slice(-4) });
    const row = ctx.db.prepare("SELECT ciphertext FROM credentials").get() as {
      ciphertext: string;
    };
    expect(row.ciphertext).not.toContain(token);
    expect(ctx.service.credentials.get(LOCAL_USER_ID, "github_token")).toBe(token);
    await request(ctx.app).put("/api/credentials/github").send({ token: "short" }).expect(400);
    await request(ctx.app).delete("/api/credentials/github").expect(204);
    const status = await request(ctx.app).get("/api/credentials/github").expect(200);
    expect(status.body.data.configured).toBe(false);
  });

  it("gates voice learning on the plan and saves manual edits", async () => {
    const blocked = await request(ctx.app)
      .post("/api/voice/learn")
      .send({ samples: "a\n---\nb" })
      .expect(403);
    expect(blocked.body.error.code).toBe("plan_required");
    const pro = setup({ plan: "pro" });
    const learned = await request(pro.app)
      .post("/api/voice/learn")
      .send({ samples: "今天把上传重试做完了，舒服。\n---\n修了一个困扰我一周的 bug。" })
      .expect(200);
    expect(learned.body.data).toMatchObject({
      source: "learned",
      samplesCount: 2,
      profile: { tone: "轻松" },
    });
    const manual = await request(ctx.app)
      .put("/api/voice")
      .send({ profile: { ...learned.body.data.profile, tone: "认真" } })
      .expect(200);
    expect(manual.body.data).toMatchObject({ source: "manual", profile: { tone: "认真" } });
  });
});

describe("migrations", () => {
  it("are idempotent", () => {
    const db = openDatabase(":memory:");
    expect(migrate(db)).toEqual([]);
    const versions = db.prepare("SELECT version FROM schema_migrations").all() as Array<{
      version: number;
    }>;
    expect(versions.map((row) => row.version)).toEqual(migrations.map((m) => m.version));
  });

  it("moves single-user data to the local user when upgrading from version 1", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );
    db.exec(migrations[0]!.sql);
    db.prepare("INSERT INTO schema_migrations VALUES (1, 'initial schema', 'x')").run();
    db.prepare(
      "INSERT INTO repos (kind, label, local_path, created_at) VALUES ('local', 'app', '/x', 'now')",
    ).run();
    db.prepare("INSERT INTO credentials VALUES ('github_token', 'c', 'i', 't', 'h', 'now')").run();
    db.prepare("INSERT INTO voice_profile VALUES (1, '{}', 'manual', 0, 'now')").run();
    expect(migrate(db)).toEqual(migrations.slice(1).map((m) => m.version));
    expect(db.prepare("SELECT user_id FROM repos").get()).toEqual({ user_id: LOCAL_USER_ID });
    expect(db.prepare("SELECT user_id, name FROM credentials").get()).toEqual({
      user_id: LOCAL_USER_ID,
      name: "github_token",
    });
    expect(db.prepare("SELECT user_id FROM voice_profiles").get()).toEqual({
      user_id: LOCAL_USER_ID,
    });
    expect(db.prepare("SELECT login FROM users WHERE id = 1").get()).toEqual({ login: "local" });
  });
});
