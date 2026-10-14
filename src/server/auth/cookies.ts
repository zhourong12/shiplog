export const SESSION_COOKIE = "shiplog_session";
export const OAUTH_STATE_COOKIE = "shiplog_oauth";
export const SESSION_TTL_MS = 30 * 24 * 3600_000;

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

export interface CookieOptions {
  maxAgeSeconds: number;
  secure: boolean;
  path?: string;
}

/** HttpOnly + SameSite=Lax: unreadable from scripts and not sent on cross-site POSTs. */
export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path ?? "/"}`,
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

/** Only same-site relative paths, so `next` cannot send users to another site after login. */
export function safeRedirectPath(next: unknown): string {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//")) return "/";
  if (next.includes("\\") || /[\r\n]/.test(next)) return "/";
  return next;
}
