import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { parseCookies, safeRedirectPath, serializeCookie } from "./auth/cookies.js";
import { openDatabase } from "./db/database.js";
import { ShipLogService } from "./services/shiplogService.js";
import { testConfig } from "./testing.js";

const BASE = "https://shiplog.example";

beforeAll(() => {
  process.env.SHIPLOG_ENCRYPTION_KEY = "test-encryption-key-0123456789";
});

/** A fake GitHub: OAuth token exchange, /user, repo lookup and the repo picker. */
function fakeGithub() {
  const profiles: Record<string, { id: number; login: string }> = {
    "code-alice": { id: 101, login: "alice" },
    "code-bob": { id: 202, login: "bob" },
  };
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://github.example/login/oauth/access_token") {
      const { code } = JSON.parse(String(init?.body)) as { code: string };
      if (!profiles[code]) return Response.json({ error: "bad_verification_code" });
      const scope = code === "code-alice" ? "read:user,user:email,repo" : "read:user,user:email";
      return Response.json({ access_token: `token-${code}`, scope });
    }
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const code = auth.replace("Bearer token-", "");
    if (url.endsWith("/user")) {
      const profile = profiles[code];
      return profile
        ? Response.json({ ...profile, name: profile.login.toUpperCase(), avatar_url: null })
        : new Response("{}", { status: 401 });
    }
    if (url.includes("/user/repos")) {
      return Response.json([
        {
          full_name: `${profiles[code]?.login}/app`,
          name: "app",
          owner: { login: profiles[code]?.login },
          private: true,
          pushed_at: "2026-10-01T00:00:00Z",
          description: null,
        },
      ]);
    }
    if (/\/repos\/[^/]+\/[^/]+$/.test(url)) {
      const [, owner, repo] = /\/repos\/([^/]+)\/([^/]+)$/.exec(url)!;
      return Response.json({ full_name: `${owner}/${repo}` });
    }
    return new Response("not found", { status: 404 });
  });
}

function setup() {
  const config = testConfig({
    authMode: "github",
    publicBaseUrl: BASE,
    github: { clientId: "cid", clientSecret: "secret", oauthBaseUrl: "https://github.example" },
  });
  const service = new ShipLogService({
    db: openDatabase(":memory:"),
    config,
    llmFactory: () => null,
    fetchImpl: fakeGithub() as unknown as typeof fetch,
  });
  return { app: createApp({ service, config }), service };
}

function setCookies(response: request.Response): string[] {
  const header = response.headers["set-cookie"] as unknown as string[] | string | undefined;
  return Array.isArray(header) ? header : header ? [header] : [];
}

function cookieValue(response: request.Response, name: string): string | undefined {
  const line = setCookies(response).find((cookie) => cookie.startsWith(`${name}=`));
  return line ? parseCookies(line.split(";")[0])[name] : undefined;
}

async function signIn(app: ReturnType<typeof setup>["app"], code: string, next = "/") {
  const start = await request(app)
    .get(`/auth/github/login?next=${encodeURIComponent(next)}`)
    .expect(302);
  const location = new URL(start.headers.location as string);
  const state = location.searchParams.get("state")!;
  const oauthCookie = cookieValue(start, "shiplog_oauth")!;
  const callback = await request(app)
    .get(`/auth/github/callback?code=${code}&state=${state}`)
    .set("Cookie", `shiplog_oauth=${encodeURIComponent(oauthCookie)}`)
    .expect(302);
  const session = cookieValue(callback, "shiplog_session");
  return { start, location, callback, session, cookie: `shiplog_session=${session}` };
}

