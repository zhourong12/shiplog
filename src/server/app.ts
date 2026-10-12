import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import {
  PlatformIdSchema,
  VoiceProfileSchema,
  platformIds,
  type HealthReport,
  type PlatformId,
} from "../shared/schemas.js";
import { renderCodeCard } from "./cards/codeCard.js";
import { renderStatsCard } from "./cards/statsCard.js";
import type { CardTheme } from "./cards/theme.js";
import type { AppConfig } from "./config.js";
import { SecretKeyError } from "./db/secrets.js";
import { HttpError } from "./services/errors.js";
import { toHttpError, type ShipLogService } from "./services/shiplogService.js";
import { isIsoDay, resolveToday, validateWindow } from "./services/window.js";

export const APP_VERSION = "0.1.0";

export interface AppOptions {
  service: ShipLogService;
  config: AppConfig;
  /** Mounted after the API: Vite middleware in development, static files in production. */
  clientMiddleware?: express.RequestHandler[];
}

const windowSchema = z.object({ since: z.string().min(1), until: z.string().min(1) });

const addRepoSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local"),
    localPath: z.string().trim().min(1).max(1000),
    productContext: z.string().trim().max(200).nullish(),
  }),
  z.object({
    kind: z.literal("github"),
    owner: z.string().trim().min(1).max(100),
    repo: z.string().trim().min(1).max(100),
    productContext: z.string().trim().max(200).nullish(),
  }),
]);

const generateSchema = windowSchema.extend({
  platforms: z.array(PlatformIdSchema).min(1).max(platformIds.length),
  today: z.string().optional(),
});

const draftPatchSchema = z.object({
  title: z.string().max(300).nullable(),
  body: z.string().max(25_000),
  hashtags: z.array(z.string().max(60)).max(20),
});

const githubTokenSchema = z.object({
  token: z
    .string()
    .trim()
    .min(20)
    .max(400)
    .regex(/^[A-Za-z0-9_]+$/, "令牌只能包含字母、数字和下划线"),
});

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Fixed-window rate limit per client address, for endpoints that spend AI tokens. */
function rateLimit(limit: number, windowMs: number): express.RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req, _res, next) => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > limit)
      return next(new HttpError(429, "rate_limited", "操作太频繁，请稍后再试。"));
    next();
  };
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HttpError(
      400,
      "invalid_request",
      issue
        ? `请求参数不正确：${issue.path.join(".") || "body"} ${issue.message}`
        : "请求参数不正确。",
    );
  }
  return parsed.data;
}

function idParam(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0)
    throw new HttpError(400, "invalid_request", "仓库 ID 不正确。");
  return id;
}

function themeParam(req: Request): CardTheme {
  return req.query.theme === "dark" ? "dark" : "light";
}

function sendSvg(res: Response, svg: string) {
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
  res.send(svg);
}

