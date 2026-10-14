import { z } from "zod";
import type { GithubRepoOption } from "../../shared/schemas.js";
import type { GithubOAuthConfig } from "../config.js";
import { HttpError } from "../services/errors.js";

/** Login needs profile and email; private repositories need the broader `repo` scope. */
export const LOGIN_SCOPES = ["read:user", "user:email"];
export const PRIVATE_REPO_SCOPES = [...LOGIN_SCOPES, "repo"];

export function authorizeUrl(
  config: GithubOAuthConfig,
  options: { redirectUri: string; state: string; privateRepos: boolean },
): string {
  const url = new URL("/login/oauth/authorize", config.oauthBaseUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set(
    "scope",
    (options.privateRepos ? PRIVATE_REPO_SCOPES : LOGIN_SCOPES).join(" "),
  );
  url.searchParams.set("state", options.state);
  url.searchParams.set("allow_signup", "true");
  return url.toString();
}

const tokenSchema = z.object({
  access_token: z.string().min(1),
  scope: z.string().default(""),
});

const tokenErrorSchema = z.object({ error: z.string(), error_description: z.string().optional() });

export interface GithubToken {
  token: string;
  scopes: string[];
}

export async function exchangeCode(
  config: GithubOAuthConfig,
  code: string,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GithubToken> {
  let response: Response;
  try {
    response = await fetchImpl(new URL("/login/oauth/access_token", config.oauthBaseUrl), {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new HttpError(502, "github_unavailable", "无法连接 GitHub 完成登录，请稍后重试。");
  }
  const json = (await response.json().catch(() => null)) as unknown;
  const parsed = tokenSchema.safeParse(json);
  if (!response.ok || !parsed.success) {
    const error = tokenErrorSchema.safeParse(json);
    // Codes are single-use and expire after ten minutes; both look like bad_verification_code.
    throw new HttpError(
      400,
      "github_login_failed",
      error.success && error.data.error === "bad_verification_code"
        ? "登录链接已过期，请重新登录。"
        : "GitHub 登录失败，请重试。",
    );
  }
  return {
    token: parsed.data.access_token,
    scopes: parsed.data.scope.split(/[\s,]+/).filter(Boolean),
  };
}

const profileSchema = z.object({
  id: z.number(),
  login: z.string(),
  name: z.string().nullable().optional(),
  avatar_url: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
});

export interface GithubProfile {
  githubId: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  email: string | null;
}

function apiHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "shiplog",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export async function fetchProfile(
  apiBaseUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GithubProfile> {
  let response: Response;
  try {
    response = await fetchImpl(`${apiBaseUrl.replace(/\/$/, "")}/user`, {
      headers: apiHeaders(token),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new HttpError(502, "github_unavailable", "无法读取 GitHub 账号信息，请稍后重试。");
  }
  const parsed = profileSchema.safeParse(await response.json().catch(() => null));
  if (!response.ok || !parsed.success) {
    throw new HttpError(502, "github_login_failed", "读取 GitHub 账号信息失败，请重试。");
  }
  return {
    githubId: parsed.data.id,
    login: parsed.data.login,
    name: parsed.data.name ?? null,
    avatarUrl: parsed.data.avatar_url ?? null,
    email: parsed.data.email ?? null,
  };
}

const repoListSchema = z.array(
  z.object({
    full_name: z.string(),
    name: z.string(),
    owner: z.object({ login: z.string() }),
    private: z.boolean(),
    pushed_at: z.string().nullable(),
    description: z.string().nullable().optional(),
  }),
);

/** The user's most recently pushed repositories, for the "connect a repository" picker. */
export async function listUserRepos(
  apiBaseUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GithubRepoOption[]> {
  let response: Response;
  try {
    response = await fetchImpl(
      `${apiBaseUrl.replace(/\/$/, "")}/user/repos?sort=pushed&per_page=100&affiliation=owner,collaborator,organization_member`,
      { headers: apiHeaders(token), signal: AbortSignal.timeout(15_000) },
    );
  } catch {
    throw new HttpError(502, "github_unavailable", "无法连接 GitHub，请稍后重试。");
  }
  if (response.status === 401) {
    throw new HttpError(401, "github_auth", "GitHub 授权已失效，请重新登录。");
  }
  const parsed = repoListSchema.safeParse(await response.json().catch(() => null));
  if (!response.ok || !parsed.success) {
    throw new HttpError(502, "github_bad_response", "读取仓库列表失败，请稍后重试。");
  }
  return parsed.data.map((repo) => ({
    owner: repo.owner.login,
    name: repo.name,
    fullName: repo.full_name,
    private: repo.private,
    pushedAt: repo.pushed_at,
    description: repo.description ?? null,
  }));
}
