const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Wall-clock date and time in an IANA time zone, e.g. Asia/Shanghai. */
export function zonedParts(date: Date, timeZone: string): { day: string; time: string } {
  const parts = formatterFor(timeZone).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
  };
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function isValidTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/**
 * Due once per local day, at or after the configured time. Running "at or after" rather
 * than "exactly at" means a restart or a slow tick does not skip the day.
 */
export function isDue(
  schedule: { time: string; timezone: string; lastRunDay: string | null },
  now: Date,
): { due: boolean; day: string } {
  const local = zonedParts(now, schedule.timezone);
  return { due: local.time >= schedule.time && schedule.lastRunDay !== local.day, day: local.day };
}

/** The next time the schedule will fire, found by stepping minutes (at most two days). */
export function nextRunAt(
  schedule: { time: string; timezone: string; lastRunDay: string | null },
  now: Date,
): Date {
  const start = new Date(Math.ceil(now.getTime() / 60_000) * 60_000);
  for (let minute = 0; minute <= 2 * 24 * 60; minute += 1) {
    const candidate = new Date(start.getTime() + minute * 60_000);
    const local = zonedParts(candidate, schedule.timezone);
    if (local.time === schedule.time && local.day !== schedule.lastRunDay) return candidate;
  }
  return start;
}
