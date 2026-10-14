import { BarChart3, BookOpenCheck, Lock } from "lucide-react";
import { useEffect, useState } from "react";
import type { InsightsReport } from "../../shared/schemas";
import { api } from "../api";
import { useI18n, type TranslationKey } from "../i18n";
import { Badge, ErrorNotice, formatNumber } from "./ui";

/** What readers responded to, from the numbers the author entered after posting. */
export function InsightsPanel({
  onOpen,
  onUpgrade,
}: {
  onOpen: (generationId: string) => void;
  onUpgrade?: () => void;
}) {
  const { t } = useI18n();
  const [report, setReport] = useState<InsightsReport | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api.insights().then(setReport, setError);
  }, []);

  if (error) {
    return (
      <section className="panel">
        <ErrorNotice error={error} />
      </section>
    );
  }
  if (!report) return null;

  const platformLabel = (platform: string) => t(`platform.${platform}` as TranslationKey);
  const maxLift = Math.max(2, ...report.kinds.map((item) => item.avgLift));
  const totals = (
    [
      ["likes", report.totals.likes],
      ["comments", report.totals.comments],
      ["reposts", report.totals.reposts],
      ["saves", report.totals.saves],
      ["views", report.totals.views],
    ] as const
  ).filter(([key, value]) => key !== "views" || value > 0);

  return (
    <section className="panel insights" aria-labelledby="insights-title">
      <h2 id="insights-title" className="panel-title">
        <BarChart3 aria-hidden="true" size={18} />
        {t("insights.title")}
      </h2>
      <p className="muted">{t("insights.subtitle")}</p>

      {report.tracked === 0 ? (
        <p>{t("insights.empty")}</p>
      ) : (
        <>
          <dl className="stat-row">
            <div>
              <dt>{t("insights.tracked")}</dt>
              <dd>{t("insights.posts", { n: report.tracked })}</dd>
            </div>
            {totals.map(([key, value]) => (
              <div key={key}>
                <dt>{t(`metrics.${key}`)}</dt>
                <dd>{formatNumber(value)}</dd>
              </div>
            ))}
          </dl>

          <div className="insights-grid">
            <div>
              <h3 className="insights-heading">{t("insights.platforms")}</h3>
              <table className="insights-table">
                <thead>
                  <tr>
                    <th scope="col">{t("insights.platform")}</th>
                    <th scope="col">{t("insights.count")}</th>
                    <th scope="col" title={t("metrics.scoreHint")}>
                      {t("insights.avg")}
                    </th>
                    <th scope="col">{t("insights.best")}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.platforms.map((item) => (
                    <tr key={item.platform}>
                      <th scope="row">{platformLabel(item.platform)}</th>
                      <td>{formatNumber(item.posts)}</td>
                      <td>{formatNumber(item.avgScore)}</td>
                      <td>{formatNumber(item.bestScore)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div>
              <h3 className="insights-heading">{t("insights.kinds")}</h3>
              {report.kinds.length === 0 ? (
                <p className="muted">{t("insights.kindsEmpty")}</p>
              ) : (
                <>
                  <ul className="lift-list">
                    {report.kinds.map((item) => (
                      <li key={item.kind}>
                        <span className="lift-label">
                          {t(`story.kind.${item.kind}` as TranslationKey)}
                        </span>
                        <span className="lift-track" aria-hidden="true">
                          <span
                            className={`lift-bar${item.avgLift >= 1 ? " lift-up" : ""}`}
                            style={{ width: `${(item.avgLift / maxLift) * 100}%` }}
                          />
                          <span className="lift-par" style={{ left: `${(1 / maxLift) * 100}%` }} />
                        </span>
                        <span className="lift-value">
                          {t("insights.lift", { x: item.avgLift.toFixed(1) })}
                          <span className="muted"> · {t("insights.posts", { n: item.posts })}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="muted small">{t("insights.kindsHint")}</p>
                </>
              )}
            </div>
          </div>

          {report.top.length > 0 ? (
            <>
              <h3 className="insights-heading">{t("insights.top")}</h3>
              <ul className="top-posts">
                {report.top.map((post) => (
                  <li key={`${post.generationId}-${post.platform}`}>
                    <button
                      type="button"
                      className="top-post"
                      onClick={() => onOpen(post.generationId)}
                    >
                      <span className="top-post-meta">
                        <Badge>{platformLabel(post.platform)}</Badge>
                        {post.kinds.map((kind) => (
                          <Badge key={kind} tone={kind}>
                            {t(`story.kind.${kind}` as TranslationKey)}
                          </Badge>
                        ))}
                        {post.lift !== null ? (
                          <span
                            className={`top-post-lift${post.lift > 1 ? " top-post-lift-up" : ""}`}
                          >
                            {t("insights.lift", { x: post.lift.toFixed(1) })}
                          </span>
                        ) : null}
                      </span>
                      <span className="top-post-text">{post.excerpt}</span>
                      <span className="muted">
                        {t("metrics.likes")} {formatNumber(post.metrics.likes)} ·{" "}
                        {t("metrics.comments")} {formatNumber(post.metrics.comments)} ·{" "}
                        {t("metrics.reposts")} {formatNumber(post.metrics.reposts)} ·{" "}
                        {post.metrics.saves > 0
                          ? `${t("metrics.saves")} ${formatNumber(post.metrics.saves)} · `
                          : ""}
                        {t("metrics.score")} {formatNumber(post.metrics.score)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      )}

      {report.pending.length > 0 ? (
        <>
          <h3 className="insights-heading">{t("insights.pending")}</h3>
          <ul className="pending-posts">
            {report.pending.map((item) => (
              <li key={`${item.generationId}-${item.platform}`}>
                <Badge>{platformLabel(item.platform)}</Badge>
                <span className="pending-headline">{item.headline}</span>
                <span className="muted">{item.sharedDay}</span>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => onOpen(item.generationId)}
                >
                  {t("insights.fill")}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <p className="learning-note">
        {report.learning.allowed ? (
          <>
            <BookOpenCheck aria-hidden="true" size={16} />
            {report.learning.exemplars > 0
              ? t("insights.learning.on", { n: report.learning.exemplars })
              : t("insights.learning.waiting")}
          </>
        ) : (
          <>
            <Lock aria-hidden="true" size={16} />
            {t("insights.learning.locked")}
            {onUpgrade ? (
              <button type="button" className="link-button" onClick={onUpgrade}>
                {t("billing.upgrade")}
              </button>
            ) : null}
          </>
        )}
      </p>
    </section>
  );
}
