import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import type { HealthReport } from "../shared/schemas.js";
import { SESSION_COOKIE, parseCookies } from "./auth/cookies.js";
import type { StripeBilling } from "./billing/stripe.js";
import type { AppConfig } from "./config.js";
import { SecretKeyError } from "./db/secrets.js";
import { accountRoutes } from "./routes/account.js";
import { authRoutes } from "./routes/auth.js";
import { billingRoutes, billingWebhookRoutes } from "./routes/billing.js";
import { workspaceRoutes } from "./routes/workspace.js";
import { HttpError } from "./services/errors.js";
import { toHttpError, type CurrentUser, type ShipLogService } from "./services/shiplogService.js";

export const APP_VERSION = "0.2.0";

export interface AppOptions {
  service: ShipLogService;
  config: AppConfig;
  /** Stripe billing; null when payments are not configured. */
  billing?: StripeBilling | null;
  /** Routers mounted before the JSON body parser (they need the raw body, e.g. webhooks). */
  rawRoutes?: express.Router[];
  /** Extra authenticated API routers (billing, schedules…). */
  apiRoutes?: express.Router[];
  /** Mounted after the API: Vite middleware in development, static files in production. */
  clientMiddleware?: express.RequestHandler[];
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Resolve the signed-in user.
 * Local mode: the implicit local user, behind SHIPLOG_APP_TOKEN when it is set.
 * GitHub mode: the session cookie set by GitHub sign-in.
 */
function resolveUser(service: ShipLogService, req: Request): CurrentUser | null {
  const { config } = service;
  if (config.authMode === "local") {
    if (config.appToken) {
      const header = req.get("authorization") ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      if (!token || !safeEqual(token, config.appToken)) return null;
    }
    return service.localUser();
  }
  return service.userForSession(parseCookies(req.get("cookie"))[SESSION_COOKIE]);
}

export function createApp({
  service,
  config,
  billing = null,
  rawRoutes = [],
  apiRoutes = [],
  clientMiddleware = [],
}: AppOptions) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    next();
  });

  // Cookie sessions: refuse state-changing requests from other origins (CSRF).
  const expectedOrigin = new URL(config.publicBaseUrl).origin;
  app.use("/api", (req, _res, next) => {
    if (config.authMode !== "github" || ["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      return next();
    }
    const origin = req.get("origin");
    if (origin && origin !== expectedOrigin) {
      return next(new HttpError(403, "bad_origin", "请求来源不受信任。"));
    }
    next();
  });

  app.use(billingWebhookRoutes(service, billing));
  for (const router of rawRoutes) app.use(router);
  app.use("/api", express.json({ limit: "256kb" }));

  app.get("/api/health", (_req, res) => {
    const report: HealthReport = {
      ok: true,
      version: APP_VERSION,
      ai: { configured: config.aiConfigured, model: config.aiConfigured ? config.model : null },
      authMode: config.authMode,
      authRequired: config.authMode === "local" && Boolean(config.appToken),
      localReposEnabled: config.localRoots.length > 0,
      billingEnabled: config.authMode === "github" && config.stripe !== null,
      emailEnabled: config.smtp !== null,
    };
    res.json({ data: report });
  });

  app.use(authRoutes(service));

  app.use("/api", (req, res, next) => {
    const user = resolveUser(service, req);
    if (user) res.locals.user = user;
    next();
  });

  // Public: tells the client whether to show the app or the sign-in page.
  app.get("/api/me", (_req, res) => {
    const user = (res.locals.user as CurrentUser | undefined) ?? null;
    if (!user && config.authMode === "local") {
      throw new HttpError(401, "unauthorized", "需要访问令牌。请在设置中填写 ShipLog 访问令牌。");
    }
    res.json({ data: service.me(user) });
  });

  app.use("/api", (_req, res, next) => {
    if (res.locals.user) return next();
    next(
      config.authMode === "local"
        ? new HttpError(401, "unauthorized", "需要访问令牌。请在设置中填写 ShipLog 访问令牌。")
        : new HttpError(401, "login_required", "请先用 GitHub 登录。"),
    );
  });

  app.use(workspaceRoutes(service));
  app.use(accountRoutes(service));
  app.use(billingRoutes(service, billing));
  for (const router of apiRoutes) app.use(router);

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
