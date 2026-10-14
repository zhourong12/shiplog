import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { GenerationResult, Plan } from "../../shared/schemas.js";
import { createApp } from "../app.js";
import { openDatabase } from "../db/database.js";
import { LOCAL_USER_ID } from "../db/stores.js";
import { ShipLogService } from "../services/shiplogService.js";
import { testConfig } from "../testing.js";
import {
  assertPublicWebhookUrl,
  buildDigest,
  sendWebhook,
  webhookPayload,
  type Digest,
} from "./notify.js";
import { ScheduleService, SchedulerLoop } from "./scheduler.js";
import { isDue, isValidTimeZone, nextRunAt, zonedParts } from "./time.js";

describe("time zones", () => {
  const instant = new Date("2026-10-14T13:05:00Z");

  it("reads wall-clock time in a zone", () => {
    expect(zonedParts(instant, "Asia/Shanghai")).toEqual({ day: "2026-10-14", time: "21:05" });
    expect(zonedParts(instant, "America/Los_Angeles")).toEqual({
      day: "2026-10-14",
      time: "06:05",
    });
    expect(isValidTimeZone("Asia/Shanghai")).toBe(true);
    expect(isValidTimeZone("Mars/Base")).toBe(false);
  });

  it("is due once per local day at or after the configured time", () => {
    const schedule = { time: "21:00", timezone: "Asia/Shanghai", lastRunDay: null };
    expect(isDue(schedule, instant)).toEqual({ due: true, day: "2026-10-14" });
    expect(isDue({ ...schedule, lastRunDay: "2026-10-14" }, instant).due).toBe(false);
    expect(isDue({ ...schedule, time: "21:06" }, instant).due).toBe(false);
  });

  it("finds the next run, skipping a day that already ran", () => {
    const schedule = { time: "21:00", timezone: "Asia/Shanghai", lastRunDay: "2026-10-14" };
    expect(nextRunAt(schedule, instant).toISOString()).toBe("2026-10-15T13:00:00.000Z");
    expect(nextRunAt({ ...schedule, time: "22:00", lastRunDay: null }, instant).toISOString()).toBe(
      "2026-10-14T14:00:00.000Z",
    );
  });
});

const digest: Digest = {
  subject: "S",
  text: "hello",
  url: "https://x/#history/1",
  generationId: "1",
};
const publicLookup = async () => ["93.184.216.34"];

describe("notifications", () => {
  it("formats payloads for each chat tool", () => {
    expect(webhookPayload("slack", digest)).toEqual({ text: "hello" });
    expect(webhookPayload("discord", digest)).toEqual({ content: "hello" });
    expect(webhookPayload("feishu", digest)).toEqual({
      msg_type: "text",
      content: { text: "hello" },
    });
    expect(webhookPayload("generic", digest)).toMatchObject({
      title: "S",
      url: "https://x/#history/1",
    });
  });

  it("only allows public HTTPS webhook targets", async () => {
    await expect(assertPublicWebhookUrl("http://hooks.example/x", publicLookup)).rejects.toThrow(
      "https",
    );
    await expect(assertPublicWebhookUrl("https://localhost/x", publicLookup)).rejects.toThrow(
      "内网",
    );
    await expect(assertPublicWebhookUrl("https://10.0.0.5/x", publicLookup)).rejects.toThrow(
      "内网",
    );
    await expect(assertPublicWebhookUrl("https://[::1]/x", publicLookup)).rejects.toThrow("内网");
    await expect(
      assertPublicWebhookUrl("https://metadata.example/x", async () => ["169.254.169.254"]),
    ).rejects.toThrow("内网");
    await expect(
      assertPublicWebhookUrl("https://a:b@hooks.example/x", publicLookup),
    ).rejects.toThrow("用户名");
    await expect(
      assertPublicWebhookUrl("https://hooks.example/x", publicLookup),
    ).resolves.toBeInstanceOf(URL);
  });

  it("posts JSON without following redirects", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));
    await sendWebhook("https://hooks.example/x", "feishu", digest, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolve: publicLookup,
    });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(init.redirect).toBe("manual");
    expect(JSON.parse(String(init.body))).toEqual({ msg_type: "text", content: { text: "hello" } });
    const failing = vi.fn(async () => new Response("no", { status: 500 }));
    await expect(
      sendWebhook("https://hooks.example/x", "slack", digest, {
        fetchImpl: failing as unknown as typeof fetch,
        resolve: publicLookup,
      }),
    ).rejects.toThrow("500");
  });

  it("builds a digest with a deep link to the generation", () => {
    const result = {
      id: "gen-1",
      repoLabel: "shiplog",
      dayHeadline: "导出 PNG 上线",
      totals: { commits: 3, additions: 120, deletions: 4, filesChanged: 5 },
      drafts: [
        { platform: "jike", status: "ok", body: "今天做完了导出。" },
        { platform: "x", status: "needs_review", body: "x" },
      ],
      milestones: [{ kind: "release", label: "发布 v1.0.0", value: "v1.0.0" }],
      baselineReason: null,
    } as unknown as GenerationResult;
    const built = buildDigest(result, "https://shiplog.example");
    expect(built.url).toBe("https://shiplog.example/#history/gen-1");
    expect(built.text).toContain("草稿 1/2 份通过检查：即刻✓、X⚠");
    expect(built.text).toContain("今天做完了导出。");
    expect(built.text).toContain("🎉 发布 v1.0.0");
  });
});

