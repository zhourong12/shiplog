import { ArrowLeft, Bot, FileText } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { GenerationSummary } from "../../shared/schemas";
import { api, type GenerationDetail } from "../api";
import { GenerationView } from "../components/GenerationView";
import { InsightsPanel } from "../components/InsightsPanel";
import { Badge, ErrorNotice, Spinner, formatDateTime } from "../components/ui";
import { useI18n, type TranslationKey } from "../i18n";

export function HistoryPage({
  openId = null,
  onClose,
  onUpgrade,
}: {
  /** Generation to open, from a #history/<id> link (e.g. in a reminder email). */
  openId?: string | null;
  onClose?: () => void;
  onUpgrade?: () => void;
}) {
  const { t, lang } = useI18n();
  const [items, setItems] = useState<GenerationSummary[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<GenerationDetail | null>(null);

  const load = useCallback(() => {
    setError(null);
    api.generations().then(setItems, setError);
  }, []);
  useEffect(load, [load]);

  const openGeneration = async (id: string) => {
    try {
      setOpen(await api.generation(id));
      window.scrollTo({ top: 0 });
    } catch (caught) {
      setError(caught);
    }
  };

  useEffect(() => {
    if (!openId) return;
    let cancelled = false;
    api.generation(openId).then(
      (result) => !cancelled && setOpen(result),
      (caught: unknown) => !cancelled && setError(caught),
    );
    return () => {
      cancelled = true;
    };
  }, [openId]);

  if (open) {
    return (
      <div className="page">
        <button
          type="button"
          className="btn btn-quiet back"
          onClick={() => {
            setOpen(null);
            onClose?.();
            load();
          }}
        >
          <ArrowLeft aria-hidden="true" size={16} />
          {t("history.back")}
        </button>
        <GenerationView
          key={open.id}
          initial={open}
          initialShared={open.sharedPlatforms}
          initialMetrics={open.metrics}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <h1 className="visually-hidden">{t("history.title")}</h1>
      {items && items.length > 0 ? (
        <InsightsPanel onOpen={openGeneration} onUpgrade={onUpgrade} />
      ) : null}
      <section className="panel" aria-labelledby="history-list-title">
        <h2 id="history-list-title" className="panel-title">
          {t("history.title")}
        </h2>
        {error ? <ErrorNotice error={error} onRetry={load} /> : null}
        {!items && !error ? <Spinner label={t("common.loading")} /> : null}
        {items && items.length === 0 ? <p className="muted">{t("history.empty")}</p> : null}
        {items && items.length > 0 ? (
          <ul className="history-list">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="history-item"
                  onClick={() => openGeneration(item.id)}
                >
                  <span className="history-top">
                    <Badge tone={item.mode === "ai" ? "ai" : "neutral"}>
                      {item.mode === "ai" ? (
                        <Bot aria-hidden="true" size={14} />
                      ) : (
                        <FileText aria-hidden="true" size={14} />
                      )}
                      {item.mode === "ai" ? t("result.ai") : t("result.baseline")}
                    </Badge>
                    <span className="muted">
                      {formatDateTime(item.createdAt, lang)} · {item.repoLabel} · {item.commits}{" "}
                      {t("result.commits")}
                    </span>
                  </span>
                  <span className="history-headline">{item.dayHeadline ?? item.repoLabel}</span>
                  {item.sharedPlatforms.length > 0 ? (
                    <span className="muted">
                      {t("history.shared", {
                        platforms: item.sharedPlatforms
                          .map((platform) => t(`platform.${platform}` as TranslationKey))
                          .join("、"),
                      })}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
