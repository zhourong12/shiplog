import type express from "express";
import type { Request, Response } from "express";
import type { z } from "zod";
import { HttpError } from "./services/errors.js";
import type { CurrentUser } from "./services/shiplogService.js";

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
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

export function positiveIntParam(req: Request, name: string, label = "ID"): number {
  const value = Number(req.params[name]);
  if (!Number.isInteger(value) || value <= 0) {
    throw new HttpError(400, "invalid_request", `${label} 不正确。`);
  }
  return value;
}

/** Set by the authentication middleware for every /api route behind it. */
export function currentUser(res: Response): CurrentUser {
  const user = res.locals.user as CurrentUser | undefined;
  if (!user) throw new HttpError(401, "login_required", "请先登录。");
  return user;
}

/** Fixed-window rate limit per signed-in user (or address), for endpoints that spend tokens. */
export function rateLimit(limit: number, windowMs: number): express.RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req, res, next) => {
    const user = res.locals.user as CurrentUser | undefined;
    const key = user ? `user:${user.id}` : `ip:${req.ip ?? "unknown"}`;
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > limit) {
      return next(new HttpError(429, "rate_limited", "操作太频繁，请稍后再试。"));
    }
    next();
  };
}

export function sendSvg(res: Response, svg: string) {
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
  res.send(svg);
}
