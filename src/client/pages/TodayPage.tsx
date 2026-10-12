import { Eye, Wand2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  platformIds,
  type ActivityReport,
  type GenerationResult,
  type HealthReport,
  type PlatformId,
  type PreviewReport,
  type RepoSummary,
} from "../../shared/schemas";
import { api, localDay, type TimeWindow } from "../api";
import { ActivityHeatmap } from "../components/ActivityHeatmap";
import { GenerationView } from "../components/GenerationView";
import { Dialog, ErrorNotice, Notice, Spinner } from "../components/ui";
import { useI18n, type TranslationKey } from "../i18n";

type RangeId = "today" | "24h" | "3d" | "7d" | "custom";
const ranges: RangeId[] = ["today", "24h", "3d", "7d", "custom"];

function toLocalInput(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function windowFor(range: RangeId, custom: { since: string; until: string }): TimeWindow {
  const now = new Date();
  if (range === "custom") {
    return {
      since: new Date(custom.since).toISOString(),
      until: new Date(custom.until).toISOString(),
    };
  }
  if (range === "today") {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    return { since: midnight.toISOString(), until: now.toISOString() };
  }
  const hours = range === "24h" ? 24 : range === "3d" ? 72 : 168;
  return {
    since: new Date(now.getTime() - hours * 3600_000).toISOString(),
    until: now.toISOString(),
  };
}

function loadPlatforms(): PlatformId[] {
  try {
    const saved = JSON.parse(localStorage.getItem("shiplog-platforms") ?? "null") as unknown;
    if (Array.isArray(saved)) {
      const valid = saved.filter((item): item is PlatformId =>
        (platformIds as readonly string[]).includes(String(item)),
      );
      if (valid.length > 0) return valid;
    }
  } catch {
    // Fall through to defaults.
  }
  return ["jike", "xiaohongshu", "x", "changelog"];
}

export function TodayPage({
  health,
  repos,
  onGoToSettings,
}: {
  health: HealthReport;
  repos: RepoSummary[];
  onGoToSettings: () => void;
}) {
  const { t } = useI18n();
  const [repoId, setRepoId] = useState<number | null>(repos[0]?.id ?? null);
  const [range, setRange] = useState<RangeId>("today");
  const [custom, setCustom] = useState(() => ({
    since: toLocalInput(new Date(Date.now() - 86_400_000)),
    until: toLocalInput(new Date()),
  }));
  const [platforms, setPlatforms] = useState<PlatformId[]>(loadPlatforms);
  const [activity, setActivity] = useState<ActivityReport | null>(null);
  const [activityError, setActivityError] = useState(false);
  const [result, setResult] = useState<GenerationResult | null>(null);
  const [preview, setPreview] = useState<PreviewReport | null>(null);
  const [busy, setBusy] = useState<"generate" | "preview" | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (repoId === null || !repos.some((repo) => repo.id === repoId))
      setRepoId(repos[0]?.id ?? null);
  }, [repos, repoId]);

  const loadActivity = useCallback(() => {
    if (repoId === null) return;
    setActivityError(false);
    api.activity(repoId, localDay()).then(setActivity, () => setActivityError(true));
  }, [repoId]);
  useEffect(loadActivity, [loadActivity]);

  const togglePlatform = (platform: PlatformId) => {
    setPlatforms((previous) => {
      const next = previous.includes(platform)
        ? previous.filter((item) => item !== platform)
        : platformIds.filter((item) => item === platform || previous.includes(item));
      try {
        localStorage.setItem("shiplog-platforms", JSON.stringify(next));
      } catch {
        // Ignore unavailable storage.
      }
      return next;
    });
  };

  const timeWindow = useMemo(() => {
    try {
      return windowFor(range, custom);
    } catch {
      return null;
    }
  }, [range, custom]);

  async function run(kind: "generate" | "preview") {
    if (repoId === null || !timeWindow) return;
    setBusy(kind);
    setError(null);
    try {
      if (kind === "preview") setPreview(await api.preview(repoId, timeWindow));
      else {
        setResult(null);
        setResult(await api.generate(repoId, timeWindow, platforms, localDay()));
        loadActivity();
      }
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(null);
    }
  }

  if (repos.length === 0) {
    return (
      <div className="page">
        <section className="panel empty-state">
          <h1>{t("today.noRepo.title")}</h1>
          <p>{t("today.noRepo.body")}</p>
          <button type="button" className="btn btn-primary" onClick={onGoToSettings}>
            {t("today.noRepo.action")}
          </button>
        </section>
      </div>
    );
  }

  return (
    <div className="page today">
      <div className="today-main">
        <section className="panel composer" aria-labelledby="today-title">
          <h1 id="today-title">{t("today.title")}</h1>
          <p className="muted">{t("today.subtitle")}</p>

          <div className="composer-grid">
            <div className="field">
              <label htmlFor="repo-select">{t("today.repo")}</label>
              <select
                id="repo-select"
                value={repoId ?? ""}
                onChange={(event) => {
                  setRepoId(Number(event.target.value));
                  setResult(null);
                }}
              >
                {repos.map((repo) => (
                  <option key={repo.id} value={repo.id}>
                    {repo.label}
                  </option>
                ))}
              </select>
            </div>

            <fieldset className="field">
              <legend>{t("today.range")}</legend>
              <div className="chips">
                {ranges.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={`chip${range === value ? " chip-on" : ""}`}
                    aria-pressed={range === value}
                    onClick={() => setRange(value)}
                  >
                    {t(`today.range.${value}` as TranslationKey)}
                  </button>
                ))}
              </div>
              {range === "custom" ? (
                <div className="custom-range">
                  <label>
                    {t("today.range.since")}
                    <input
                      type="datetime-local"
                      value={custom.since}
                      onChange={(event) =>
                        setCustom((previous) => ({ ...previous, since: event.target.value }))
                      }
                    />
                  </label>
                  <label>
                    {t("today.range.until")}
                    <input
                      type="datetime-local"
                      value={custom.until}
                      onChange={(event) =>
                        setCustom((previous) => ({ ...previous, until: event.target.value }))
                      }
                    />
                  </label>
                </div>
              ) : null}
            </fieldset>
          </div>

          <fieldset className="field">
            <legend>{t("today.platforms")}</legend>
            <div className="chips">
              {platformIds.map((platform) => {
                const on = platforms.includes(platform);
                return (
                  <button
                    key={platform}
                    type="button"
                    className={`chip${on ? " chip-on" : ""}`}
                    aria-pressed={on}
                    onClick={() => togglePlatform(platform)}
                  >
                    <span aria-hidden="true">{on ? "✓" : "+"}</span>
                    {t(`platform.${platform}` as TranslationKey)}
                  </button>
                );
              })}
            </div>
          </fieldset>

          {platforms.length === 0 ? (
            <Notice tone="warning">{t("today.pickPlatform")}</Notice>
          ) : null}

          <div className="actions">
            <button
              type="button"
              className="btn btn-primary btn-large"
              disabled={busy !== null || platforms.length === 0 || !timeWindow}
              onClick={() => run("generate")}
            >
              <Wand2 aria-hidden="true" size={18} />
              {health.ai.configured ? t("today.generate") : t("today.generateBaseline")}
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              disabled={busy !== null || !timeWindow}
              onClick={() => run("preview")}
            >
              <Eye aria-hidden="true" size={18} />
              {t("today.preview")}
            </button>
            {busy === "generate" ? <Spinner label={t("today.generating")} /> : null}
            {busy === "preview" ? <Spinner label={t("common.loading")} /> : null}
          </div>
          {error ? <ErrorNotice error={error} /> : null}
        </section>

        {result ? (
          <GenerationView key={result.id} initial={result} onShared={loadActivity} />
        ) : null}
      </div>

      <aside className="today-side">
        {activity ? <ActivityHeatmap report={activity} /> : null}
        {!activity && !activityError ? <Spinner label={t("common.loading")} /> : null}
        {activityError ? <Notice tone="warning">{t("activity.unavailable")}</Notice> : null}
      </aside>

      {preview ? (
        <Dialog title={t("preview.title")} onClose={() => setPreview(null)}>
          <p>{t("preview.body")}</p>
          <p className="muted">
            {t("preview.stats", {
              commits: preview.totals.commits,
              redacted: preview.redactionCount,
              excluded: preview.excludedFileCount,
            })}
          </p>
          <pre className="payload">{preview.aiPayload}</pre>
        </Dialog>
      ) : null}
    </div>
  );
}
