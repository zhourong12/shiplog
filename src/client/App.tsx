import { Bot, CalendarDays, History, Languages, PenLine, Settings } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { HealthReport, RepoSummary, UsageReport } from "../shared/schemas";
import { ApiError, api } from "./api";
import { ErrorNotice, Spinner } from "./components/ui";
import { useI18n, type TranslationKey } from "./i18n";
import { HistoryPage } from "./pages/HistoryPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TodayPage } from "./pages/TodayPage";
import { VoicePage } from "./pages/VoicePage";

type PageId = "today" | "history" | "voice" | "settings";

const nav: Array<{ id: PageId; label: TranslationKey; icon: ReactNode }> = [
  { id: "today", label: "nav.today", icon: <CalendarDays aria-hidden="true" size={18} /> },
  { id: "history", label: "nav.history", icon: <History aria-hidden="true" size={18} /> },
  { id: "voice", label: "nav.voice", icon: <PenLine aria-hidden="true" size={18} /> },
  { id: "settings", label: "nav.settings", icon: <Settings aria-hidden="true" size={18} /> },
];

export function App() {
  const { t, lang, setLang } = useI18n();
  const [page, setPage] = useState<PageId>("today");
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [repos, setRepos] = useState<RepoSummary[] | null>(null);
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const nextHealth = await api.health();
      setHealth(nextHealth);
      const [nextRepos, nextUsage] = await Promise.all([api.repos(), api.usage()]);
      setRepos(nextRepos);
      setUsage(nextUsage);
    } catch (caught) {
      setError(caught);
      // An auth error should still let the user reach Settings to enter the token.
      if (caught instanceof ApiError && caught.status === 401) {
        setRepos([]);
        setPage("settings");
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshRepos = useCallback(() => {
    void api.repos().then(setRepos, setError);
    void api.usage().then(setUsage, () => undefined);
  }, []);

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ⛵
          </span>
          <div>
            <div className="brand-name">ShipLog · 码上说</div>
            <div className="brand-tagline">{t("brand.tagline")}</div>
          </div>
        </div>
        <nav aria-label={t("nav.main")} className="nav">
          {nav.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`nav-item${page === item.id ? " nav-active" : ""}`}
              aria-current={page === item.id ? "page" : undefined}
              onClick={() => setPage(item.id)}
            >
              {item.icon}
              <span>{t(item.label)}</span>
            </button>
          ))}
        </nav>
        <div className="topbar-meta">
          {health ? (
            <span className={`ai-status ${health.ai.configured ? "ai-on" : "ai-off"}`}>
              <Bot aria-hidden="true" size={16} />
              {health.ai.configured ? t("ai.on", { model: health.ai.model ?? "" }) : t("ai.off")}
            </span>
          ) : null}
          {health ? (
            <span className={`plan plan-${health.plan}`}>
              {t(health.plan === "pro" ? "plan.pro" : "plan.free")}
            </span>
          ) : null}
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => setLang(lang === "zh" ? "en" : "zh")}
          >
            <Languages aria-hidden="true" size={16} />
            {t("lang.switch")}
          </button>
        </div>
      </header>

      <main id="main" tabIndex={-1}>
        {error ? (
          <div className="page">
            <ErrorNotice error={error} onRetry={() => void load()} />
          </div>
        ) : null}
        {!health || !repos ? (
          !error ? (
            <div className="page">
              <Spinner label={t("common.loading")} />
            </div>
          ) : null
        ) : (
          <>
            {page === "today" ? (
              <TodayPage health={health} repos={repos} onGoToSettings={() => setPage("settings")} />
            ) : null}
            {page === "history" ? <HistoryPage /> : null}
            {page === "voice" ? <VoicePage health={health} usage={usage} /> : null}
            {page === "settings" ? (
              <SettingsPage
                health={health}
                repos={repos}
                usage={usage}
                onReposChanged={refreshRepos}
                onTokenChanged={() => void load()}
              />
            ) : null}
          </>
        )}
      </main>
    </div>
  );
}
