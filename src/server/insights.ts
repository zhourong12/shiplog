import type { ActivityDay, Collection, Milestone } from "../shared/schemas.js";

const lifetimeThresholds = [100, 250, 500, 1000, 2000, 5000, 10000];

/** Milestones worth a post, derived only from repository facts. */
export function detectMilestones(collection: Collection): Milestone[] {
  const milestones: Milestone[] = [];
  const { lifetimeCommits, totals } = collection;
  if (lifetimeCommits !== null && totals.commits > 0) {
    const before = lifetimeCommits - totals.commits;
    const crossed = lifetimeThresholds.filter(
      (value) => before < value && lifetimeCommits >= value,
    );
    const top = crossed.at(-1);
    if (top !== undefined) {
      milestones.push({ kind: "lifetime_commits", label: `第 ${top} 次提交`, value: String(top) });
    }
  }
  for (const tag of collection.tags) {
    milestones.push({ kind: "release", label: `发布 ${tag.name}`, value: tag.name });
  }
  if (collection.firstCommitAt) {
    const first = new Date(collection.firstCommitAt);
    const since = new Date(collection.window.since);
    const until = new Date(collection.window.until);
    for (let year = since.getUTCFullYear(); year <= until.getUTCFullYear(); year += 1) {
      const age = year - first.getUTCFullYear();
      if (age < 1) continue;
      const anniversary = new Date(
        Date.UTC(year, first.getUTCMonth(), first.getUTCDate(), first.getUTCHours()),
      );
      if (anniversary >= since && anniversary <= until) {
        milestones.push({
          kind: "project_birthday",
          label: `项目 ${age} 周年`,
          value: String(age),
        });
      }
    }
  }
  return milestones;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/** Consecutive days ending today (or yesterday, so an unfinished today keeps the streak). */
export function currentStreak(days: Iterable<string>, today: string): number {
  const set = new Set(days);
  let cursor = new Date(`${today}T00:00:00Z`);
  if (!set.has(isoDay(cursor))) cursor = addDays(cursor, -1);
  let streak = 0;
  while (set.has(isoDay(cursor))) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

export function longestStreak(days: Iterable<string>): number {
  const sorted = [...new Set(days)].sort();
  let best = 0;
  let run = 0;
  let previous: string | null = null;
  for (const day of sorted) {
    run = previous && isoDay(addDays(new Date(`${previous}T00:00:00Z`), 1)) === day ? run + 1 : 1;
    best = Math.max(best, run);
    previous = day;
  }
  return best;
}

export function buildActivity(
  commitDays: Record<string, number>,
  sharedDays: Set<string>,
  today: string,
  days: number,
): ActivityDay[] {
  const end = new Date(`${today}T00:00:00Z`);
  const result: ActivityDay[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = isoDay(addDays(end, -offset));
    result.push({ day, commits: commitDays[day] ?? 0, shared: sharedDays.has(day) });
  }
  return result;
}

const languageByExtension: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  py: "Python",
  go: "Go",
  rs: "Rust",
  java: "Java",
  kt: "Kotlin",
  swift: "Swift",
  rb: "Ruby",
  php: "PHP",
  cs: "C#",
  c: "C",
  h: "C",
  cpp: "C++",
  cc: "C++",
  hpp: "C++",
  vue: "Vue",
  svelte: "Svelte",
  css: "CSS",
  scss: "CSS",
  less: "CSS",
  html: "HTML",
  md: "Markdown",
  mdx: "Markdown",
  sql: "SQL",
  sh: "Shell",
  yml: "YAML",
  yaml: "YAML",
  json: "JSON",
  dart: "Dart",
  lua: "Lua",
};

export function languageOf(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return languageByExtension[extension] ?? "其他";
}

export interface ChangeBreakdown {
  topFiles: Array<{ path: string; lines: number }>;
  languages: Array<{ language: string; lines: number }>;
}

/** Lines changed per file and per language, excluding lockfiles and generated output. */
export function changeBreakdown(collection: Collection, limit = 5): ChangeBreakdown {
  const byFile = new Map<string, number>();
  const byLanguage = new Map<string, number>();
  for (const commit of collection.commits) {
    for (const file of commit.files) {
      if (file.excludedReason) continue;
      const lines = file.additions + file.deletions;
      if (lines === 0) continue;
      byFile.set(file.path, (byFile.get(file.path) ?? 0) + lines);
      const language = languageOf(file.path);
      byLanguage.set(language, (byLanguage.get(language) ?? 0) + lines);
    }
  }
  const sortDesc = <T extends { lines: number }>(items: T[]) =>
    items.sort((a, b) => b.lines - a.lines);
  return {
    topFiles: sortDesc([...byFile].map(([path, lines]) => ({ path, lines }))).slice(0, limit),
    languages: sortDesc([...byLanguage].map(([language, lines]) => ({ language, lines }))).slice(
      0,
      limit,
    ),
  };
}
