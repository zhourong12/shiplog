import express from "express";
import { z } from "zod";
import { VoiceProfileSchema } from "../../shared/schemas.js";
import { currentUser, parseBody, rateLimit } from "../http.js";
import type { ShipLogService } from "../services/shiplogService.js";

const githubTokenSchema = z.object({
  token: z
    .string()
    .trim()
    .min(20)
    .max(400)
    .regex(/^[A-Za-z0-9_]+$/, "令牌只能包含字母、数字和下划线"),
});

/** GitHub connection, writing voice and usage for the signed-in user. */
export function accountRoutes(service: ShipLogService): express.Router {
  const router = express.Router();
  const aiLimit = rateLimit(10, 60_000);

  router.get("/api/github/repos", async (_req, res) => {
    res.json({ data: await service.listGithubRepos(currentUser(res)) });
  });

  router.get("/api/credentials/github", (_req, res) => {
    res.json({ data: service.githubPatStatus(currentUser(res)) });
  });

  router.put("/api/credentials/github", (req, res) => {
    const body = parseBody(githubTokenSchema, req.body);
    res.json({ data: service.saveGithubPat(currentUser(res), body.token) });
  });

  router.delete("/api/credentials/github", (_req, res) => {
    service.deleteGithubPat(currentUser(res));
    res.status(204).end();
  });

  router.get("/api/voice", (_req, res) => {
    res.json({ data: service.voice.get(currentUser(res).id) });
  });

  router.put("/api/voice", (req, res) => {
    const user = currentUser(res);
    const profile = parseBody(VoiceProfileSchema, (req.body as { profile?: unknown })?.profile);
    res.json({
      data: service.voice.save(user.id, profile, "manual", service.voice.get(user.id).samplesCount),
    });
  });

  router.post("/api/voice/learn", aiLimit, async (req, res) => {
    const body = parseBody(z.object({ samples: z.string().min(1).max(25_000) }), req.body);
    res.json({ data: await service.learnVoice(currentUser(res), body.samples) });
  });

  router.get("/api/usage", (_req, res) => {
    res.json({ data: service.usageReport(currentUser(res)) });
  });

  return router;
}
