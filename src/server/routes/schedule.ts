import express from "express";
import { z } from "zod";
import { PlatformIdSchema, platformIds, webhookKinds } from "../../shared/schemas.js";
import { currentUser, parseBody, rateLimit } from "../http.js";
import type { ScheduleService } from "../scheduler/scheduler.js";

const scheduleSchema = z.object({
  enabled: z.boolean(),
  repoId: z.number().int().positive().nullable(),
  time: z.string(),
  timezone: z.string().min(1).max(64),
  platforms: z.array(PlatformIdSchema).max(platformIds.length),
  windowHours: z.number().int().min(1).max(168),
  skipEmpty: z.boolean(),
  notifyEmail: z.string().trim().max(254).nullable(),
  webhookKind: z.enum(webhookKinds).nullable(),
  webhookUrl: z.string().trim().max(500).optional(),
});

export function scheduleRoutes(schedules: ScheduleService): express.Router {
  const router = express.Router();
  const limit = rateLimit(5, 60_000);

  router.get("/api/schedule", (_req, res) => {
    res.json({ data: schedules.report(currentUser(res)) });
  });

  router.put("/api/schedule", async (req, res) => {
    const body = parseBody(scheduleSchema, req.body);
    res.json({
      data: await schedules.save(currentUser(res), {
        ...body,
        platforms: [...new Set(body.platforms)],
        notifyEmail: body.notifyEmail || null,
      }),
    });
  });

  router.post("/api/schedule/test", limit, async (_req, res) => {
    res.json({ data: await schedules.sendTest(currentUser(res)) });
  });

  router.post("/api/schedule/run", limit, async (_req, res) => {
    const user = currentUser(res);
    const run = await schedules.runFor(user.id, "manual");
    res.json({ data: { run, report: schedules.report(user) } });
  });

  return router;
}
