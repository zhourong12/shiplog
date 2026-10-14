import { BarChart3, ExternalLink } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { PlatformId, PostMetrics, PostMetricsInput } from "../../shared/schemas";
import { api } from "../api";
import { useI18n } from "../i18n";
import { ErrorNotice, formatDateTime, formatNumber } from "./ui";

const countFields = ["likes", "comments", "reposts", "saves", "views"] as const;
type CountField = (typeof countFields)[number];

function toForm(metrics: PostMetrics | null): Record<CountField | "postUrl", string> {
  return {
    postUrl: metrics?.postUrl ?? "",
    likes: metrics ? String(metrics.likes) : "",
    comments: metrics ? String(metrics.comments) : "",
    reposts: metrics ? String(metrics.reposts) : "",
    saves: metrics ? String(metrics.saves) : "",
    views: metrics?.views != null ? String(metrics.views) : "",
  };
}

function parseCount(value: string): number {
  const parsed = Number(value.replace(/[,，\s]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

/** Numbers a published post earned; they feed insights and, on Pro, the writer. */
export function PostMetricsPanel({
  generationId,
  platform,
  metrics,
  onChanged,
}: {
  generationId: string;
  platform: PlatformId;
  metrics: PostMetrics | null;
  onChanged: (metrics: PostMetrics | null) => void;
}) {
  const { t, lang } = useI18n();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(() => toForm(metrics));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const idPrefix = `metrics-${generationId}-${platform}`;

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const input: PostMetricsInput = {
      postUrl: form.postUrl.trim() || null,
      views: form.views.trim() ? parseCount(form.views) : null,
      likes: parseCount(form.likes),
      comments: parseCount(form.comments),
      reposts: parseCount(form.reposts),
      saves: parseCount(form.saves),
    };
    try {
      onChanged(await api.saveMetrics(generationId, platform, input));
      setEditing(false);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api.deleteMetrics(generationId, platform);
      onChanged(null);
      setForm(toForm(null));
      setEditing(false);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="post-metrics" aria-labelledby={`${idPrefix}-title`}>
      <h3 id={`${idPrefix}-title`} className="post-metrics-title">
        <BarChart3 aria-hidden="true" size={16} />
        {t("metrics.title")}
      </h3>

      {editing ? (
        <form onSubmit={save}>
          <div className="metrics-grid">
            {countFields.map((field) => (
              <div className="field" key={field}>
                <label htmlFor={`${idPrefix}-${field}`}>{t(`metrics.${field}`)}</label>
                <input
                  id={`${idPrefix}-${field}`}
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder={field === "views" ? "—" : "0"}
                  value={form[field]}
                  onChange={(event) => setForm({ ...form, [field]: event.target.value })}
                />
              </div>
            ))}
          </div>
          <div className="field">
            <label htmlFor={`${idPrefix}-url`}>{t("metrics.postUrl")}</label>
            <input
              id={`${idPrefix}-url`}
              type="url"
              placeholder="https://"
              value={form.postUrl}
              onChange={(event) => setForm({ ...form, postUrl: event.target.value })}
            />
          </div>
          {error ? <ErrorNotice error={error} /> : null}
          <div className="actions">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? t("common.saving") : t("metrics.save")}
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              disabled={busy}
              onClick={() => {
                setForm(toForm(metrics));
                setEditing(false);
              }}
            >
              {t("metrics.cancel")}
            </button>
            {metrics ? (
              <button type="button" className="btn btn-quiet" disabled={busy} onClick={remove}>
                {t("metrics.remove")}
              </button>
            ) : null}
          </div>
        </form>
      ) : metrics ? (
        <>
          <dl className="metrics-summary">
            {(["likes", "comments", "reposts", "saves"] as const).map((field) => (
              <div key={field}>
                <dt>{t(`metrics.${field}`)}</dt>
                <dd>{formatNumber(metrics[field])}</dd>
              </div>
            ))}
            {metrics.views !== null ? (
              <div>
                <dt>{t("metrics.views")}</dt>
                <dd>{formatNumber(metrics.views)}</dd>
              </div>
            ) : null}
            <div className="metrics-score">
              <dt title={t("metrics.scoreHint")}>{t("metrics.score")}</dt>
              <dd>{formatNumber(metrics.score)}</dd>
            </div>
          </dl>
          <p className="muted metrics-meta">
            {t("metrics.recordedAt", { time: formatDateTime(metrics.recordedAt, lang) })} ·{" "}
            {t("metrics.scoreHint")}
          </p>
          <div className="actions">
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => {
                setForm(toForm(metrics));
                setEditing(true);
              }}
            >
              {t("metrics.edit")}
            </button>
            {metrics.postUrl ? (
              <a
                className="btn btn-quiet"
                href={metrics.postUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                <ExternalLink aria-hidden="true" size={16} />
                {t("metrics.openPost")}
              </a>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <p className="muted">{t("metrics.hint")}</p>
          <button type="button" className="btn btn-quiet" onClick={() => setEditing(true)}>
            {t("metrics.record")}
          </button>
        </>
      )}
    </section>
  );
}