describe("scheduled runs", () => {
  let root: string;
  let repoPath: string;

  function git(args: string[], date: string) {
    execFileSync("git", args, {
      cwd: repoPath,
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

  beforeAll(() => {
    process.env.SHIPLOG_ENCRYPTION_KEY = "test-encryption-key-0123456789";
    root = mkdtempSync(join(tmpdir(), "shiplog-schedule-"));
    repoPath = join(root, "app");
    execFileSync("mkdir", ["-p", repoPath]);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoPath });
    writeFileSync(join(repoPath, "a.ts"), "export const a = 1;\n");
    git(["add", "."], "2026-10-14T08:00:00Z");
    git(["commit", "-q", "-m", "feat: export cards as PNG"], "2026-10-14T08:00:00Z");
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  async function setup(plan: Plan = "pro") {
    let now = new Date("2026-10-14T09:30:00Z");
    const config = testConfig({
      plan,
      localRoots: [root],
      publicBaseUrl: "https://shiplog.example",
    });
    const service = new ShipLogService({
      db: openDatabase(":memory:"),
      config,
      llmFactory: () => null,
      now: () => now,
    });
    const sent: Array<{ to: string; digest: Digest }> = [];
    const webhookCalls: string[] = [];
    const schedules = new ScheduleService({
      service,
      mailer: { send: async (to, digest) => void sent.push({ to, digest }) },
      fetchImpl: (async (url: URL) => {
        webhookCalls.push(String(url));
        return new Response("ok");
      }) as unknown as typeof fetch,
      resolve: publicLookup,
    });
    const user = service.localUser();
    const repo = await service.addLocalRepo(user, repoPath, null);
    return {
      service,
      schedules,
      user,
      repo,
      sent,
      webhookCalls,
      app: createApp({ service, config, schedules }),
      setNow: (iso: string) => {
        now = new Date(iso);
      },
    };
  }

  const settings = (repoId: number) => ({
    enabled: true,
    repoId,
    time: "09:00",
    timezone: "UTC",
    platforms: ["jike" as const, "changelog" as const],
    windowHours: 24,
    skipEmpty: true,
    notifyEmail: "me@example.com",
    webhookKind: "feishu" as const,
    webhookUrl: "https://open.feishu.example/hook/abc",
  });

  it("is a Pro feature", async () => {
    const { schedules, user, repo } = await setup("free");
    await expect(schedules.save(user, settings(repo.id))).rejects.toMatchObject({
      code: "plan_required",
    });
    expect(schedules.report(user).allowed).toBe(false);
  });

  it("does not fire immediately when enabled after today's time, then runs once the next day", async () => {
    const { schedules, service, user, repo, sent, webhookCalls, setNow } = await setup();
    const report = await schedules.save(user, settings(repo.id));
    expect(report.settings).toMatchObject({ enabled: true, webhookConfigured: true });
    expect(JSON.stringify(report)).not.toContain("open.feishu.example");
    expect(report.nextRunAt).toBe("2026-10-15T09:00:00.000Z");
    expect(await schedules.tick()).toBe(0);

    // Next day: a new commit lands, and the job runs once.
    git(["commit", "-q", "--allow-empty", "-m", "fix: retry uploads"], "2026-10-15T08:00:00Z");
    setNow("2026-10-15T09:01:00Z");
    expect(await schedules.tick()).toBe(1);
    expect(await schedules.tick()).toBe(0);

    const [run] = schedules.report(user).runs;
    expect(run).toMatchObject({
      trigger: "schedule",
      status: "success",
      notified: ["email", "webhook"],
    });
    const generation = service.getGeneration(user, run!.generationId!);
    expect(generation.totals.commits).toBe(1);
    expect(sent[0]).toMatchObject({ to: "me@example.com" });
    expect(sent[0]?.digest.url).toBe(`https://shiplog.example/#history/${generation.id}`);
    expect(webhookCalls).toEqual(["https://open.feishu.example/hook/abc"]);
  });

  it("skips quietly when there were no commits", async () => {
    const { schedules, service, user, repo, sent, setNow } = await setup();
    await schedules.save(user, { ...settings(repo.id), time: "23:00" });
    setNow("2026-10-20T23:30:00Z");
    expect(await schedules.tick()).toBe(1);
    expect(schedules.report(user).runs[0]).toMatchObject({ status: "skipped" });
    expect(service.generations.list(LOCAL_USER_ID)).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("rejects unsafe webhook URLs and bad settings", async () => {
    const { schedules, user, repo } = await setup();
    await expect(
      schedules.save(user, { ...settings(repo.id), webhookUrl: "https://192.168.1.1/hook" }),
    ).rejects.toMatchObject({ code: "invalid_webhook" });
    await expect(
      schedules.save(user, { ...settings(repo.id), time: "25:00" }),
    ).rejects.toMatchObject({
      code: "invalid_time",
    });
    await expect(
      schedules.save(user, { ...settings(repo.id), timezone: "Nowhere/City" }),
    ).rejects.toMatchObject({ code: "invalid_timezone" });
    await expect(schedules.save(user, { ...settings(repo.id), repoId: 999 })).rejects.toMatchObject(
      {
        code: "repo_not_found",
      },
    );
  });

  it("exposes settings, test messages and manual runs over the API", async () => {
    const { app } = await setup();
    const repos = await request(app).get("/api/repos").expect(200);
    const saved = await request(app)
      .put("/api/schedule")
      .send(settings(repos.body.data[0].id))
      .expect(200);
    expect(saved.body.data.settings.webhookKind).toBe("feishu");
    const test = await request(app).post("/api/schedule/test").expect(200);
    expect(test.body.data.sent).toEqual(["email", "webhook"]);
    const run = await request(app).post("/api/schedule/run").expect(200);
    expect(run.body.data.run).toMatchObject({ trigger: "manual", status: "success" });
    const cleared = await request(app)
      .put("/api/schedule")
      .send({ ...settings(repos.body.data[0].id), webhookUrl: "" })
      .expect(200);
    expect(cleared.body.data.settings).toMatchObject({
      webhookConfigured: false,
      webhookKind: null,
    });
  });

  it("never overlaps passes", async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    const slow = {
      tick: () =>
        new Promise<number>((resolve) => {
          calls += 1;
          release = () => resolve(0);
        }),
    } as unknown as ScheduleService;
    const loop = new SchedulerLoop(slow);
    const first = loop.pass();
    await loop.pass();
    expect(calls).toBe(1);
    release();
    await first;
  });
});
