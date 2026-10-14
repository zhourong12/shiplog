import {
  AlarmClock,
  CheckCircle2,
  CircleDashed,
  Lock,
  Play,
  Send,
  SkipForward,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  platformIds,
  webhookKinds,
  type PlatformId,
  type RepoSummary,
  type ScheduleReport,
  type ScheduleRun,
  type WebhookKind,
} from "../../shared/schemas";
import { api } from "../api";
import { Badge, ErrorNotice, Notice, Spinner, formatDateTime } from "../components/ui";
import { useI18n, type TranslationKey } from "../i18n";

const commonZones = [
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Taipei",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "America/Los_Angeles",
  "UTC",
];

const runIcon: Record<ScheduleRun["status"], ReactNode> = {
  success: <CheckCircle2 aria-hidden="true" size={16} className="run-success" />,
  skipped: <SkipForward aria-hidden="true" size={16} className="run-skipped" />,
  failed: <XCircle aria-hidden="true" size={16} className="run-failed" />,
  running: <CircleDashed aria-hidden="true" size={16} />,
};

export function SchedulePage({
  repos,
  onUpgrade,
}: {
  repos: RepoSummary[];
  onUpgrade: () => void;
}) {
  const { t, lang } = useI18n();
  const browserZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);
  const [report, setReport] = useState<ScheduleReport | null>(null);
  const [form, setForm] = useState<ScheduleReport["settings"] | null>(null);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | "run" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const apply = (next: ScheduleReport) => {
    setReport(next);
    setForm({
      ...next.settings,
      repoId: next.settings.repoId ?? repos[0]?.id ?? null,
      // A never-saved schedule starts in the viewer's own time zone.
      timezone: next.settings.enabled ? next.settings.timezone : browserZone,
    });
  };

  useEffect(() => {
    api.schedule().then(apply, setError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!report || !form) {
    return (
      <div className="page">
        {error ? <ErrorNotice error={error} /> : <Spinner label={t("common.loading")} />}
      </div>
    );
  }

  const locked = !report.allowed;
  const zones = commonZones.includes(form.timezone) ? commonZones : [form.timezone, ...commonZones];

  async function act(kind: "save" | "test" | "run", event?: FormEvent) {
    event?.preventDefault();
    if (!form) return;
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      if (kind === "save") {
        apply(
          await api.saveSchedule({
            enabled: form.enabled,
            repoId: form.repoId,
            time: form.time,
            timezone: form.timezone,
            platforms: form.platforms,
            windowHours: form.windowHours,
            skipEmpty: form.skipEmpty,
            notifyEmail: form.notifyEmail?.trim() || null,
            webhookKind: form.webhookKind,
            ...(webhookUrl.trim() ? { webhookUrl: webhookUrl.trim() } : {}),
          }),
        );
        setWebhookUrl("");
        setNotice(t("schedule.saved"));
      } else if (kind === "test") {
        const result = await api.testSchedule();
        const channels = result.sent
          .map((channel) => t(`schedule.channel.${channel}` as TranslationKey))
          .join("、");
        if (result.errors.length > 0) setError(new Error(result.errors.join("；")));
        if (result.sent.length > 0) setNotice(t("schedule.testSent", { channels }));
      } else {
        const result = await api.runSchedule();
        apply(result.report);
      }
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(null);
    }
  }

  async function removeWebhook() {
    if (!form) return;
    setBusy("save");
    setError(null);
    try {
      apply(
        await api.saveSchedule({
          ...form,
          notifyEmail: form.notifyEmail?.trim() || null,
          webhookUrl: "",
        }),
      );
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(null);
    }
  }

  const togglePlatform = (platform: PlatformId) =>
    setForm({
      ...form,
      platforms: form.platforms.includes(platform)
        ? form.platforms.filter((item) => item !== platform)
        : platformIds.filter((item) => item === platform || form.platforms.includes(item)),
    });

  return (
    <div className="page schedule">
      <section className="panel" aria-labelledby="schedule-title">
        <div className="panel-heading">
          <h1 id="schedule-title" className="panel-title">
            <AlarmClock aria-hidden="true" size={20} />
            {t("schedule.title")}
          </h1>
          {locked ? (
            <Badge tone="pro">
              <Lock aria-hidden="true" size={14} />
              Pro
            </Badge>
          ) : (
            <Badge tone={report.nextRunAt ? "ai" : "neutral"}>
              {report.nextRunAt
                ? t("schedule.next", {
                    // Shown in the schedule's own zone, matching the time the user picked.
                    time: `${formatDateTime(report.nextRunAt, lang, report.settings.timezone)}${
                      report.settings.timezone === browserZone
                        ? ""
                        : ` (${report.settings.timezone})`
                    }`,
                  })
                : t("schedule.off")}
            </Badge>
          )}
        </div>
        <p className="muted">{t("schedule.subtitle")}</p>
        {locked ? (
          <Notice
            tone="info"
            action={
              <button type="button" className="btn btn-primary" onClick={onUpgrade}>
                {t("schedule.upgrade")}
              </button>
            }
          >
            {t("schedule.pro")}
          </Notice>
        ) : null}
        {notice ? <Notice tone="success">{notice}</Notice> : null}
        {error ? <ErrorNotice error={error} /> : null}

        <form onSubmit={(event) => act("save", event)}>
          <fieldset className="schedule-fields" disabled={locked}>
            <label className="check">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
              />
              {t("schedule.enabled")}
            </label>

            <div className="form-grid">
              <div className="field">
                <label htmlFor="schedule-repo">{t("schedule.repo")}</label>
                <select
                  id="schedule-repo"
                  value={form.repoId ?? ""}
                  onChange={(event) =>
                    setForm({ ...form, repoId: Number(event.target.value) || null })
                  }
                >
                  {repos.map((repo) => (
                    <option key={repo.id} value={repo.id}>
                      {repo.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="schedule-time">{t("schedule.time")}</label>
                <input
                  id="schedule-time"
                  type="time"
                  value={form.time}
                  onChange={(event) => setForm({ ...form, time: event.target.value })}
                />
              </div>
              <div className="field">
                <label htmlFor="schedule-zone">{t("schedule.timezone")}</label>
                <select
                  id="schedule-zone"
                  value={form.timezone}
                  onChange={(event) => setForm({ ...form, timezone: event.target.value })}
                >
                  {zones.map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="schedule-window">{t("schedule.window")}</label>
                <select
                  id="schedule-window"
                  value={form.windowHours}
                  onChange={(event) =>
                    setForm({ ...form, windowHours: Number(event.target.value) })
                  }
                >
                  {[24, 48, 72, 168].map((hours) => (
                    <option key={hours} value={hours}>
                      {t("schedule.window.hours", { n: hours })}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <label className="check">
              <input
                type="checkbox"
                checked={form.skipEmpty}
                onChange={(event) => setForm({ ...form, skipEmpty: event.target.checked })}
              />
              {t("schedule.skipEmpty")}
            </label>

            <fieldset className="field">
              <legend>{t("schedule.platforms")}</legend>
              <div className="chips">
                {platformIds.map((platform) => {
                  const on = form.platforms.includes(platform);
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

            <h2 className="panel-title">{t("schedule.notify")}</h2>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="schedule-email">{t("schedule.email")}</label>
                <input
                  id="schedule-email"
                  type="email"
                  autoComplete="email"
                  value={form.notifyEmail ?? ""}
                  disabled={!report.emailEnabled}
                  onChange={(event) => setForm({ ...form, notifyEmail: event.target.value })}
                />
                {!report.emailEnabled ? (
                  <span className="hint">{t("schedule.emailDisabled")}</span>
                ) : null}
              </div>
              <div className="field">
                <label htmlFor="schedule-webhook-kind">{t("schedule.webhookKind")}</label>
                <select
                  id="schedule-webhook-kind"
                  value={form.webhookKind ?? ""}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      webhookKind: (event.target.value || null) as WebhookKind | null,
                    })
                  }
                >
                  <option value="">{t("schedule.webhookKind.none")}</option>
                  {webhookKinds.map((kind) => (
                    <option key={kind} value={kind}>
                      {t(`schedule.webhookKind.${kind}` as TranslationKey)}
                    </option>
                  ))}
                </select>
              </div>
              {form.webhookKind ? (
                <div className="field field-wide">
                  <label htmlFor="schedule-webhook-url">{t("schedule.webhookUrl")}</label>
                  <input
                    id="schedule-webhook-url"
                    type="url"
                    autoComplete="off"
                    placeholder="https://"
                    value={webhookUrl}
                    onChange={(event) => setWebhookUrl(event.target.value)}
                  />
                  {report.settings.webhookConfigured ? (
                    <span className="hint">
                      {t("schedule.webhookSaved")}{" "}
                      <button type="button" className="link-button" onClick={removeWebhook}>
                        {t("schedule.webhookRemove")}
                      </button>
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="actions">
              <button type="submit" className="btn btn-primary" disabled={busy !== null}>
                {busy === "save" ? t("common.saving") : t("schedule.save")}
              </button>
              <button
                type="button"
                className="btn btn-quiet"
                disabled={busy !== null}
                onClick={() => act("test")}
              >
                <Send aria-hidden="true" size={16} />
                {t("schedule.test")}
              </button>
              <button
                type="button"
                className="btn btn-quiet"
                disabled={busy !== null || form.repoId === null}
                onClick={() => act("run")}
              >
                <Play aria-hidden="true" size={16} />
                {t("schedule.runNow")}
              </button>
              {busy === "run" ? <Spinner label={t("today.generating")} /> : null}
            </div>
          </fieldset>
        </form>
      </section>

      <section className="panel" aria-labelledby="runs-title">
        <h2 id="runs-title" className="panel-title">
          {t("schedule.runs")}
        </h2>
        {report.runs.length === 0 ? <p className="muted">{t("schedule.runs.empty")}</p> : null}
        <ul className="run-list">
          {report.runs.map((run) => (
            <li key={run.id} className="run">
              <span className="run-status">
                {runIcon[run.status]}
                {t(`schedule.run.${run.status}` as TranslationKey)}
              </span>
              <span className="muted small">
                {formatDateTime(run.startedAt, lang, report.settings.timezone)} ·{" "}
                {t(`schedule.run.${run.trigger}` as TranslationKey)}
              </span>
              {run.message ? <span className="small">{run.message}</span> : null}
              {run.notified.length > 0 ? (
                <span className="muted small">
                  {t("schedule.run.notified", {
                    channels: run.notified
                      .map((channel) => t(`schedule.channel.${channel}` as TranslationKey))
                      .join("、"),
                  })}
                </span>
              ) : null}
              {run.generationId ? (
                <a className="link" href={`#history/${run.generationId}`}>
                  {t("schedule.run.open")}
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