describe("GitHub sign-in", () => {
  it("redirects to GitHub with state and returns to `next` with a session", async () => {
    const { app } = setup();
    const { location, callback, session, cookie } = await signIn(app, "code-alice", "/history");
    expect(location.origin + location.pathname).toBe(
      "https://github.example/login/oauth/authorize",
    );
    expect(location.searchParams.get("redirect_uri")).toBe(`${BASE}/auth/github/callback`);
    expect(location.searchParams.get("scope")).toBe("read:user user:email");
    expect(callback.headers.location).toBe("/history");
    expect(session).toBeTruthy();
    const sessionCookie = setCookies(callback).find((line) => line.startsWith("shiplog_session="));
    expect(sessionCookie).toMatch(/HttpOnly/);
    expect(sessionCookie).toMatch(/SameSite=Lax/);
    expect(sessionCookie).toMatch(/Secure/);

    const me = await request(app).get("/api/me").set("Cookie", cookie).expect(200);
    expect(me.body.data).toMatchObject({
      authMode: "github",
      authenticated: true,
      user: { login: "alice", name: "ALICE" },
      plan: "free",
      github: { oauth: true, privateRepos: true, pat: false },
    });
  });

  it("asks for the repo scope only when private repositories are requested", async () => {
    const { app } = setup();
    const response = await request(app).get("/auth/github/login?private=1").expect(302);
    expect(new URL(response.headers.location as string).searchParams.get("scope")).toBe(
      "read:user user:email repo",
    );
  });

  it("rejects a callback whose state does not match the browser's cookie", async () => {
    const { app } = setup();
    const start = await request(app).get("/auth/github/login").expect(302);
    const callback = await request(app)
      .get("/auth/github/callback?code=code-alice&state=forged")
      .set("Cookie", `shiplog_oauth=${encodeURIComponent(cookieValue(start, "shiplog_oauth")!)}`)
      .expect(302);
    expect(callback.headers.location).toBe("/?login_error=state");
    expect(cookieValue(callback, "shiplog_session")).toBeUndefined();
  });

  it("reports an expired code without creating a session", async () => {
    const { app } = setup();
    const { callback, session } = await signIn(app, "code-unknown");
    expect(callback.headers.location).toBe("/?login_error=github_login_failed");
    expect(session).toBeUndefined();
  });

  it("never redirects off-site after login", () => {
    expect(safeRedirectPath("/history")).toBe("/history");
    expect(safeRedirectPath("//evil.example")).toBe("/");
    expect(safeRedirectPath("https://evil.example")).toBe("/");
    expect(safeRedirectPath("/\\evil.example")).toBe("/");
    expect(safeRedirectPath(undefined)).toBe("/");
  });

  it("requires a session for the API and reports signed-out state on /api/me", async () => {
    const { app } = setup();
    const me = await request(app).get("/api/me").expect(200);
    expect(me.body.data).toMatchObject({ authenticated: false, user: null });
    const repos = await request(app).get("/api/repos").expect(401);
    expect(repos.body.error.code).toBe("login_required");
    await request(app).get("/api/repos").set("Cookie", "shiplog_session=made-up").expect(401);
  });

  it("logs out by deleting the server-side session", async () => {
    const { app } = setup();
    const { cookie } = await signIn(app, "code-bob");
    await request(app).get("/api/repos").set("Cookie", cookie).expect(200);
    await request(app).post("/api/auth/logout").set("Cookie", cookie).expect(204);
    await request(app).get("/api/repos").set("Cookie", cookie).expect(401);
  });

  it("keeps every user's data separate", async () => {
    const { app } = setup();
    const alice = await signIn(app, "code-alice");
    const bob = await signIn(app, "code-bob");
    const created = await request(app)
      .post("/api/repos")
      .set("Cookie", alice.cookie)
      .send({ kind: "github", owner: "alice", repo: "app" })
      .expect(201);
    const repoId = created.body.data.id as number;

    const bobRepos = await request(app).get("/api/repos").set("Cookie", bob.cookie).expect(200);
    expect(bobRepos.body.data).toEqual([]);
    await request(app)
      .post(`/api/repos/${repoId}/preview`)
      .set("Cookie", bob.cookie)
      .send({ since: "2026-10-01T00:00:00Z", until: "2026-10-02T00:00:00Z" })
      .expect(404);
    await request(app).delete(`/api/repos/${repoId}`).set("Cookie", bob.cookie).expect(404);
    const aliceRepos = await request(app).get("/api/repos").set("Cookie", alice.cookie).expect(200);
    expect(aliceRepos.body.data).toHaveLength(1);
  });

  it("lists the user's repositories with their OAuth token", async () => {
    const { app } = setup();
    const { cookie } = await signIn(app, "code-bob");
    const repos = await request(app).get("/api/github/repos").set("Cookie", cookie).expect(200);
    expect(repos.body.data).toEqual([
      expect.objectContaining({ fullName: "bob/app", owner: "bob", private: true }),
    ]);
  });

  it("disables local repositories and blocks cross-site writes", async () => {
    const { app } = setup();
    const { cookie } = await signIn(app, "code-bob");
    const local = await request(app)
      .post("/api/repos")
      .set("Cookie", cookie)
      .send({ kind: "local", localPath: "/etc" })
      .expect(403);
    expect(local.body.error.code).toBe("local_disabled");
    const crossSite = await request(app)
      .post("/api/repos")
      .set("Cookie", cookie)
      .set("Origin", "https://evil.example")
      .send({ kind: "github", owner: "bob", repo: "app" })
      .expect(403);
    expect(crossSite.body.error.code).toBe("bad_origin");
    await request(app)
      .post("/api/repos")
      .set("Cookie", cookie)
      .set("Origin", BASE)
      .send({ kind: "github", owner: "bob", repo: "app" })
      .expect(201);
  });
});

describe("cookies", () => {
  it("serializes secure, http-only, lax cookies and parses them back", () => {
    const line = serializeCookie("a", "x y", { maxAgeSeconds: 60, secure: true });
    expect(line).toBe("a=x%20y; Path=/; Max-Age=60; HttpOnly; SameSite=Lax; Secure");
    expect(parseCookies("a=x%20y; b=2")).toEqual({ a: "x y", b: "2" });
  });
});
