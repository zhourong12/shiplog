import { randomBytes, timingSafeEqual } from "node:crypto";
import express from "express";
import { authorizeUrl } from "../auth/githubOAuth.js";
import {
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  parseCookies,
  safeRedirectPath,
  serializeCookie,
} from "../auth/cookies.js";
import { toHttpError, type ShipLogService } from "../services/shiplogService.js";

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** /auth/github/login → GitHub → /auth/github/callback → session cookie → back into the app. */
export function authRoutes(service: ShipLogService): express.Router {
  const router = express.Router();
  const { config } = service;
  const secure = config.publicBaseUrl.startsWith("https://");
  const redirectUri = `${config.publicBaseUrl}/auth/github/callback`;

  router.get("/auth/github/login", (req, res) => {
    if (!config.github) {
      res.status(404).send("GitHub login is not enabled.");
      return;
    }
    const state = randomBytes(16).toString("base64url");
    const privateRepos = req.query.private === "1";
    const next = safeRedirectPath(req.query.next);
    res.append(
      "Set-Cookie",
      serializeCookie(OAUTH_STATE_COOKIE, JSON.stringify({ state, next }), {
        maxAgeSeconds: 600,
        secure,
        path: "/auth",
      }),
    );
    res.redirect(302, authorizeUrl(config.github, { redirectUri, state, privateRepos }));
  });

  router.get("/auth/github/callback", async (req, res) => {
    if (!config.github) {
      res.status(404).send("GitHub login is not enabled.");
      return;
    }
    const cookies = parseCookies(req.get("cookie"));
    res.append(
      "Set-Cookie",
      serializeCookie(OAUTH_STATE_COOKIE, "", { maxAgeSeconds: 0, secure, path: "/auth" }),
    );
    let saved: { state?: unknown; next?: unknown } = {};
    try {
      saved = JSON.parse(cookies[OAUTH_STATE_COOKIE] ?? "{}") as typeof saved;
    } catch {
      saved = {};
    }
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    // The state cookie ties the callback to the browser that started the login (CSRF).
    if (!code || typeof saved.state !== "string" || !state || !safeEqual(state, saved.state)) {
      res.redirect(302, "/?login_error=state");
      return;
    }
    try {
      const login = await service.loginWithGithub(code, redirectUri);
      res.append(
        "Set-Cookie",
        serializeCookie(SESSION_COOKIE, login.session, {
          maxAgeSeconds: SESSION_TTL_MS / 1000,
          secure,
        }),
      );
      res.redirect(302, safeRedirectPath(saved.next));
    } catch (error) {
      const mapped = toHttpError(error);
      console.error("[shiplog] GitHub login failed:", mapped?.code ?? "unexpected");
      res.redirect(302, `/?login_error=${encodeURIComponent(mapped?.code ?? "failed")}`);
    }
  });

  router.post("/api/auth/logout", (req, res) => {
    service.logout(parseCookies(req.get("cookie"))[SESSION_COOKIE]);
    res.append("Set-Cookie", serializeCookie(SESSION_COOKIE, "", { maxAgeSeconds: 0, secure }));
    res.status(204).end();
  });

  return router;
}
