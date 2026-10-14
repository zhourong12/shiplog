import type {
  ActivityReport,
  Draft,
  GenerationResult,
  GenerationSummary,
  GithubRepoOption,
  HealthReport,
  MeReport,
  PlatformId,
  PreviewReport,
  RepoSummary,
  ScheduleReport,
  ScheduleRun,
  WebhookKind,
  UsageReport,
  VoiceProfile,
  VoiceState,
} from "../shared/schemas";

const TOKEN_KEY = "shiplog-app-token";

export function getAppToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setAppToken(token: string): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage can be unavailable (private mode); the token then lasts for this page only.
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function headers(json: boolean): HeadersInit {
  const result: Record<string, string> = {};
  if (json) result["Content-Type"] = "application/json";
  const token = getAppToken();
  if (token) result.Authorization = `Bearer ${token}`;
  return result;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "network", "无法连接 ShipLog 服务，请确认服务已启动。");
  }
  if (response.status === 204) return undefined as T;
  const payload = (await response.json().catch(() => null)) as {
    data?: T;
    error?: { code: string; message: string };
  } | null;
  if (!response.ok || !payload || payload.error) {
    throw new ApiError(
      response.status,
      payload?.error?.code ?? "unknown",
      payload?.error?.message ?? `请求失败（${response.status}）。`,
    );
  }
  return payload.data as T;
}

/** Card SVGs are fetched with auth headers and shown through object URLs. */
export async function fetchSvg(path: string): Promise<string> {
  const response = await fetch(path, { headers: headers(false) });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { code: string; message: string };
    } | null;
    throw new ApiError(
      response.status,
      payload?.error?.code ?? "unknown",
      payload?.error?.message ?? "卡片生成失败。",
    );
  }
  return response.text();
}

export interface ScheduleInput {
  enabled: boolean;
  repoId: number | null;
  time: string;
  timezone: string;
  platforms: PlatformId[];
  windowHours: number;
  skipEmpty: boolean;
  notifyEmail: string | null;
  webhookKind: WebhookKind | null;
  webhookUrl?: string;
}

export interface TimeWindow {
  since: string;
  until: string;
}

export const api = {
  health: () => call<HealthReport>("GET", "/api/health"),
  me: () => call<MeReport>("GET", "/api/me"),
  logout: () => call<void>("POST", "/api/auth/logout"),
  githubRepos: () => call<GithubRepoOption[]>("GET", "/api/github/repos"),
  repos: () => call<RepoSummary[]>("GET", "/api/repos"),
  addLocalRepo: (localPath: string, productContext: string | null) =>
    call<RepoSummary>("POST", "/api/repos", { kind: "local", localPath, productContext }),
  addGithubRepo: (owner: string, repo: string, productContext: string | null) =>
    call<RepoSummary>("POST", "/api/repos", { kind: "github", owner, repo, productContext }),
  updateRepo: (id: number, productContext: string | null) =>
    call<RepoSummary>("PATCH", `/api/repos/${id}`, { productContext }),
  deleteRepo: (id: number) => call<void>("DELETE", `/api/repos/${id}`),
  activity: (id: number, today: string, days = 84) =>
    call<ActivityReport>("GET", `/api/repos/${id}/activity?days=${days}&today=${today}`),
  preview: (id: number, window: TimeWindow) =>
    call<PreviewReport>("POST", `/api/repos/${id}/preview`, window),
  generate: (id: number, window: TimeWindow, platforms: PlatformId[], today: string) =>
    call<GenerationResult>("POST", `/api/repos/${id}/generate`, { ...window, platforms, today }),
  generations: (repoId?: number) =>
    call<GenerationSummary[]>(
      "GET",
      repoId === undefined ? "/api/generations" : `/api/generations?repoId=${repoId}`,
    ),
  generation: (id: string) =>
    call<GenerationResult & { sharedPlatforms: PlatformId[] }>("GET", `/api/generations/${id}`),
  editDraft: (
    id: string,
    platform: PlatformId,
    patch: { title: string | null; body: string; hashtags: string[] },
  ) => call<Draft>("PATCH", `/api/generations/${id}/drafts/${platform}`, patch),
  share: (id: string, platform: PlatformId, day: string) =>
    call<void>("POST", `/api/generations/${id}/share`, { platform, day }),
  githubCredential: () =>
    call<{ configured: boolean; hint: string | null; updatedAt: string | null }>(
      "GET",
      "/api/credentials/github",
    ),
  saveGithubToken: (token: string) =>
    call<{ configured: boolean; hint: string | null }>("PUT", "/api/credentials/github", {
      token,
    }),
  deleteGithubToken: () => call<void>("DELETE", "/api/credentials/github"),
  voice: () => call<VoiceState>("GET", "/api/voice"),
  saveVoice: (profile: VoiceProfile) => call<VoiceState>("PUT", "/api/voice", { profile }),
  learnVoice: (samples: string) => call<VoiceState>("POST", "/api/voice/learn", { samples }),
  usage: () => call<UsageReport>("GET", "/api/usage"),
  schedule: () => call<ScheduleReport>("GET", "/api/schedule"),
  saveSchedule: (input: ScheduleInput) => call<ScheduleReport>("PUT", "/api/schedule", input),
  testSchedule: () => call<{ sent: string[]; errors: string[] }>("POST", "/api/schedule/test"),
  runSchedule: () =>
    call<{ run: ScheduleRun; report: ScheduleReport }>("POST", "/api/schedule/run"),
  billingCheckout: () => call<{ url: string }>("POST", "/api/billing/checkout"),
  billingPortal: () => call<{ url: string }>("POST", "/api/billing/portal"),
};

/** The viewer's local calendar day, used for streaks. */
export function localDay(date = new Date()): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}
