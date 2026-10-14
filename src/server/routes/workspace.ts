import express from "express";
import { z } from "zod";
import { PlatformIdSchema, platformIds, type PlatformId } from "../../shared/schemas.js";
import { renderCodeCard } from "../cards/codeCard.js";
import { renderStatsCard } from "../cards/statsCard.js";
import { currentUser, parseBody, positiveIntParam, rateLimit, sendSvg } from "../http.js";
import { HttpError } from "../services/errors.js";
import type { ShipLogService } from "../services/shiplogService.js";
import { isIsoDay, resolveToday, validateWindow } from "../services/window.js";

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

const count = z.number().int().min(0).max(1_000_000_000);

const metricsSchema = z.object({
  postUrl: z
    .string()
    .trim()
    .max(500)
    .refine((value) => value === "" || /^https?:\/\/[^\s]+$/i.test(value), {
      message: "帖子链接需要以 http:// 或 https:// 开头。",
    })
    .nullish()
    .transform((value) => value || null),
  views: count.nullish().transform((value) => value ?? null),
  likes: count,
  comments: count,
  reposts: count,
  saves: count.default(0),
});

/** Repositories, generations, drafts and share cards. Everything is scoped to the signed-in user. */
export function workspaceRoutes(service: ShipLogService): express.Router {
  const router = express.Router();
  const aiLimit = rateLimit(10, 60_000);
  const repoId = (req: express.Request) => positiveIntParam(req, "id", "仓库 ID");

  router.get("/api/repos", (_req, res) => {
    res.json({ data: service.repos.list(currentUser(res).id) });
  });

  router.post("/api/repos", async (req, res) => {
    const user = currentUser(res);
    const body = parseBody(addRepoSchema, req.body);
    const repo =
      body.kind === "local"
        ? await service.addLocalRepo(user, body.localPath, body.productContext ?? null)
        : await service.addGithubRepo(user, body.owner, body.repo, body.productContext ?? null);
    res.status(201).json({ data: repo });
  });

  router.patch("/api/repos/:id", (req, res) => {
    const user = currentUser(res);
    const id = repoId(req);
    service.requireRepo(user, id);
    const body = parseBody(
      z.object({ productContext: z.string().trim().max(200).nullable() }),
      req.body,
    );
    res.json({
      data: service.repos.updateProductContext(user.id, id, body.productContext || null),
    });
  });

  router.delete("/api/repos/:id", (req, res) => {
    if (!service.repos.delete(currentUser(res).id, repoId(req))) {
      throw new HttpError(404, "repo_not_found", "找不到这个仓库。");
    }
    res.status(204).end();
  });

  router.get("/api/repos/:id/activity", async (req, res) => {
    const today = resolveToday(
      typeof req.query.today === "string" ? req.query.today : undefined,
      new Date(),
    );
    const days = Math.min(Math.max(Number(req.query.days) || 84, 7), 371);
    res.json({ data: await service.activity(currentUser(res), repoId(req), today, days) });
  });

  router.post("/api/repos/:id/preview", async (req, res) => {
    const body = parseBody(windowSchema, req.body);
    res.json({
      data: await service.preview(
        currentUser(res),
        repoId(req),
        validateWindow(body.since, body.until),
      ),
    });
  });

  router.post("/api/repos/:id/generate", aiLimit, async (req, res) => {
    const body = parseBody(generateSchema, req.body);
    const window = validateWindow(body.since, body.until);
    const today = resolveToday(body.today, new Date());
    const platforms = [...new Set(body.platforms)] as PlatformId[];
    res.json({
      data: await service.generate(currentUser(res), repoId(req), window, platforms, today),
    });
  });

  router.get("/api/generations", (req, res) => {
    const filter = req.query.repoId === undefined ? undefined : Number(req.query.repoId);
    if (filter !== undefined && (!Number.isInteger(filter) || filter <= 0)) {
      throw new HttpError(400, "invalid_request", "仓库 ID 不正确。");
    }
    res.json({
      data: service.generations.list(currentUser(res).id, {
        repoId: filter,
        limit: Number(req.query.limit) || 30,
      }),
    });
  });

  router.get("/api/generations/:gid", (req, res) => {
    const user = currentUser(res);
    const result = service.getGeneration(user, String(req.params.gid));
    const shared = service.generations.sharedPlatformsFor(user.id, [result.id]).get(result.id);
    res.json({
      data: {
        ...result,
        sharedPlatforms: shared ?? [],
        metrics: service.metrics.forGeneration(user.id, result.id),
      },
    });
  });

  router.put("/api/generations/:gid/drafts/:platform/metrics", (req, res) => {
    const platform = parseBody(PlatformIdSchema, req.params.platform);
    const body = parseBody(metricsSchema, req.body);
    res.json({
      data: service.recordMetrics(currentUser(res), String(req.params.gid), platform, body),
    });
  });

  router.delete("/api/generations/:gid/drafts/:platform/metrics", (req, res) => {
    const platform = parseBody(PlatformIdSchema, req.params.platform);
    service.deleteMetrics(currentUser(res), String(req.params.gid), platform);
    res.status(204).end();
  });

  router.get("/api/insights", (_req, res) => {
    res.json({ data: service.insights(currentUser(res)) });
  });

  router.patch("/api/generations/:gid/drafts/:platform", (req, res) => {
    const platform = parseBody(PlatformIdSchema, req.params.platform);
    const body = parseBody(draftPatchSchema, req.body);
    res.json({
      data: service.editDraft(currentUser(res), String(req.params.gid), platform, body),
    });
  });

  router.post("/api/generations/:gid/share", (req, res) => {
    const body = parseBody(
      z.object({ platform: PlatformIdSchema, day: z.string().optional() }),
      req.body,
    );
    const day = resolveToday(body.day && isIsoDay(body.day) ? body.day : undefined, new Date());
    service.share(currentUser(res), String(req.params.gid), body.platform, day);
    res.status(204).end();
  });

  router.get("/api/generations/:gid/cards/stats.svg", (req, res) => {
    const result = service.getGeneration(currentUser(res), String(req.params.gid));
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
        theme: req.query.theme === "dark" ? "dark" : "light",
      }),
    );
  });

  router.get("/api/generations/:gid/cards/code.svg", (req, res) => {
    const result = service.getGeneration(currentUser(res), String(req.params.gid));
    const sha = typeof req.query.sha === "string" ? req.query.sha : "";
    const commit =
      result.commits.find((item) => item.sha === sha) ??
      result.commits.find((item) => item.snippet);
    if (!commit?.snippet) {
      throw new HttpError(404, "snippet_not_found", "这次提交没有可展示的代码片段。");
    }
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

  return router;
}
