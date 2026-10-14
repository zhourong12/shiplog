import { Bot, CalendarDays, History, Languages, LogOut, PenLine, Settings } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { HealthReport, MeReport, RepoSummary, UsageReport } from "../shared/schemas";
import { ApiError, api } from "./api";
import { ErrorNotice, Spinner } from "./components/ui";
import { useI18n, type TranslationKey } from "./i18n";
import { HistoryPage } from "./pages/HistoryPage";
import { LandingPage } from "./pages/LandingPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TodayPage } from "./pages/TodayPage";
import { VoicePage } from "./pages/VoicePage";

type PageId = "today" | "history" | "voice" | "settings";
const pageIds: PageId[] = ["today", "history", "voice", "settings"];

const nav: Array<{ id: PageId; label: TranslationKey; icon: ReactNode }> = [
  { id: "today", label: "nav.today", icon: <CalendarDays aria-hidden="true" size={18} /> },
  { id: "history", label: "nav.history", icon: <History aria-hidden="true" size={18} /> },
  { id: "voice", label: "nav.voice", icon: <PenLine aria-hidden="true" size={18} /> },
  { id: "settings", label: "nav.settings", icon: <Settings aria-hidden="true" size={18} /> },
];

/** The current page lives in the URL hash so reloads and links keep it. */
function pageFromHash(): PageId {
  const id = window.location.hash.replace(/^#\/?/, "") as PageId;
  return pageIds.includes(id) ? id : "today";
}

function queryFlag(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

export function App() {
  const { t, lang, setLang } = useI18n();
  const [page, setPageState] = useState<PageId>(pageFromHash);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [me, setMe] = useState<MeReport | null>(null);
  const [repos, setRepos] = useState<RepoSummary[] | null>(null);
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [needsToken, setNeedsToken] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [loginError] = useState(() => queryFlag("login_error") !== null);
  const [billingResult] = useState(() => queryFlag("billing"));

  const setPage = useCallback((next: PageId) => {
    setPageState(next);
    if (window.location.hash !== `#${next}`) window.history.replaceState(null, "", `#${next}`);
  }, []);

  useEffect(() => {
    const onHash = () => setPageState(pageFromHash());
    window.addEventListener("hashchange", onHash);
    // Drop one-off query flags (?login_error, ?billing) from the address bar.
    if (window.location.search) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
    }
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const nextHealth = await api.health();
      setHealth(nextHealth);
      let nextMe: MeReport;
      try {
        nextMe = await api.me();
      } catch (caught) {
        // Local mode with SHIPLOG_APP_TOKEN: let the user enter the token in Settings.
        if (caught instanceof ApiError && caught.status === 401) {
          setNeedsToken(true);
          setRepos([]);
          setPage("settings");
          return;
        }
        throw caught;
      }
      setNeedsToken(false);
      setMe(nextMe);
      if (!nextMe.authenticated) return;
      const [nextRepos, nextUsage] = await Promise.all([api.repos(), api.usage()]);
      setRepos(nextRepos);
      setUsage(nextUsage);
    } catch (caught) {
      setError(caught);
    }
  }, [setPage]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(() => {
    void api.repos().then(setRepos, setError);
    void api.usage().then(setUsage, () => undefined);
    void api.me().then(setMe, () => undefined);
  }, []);

  const signedOut = health?.authMode === "github" && me !== null && !me.authenticated;
  const plan = usage?.plan ?? me?.plan ?? "free";

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
        {!signedOut ? (
          <nav aria-label={t("nav.main")} className="nav">
            {nav.map((item) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                className={`nav-item${page === item.id ? " nav-active" : ""}`}
                aria-current={page === item.id ? "page" : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  setPage(item.id);
                }}
              >
                {item.icon}
                <span>{t(item.label)}</span>
              </a>
            ))}
          </nav>
        ) : null}
        <div className="topbar-meta">
          {health && !signedOut ? (
            <span className={`ai-status ${health.ai.configured ? "ai-on" : "ai-off"}`}>
              <Bot aria-hidden="true" size={16} />
              {health.ai.configured ? t("ai.on", { model: health.ai.model ?? "" }) : t("ai.off")}
            </span>
          ) : null}
          {me?.authenticated ? (
            <span className={`plan plan-${plan}`}>
              {t(plan === "pro" ? "plan.pro" : "plan.free")}
            </span>
          ) : null}
          {me?.authMode === "github" && me.user ? (
            <span className="account">
              {me.user.avatarUrl ? (
                <img className="avatar" src={me.user.avatarUrl} alt="" width={24} height={24} />
              ) : null}
              <span className="account-login">@{me.user.login}</span>
              <button
                type="button"
                className="btn btn-quiet"
                onClick={async () => {
                  await api.logout().catch(() => undefined);
                  setRepos(null);
                  setUsage(null);
                  void load();
                }}
              >
                <LogOut aria-hidden="true" size={16} />
                {t("account.signOut")}
              </button>
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
        {signedOut ? <LandingPage loginError={loginError} /> : null}
        {!signedOut && (!health || !repos) && !error ? (
          <div className="page">
            <Spinner label={t("common.loading")} />
          </div>
        ) : null}
        {!signedOut && health && repos ? (
          <>
            {page === "today" ? (
              <TodayPage health={health} repos={repos} onGoToSettings={() => setPage("settings")} />
            ) : null}
            {page === "history" ? <HistoryPage /> : null}
            {page === "voice" ? <VoicePage health={health} usage={usage} /> : null}
            {page === "settings" ? (
              <SettingsPage
                health={health}
                me={me}
                needsToken={needsToken}
                billingResult={billingResult}
                repos={repos}
                usage={usage}
                onChanged={refresh}
                onTokenChanged={() => void load()}
              />
            ) : null}
          </>
        ) : null}
      </main>
    </div>
  );
}
