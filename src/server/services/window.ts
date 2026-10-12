import type { CollectionWindow } from "../../shared/schemas.js";
import { HttpError } from "./errors.js";

export const MAX_WINDOW_DAYS = 31;

/** "24h", "3d", "1w" or an ISO date/time, relative to now. */
export function parseSince(value: string, now: Date): Date {
  const relative = /^(\d{1,3})([hdw])$/.exec(value.trim());
  if (relative) {
    const amount = Number(relative[1]);
    const hours =
      relative[2] === "h" ? amount : relative[2] === "d" ? amount * 24 : amount * 24 * 7;
    return new Date(now.getTime() - hours * 3600_000);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new HttpError(400, "invalid_window", `无法识别的时间：${value}`);
  return date;
}

export function validateWindow(since: string, until: string): CollectionWindow {
  const start = new Date(since);
  const end = new Date(until);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new HttpError(400, "invalid_window", "时间范围格式不正确。");
  }
  if (start >= end) throw new HttpError(400, "invalid_window", "开始时间必须早于结束时间。");
  if (end.getTime() - start.getTime() > MAX_WINDOW_DAYS * 86_400_000) {
    throw new HttpError(400, "invalid_window", `时间范围不能超过 ${MAX_WINDOW_DAYS} 天。`);
  }
  return { since: start.toISOString(), until: end.toISOString() };
}

export function isIsoDay(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())
  );
}

/** Accept the client's local "today" only when it is within a day of the server's clock. */
export function resolveToday(clientDay: string | undefined, now: Date): string {
  const serverDay = now.toISOString().slice(0, 10);
  if (!clientDay || !isIsoDay(clientDay)) return serverDay;
  const diff = Math.abs(
    new Date(`${clientDay}T00:00:00Z`).getTime() - new Date(`${serverDay}T00:00:00Z`).getTime(),
  );
  return diff <= 86_400_000 ? clientDay : serverDay;
}