export function createApp({ service, config, clientMiddleware = [] }: AppOptions) {
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    next();
  });
  app.use("/api", express.json({ limit: "256kb" }));

  app.get("/api/health", (_req, res) => {
    const report: HealthReport = {
      ok: true,
      version: APP_VERSION,
      ai: { configured: config.aiConfigured, model: config.aiConfigured ? config.model : null },
      plan: config.plan,
      authRequired: Boolean(config.appToken),
      localReposEnabled: config.localRoots.length > 0,
    };
    res.json({ data: report });
  });

  app.use("/api", (req, _res, next) => {
    if (!config.appToken) return next();
    const header = req.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token || !safeEqual(token, config.appToken)) {
      return next(
        new HttpError(401, "unauthorized", "需要访问令牌。请在设置中填写 ShipLog 访问令牌。"),
      );
    }
    next();
  });

  const aiLimit = rateLimit(10, 60_000);

  app.get("/api/repos", (_req, res) => {
    res.json({ data: service.repos.list() });
  });

  app.post("/api/repos", async (req, res) => {
    const body = parseBody(addRepoSchema, req.body);
    const repo =
      body.kind === "local"
        ? await service.addLocalRepo(body.localPath, body.productContext ?? null)
        : await service.addGithubRepo(body.owner, body.repo, body.productContext ?? null);
    res.status(201).json({ data: repo });
  });

  app.patch("/api/repos/:id", (req, res) => {
    const id = idParam(req);
    service.requireRepo(id);
    const body = parseBody(
      z.object({ productContext: z.string().trim().max(200).nullable() }),
      req.body,
    );
    res.json({ data: service.repos.updateProductContext(id, body.productContext || null) });
  });

  app.delete("/api/repos/:id", (req, res) => {
    const id = idParam(req);
    if (!service.repos.delete(id)) throw new HttpError(404, "repo_not_found", "找不到这个仓库。");
    res.status(204).end();
  });

  app.get("/api/repos/:id/activity", async (req, res) => {
    const id = idParam(req);
    const today = resolveToday(
      typeof req.query.today === "string" ? req.query.today : undefined,
      new Date(),
    );
    const days = Math.min(Math.max(Number(req.query.days) || 84, 7), 371);
    res.json({ data: await service.activity(id, today, days) });
  });

  app.post("/api/repos/:id/preview", async (req, res) => {
    const id = idParam(req);
    const body = parseBody(windowSchema, req.body);
    res.json({ data: await service.preview(id, validateWindow(body.since, body.until)) });
  });

  app.post("/api/repos/:id/generate", aiLimit, async (req, res) => {
    const id = idParam(req);
    const body = parseBody(generateSchema, req.body);
    const window = validateWindow(body.since, body.until);
    const today = resolveToday(body.today, new Date());
    const platforms = [...new Set(body.platforms)] as PlatformId[];
    res.json({ data: await service.generate(id, window, platforms, today) });
  });

  app.get("/api/generations", (req, res) => {
    const repoId = req.query.repoId === undefined ? undefined : Number(req.query.repoId);
    if (repoId !== undefined && (!Number.isInteger(repoId) || repoId <= 0)) {
      throw new HttpError(400, "invalid_request", "仓库 ID 不正确。");
    }
    res.json({ data: service.generations.list({ repoId, limit: Number(req.query.limit) || 30 }) });
  });

  app.get("/api/generations/:gid", (req, res) => {
    const result = service.getGeneration(String(req.params.gid));
    const shared = service.generations.sharedPlatformsFor([result.id]).get(result.id) ?? [];
    res.json({ data: { ...result, sharedPlatforms: shared } });
  });

  app.patch("/api/generations/:gid/drafts/:platform", (req, res) => {
    const platform = parseBody(PlatformIdSchema, req.params.platform);
    const body = parseBody(draftPatchSchema, req.body);
    res.json({ data: service.editDraft(String(req.params.gid), platform, body) });
  });

  app.post("/api/generations/:gid/share", (req, res) => {
    const body = parseBody(
      z.object({ platform: PlatformIdSchema, day: z.string().optional() }),
      req.body,
    );
    const day =
      body.day && isIsoDay(body.day)
        ? resolveToday(body.day, new Date())
        : resolveToday(undefined, new Date());
    service.share(String(req.params.gid), body.platform, day);
    res.status(204).end();
  });

  app.get("/api/generations/:gid/cards/stats.svg", (req, res) => {
    const result = service.getGeneration(String(req.params.gid));
    const since = result.window.since.slice(0, 10);
    const until = result.window.until.slice(0, 10);
    sendSvg(
      res,
      renderStatsCard({
        repoLabel: result.repoLabel,
        windowLabel: since === until ? since : `${since} ~ ${until}`,
        totals: result.totals,
        breakdown: result.breakdown,
        activity: result.recentActivity,
        commitStreak: result.commitStreak,
        theme: themeParam(req),
      }),
    );
  });

  app.get("/api/generations/:gid/cards/code.svg", (req, res) => {
    const result = service.getGeneration(String(req.params.gid));
    const sha = typeof req.query.sha === "string" ? req.query.sha : "";
    const commit =
      result.commits.find((item) => item.sha === sha) ??
      result.commits.find((item) => item.snippet);
    if (!commit?.snippet)
      throw new HttpError(404, "snippet_not_found", "这次提交没有可展示的代码片段。");
    const story = result.stories.find((item) => item.commitShas.includes(commit.sha));
    sendSvg(
      res,
      renderCodeCard({
        title: story?.title ?? commit.subject,
        repoLabel: result.repoLabel,
        snippet: commit.snippet,
        theme: req.query.theme === "light" ? "light" : "dark",
      }),
    );
  });

  app.get("/api/credentials/github", (_req, res) => {
    res.json({ data: service.credentials.status("github_token") });
  });

  app.put("/api/credentials/github", (req, res) => {
    const body = parseBody(githubTokenSchema, req.body);
    service.credentials.set("github_token", body.token);
    res.json({ data: service.credentials.status("github_token") });
  });

  app.delete("/api/credentials/github", (_req, res) => {
    service.credentials.delete("github_token");
    res.status(204).end();
  });

  app.get("/api/voice", (_req, res) => {
    res.json({ data: service.voice.get() });
  });

  app.put("/api/voice", (req, res) => {
    const profile = parseBody(VoiceProfileSchema, req.body?.profile);
    res.json({ data: service.voice.save(profile, "manual", service.voice.get().samplesCount) });
  });

  app.post("/api/voice/learn", aiLimit, async (req, res) => {
    const body = parseBody(z.object({ samples: z.string().min(1).max(25_000) }), req.body);
    res.json({ data: await service.learnVoice(body.samples) });
  });

  app.get("/api/usage", (_req, res) => {
    res.json({ data: service.usageReport() });
  });

  app.use("/api", (_req, _res, next) => next(new HttpError(404, "not_found", "接口不存在。")));

  for (const middleware of clientMiddleware) app.use(middleware);

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof SecretKeyError) {
      res.status(500).json({ error: { code: "encryption_key_missing", message: error.message } });
      return;
    }
    const mapped = toHttpError(error);
    if (mapped) {
      res.status(mapped.status).json({ error: { code: mapped.code, message: mapped.message } });
      return;
    }
    if (error instanceof SyntaxError && "body" in error) {
      res.status(400).json({ error: { code: "invalid_json", message: "请求体不是合法的 JSON。" } });
      return;
    }
    // Never echo internals; log without request bodies, which may contain tokens.
    console.error("[shiplog] unexpected error:", error instanceof Error ? error.message : error);
    res
      .status(500)
      .json({ error: { code: "internal_error", message: "服务器内部错误，请稍后重试。" } });
  });

  return app;
}
