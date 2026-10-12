import { ExternalLink, FolderGit2, Github, KeyRound, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { HealthReport, RepoSummary, UsageReport } from "../../shared/schemas";
import { api, getAppToken, setAppToken } from "../api";
import { Badge, ErrorNotice, Notice, formatNumber } from "../components/ui";
import { useI18n } from "../i18n";

function RepoRow({ repo, onChanged }: { repo: RepoSummary; onChanged: () => void }) {
  const { t } = useI18n();
  const [context, setContext] = useState(repo.productContext ?? "");
  const [error, setError] = useState<unknown>(null);
  const dirty = context !== (repo.productContext ?? "");
  return (
    <li className="repo-row">
      <div className="repo-main">
        {repo.kind === "github" ? (
          <Github aria-hidden="true" size={18} />
        ) : (
          <FolderGit2 aria-hidden="true" size={18} />
        )}
        <div>
          <strong>{repo.label}</strong>
          <div className="muted small">
            {repo.kind === "local" ? repo.localPath : `github.com/${repo.label}`}
          </div>
        </div>
        <button
          type="button"
          className="btn btn-quiet btn-danger"
          onClick={async () => {
            if (!window.confirm(t("settings.repos.confirmDelete", { label: repo.label }))) return;
            try {
              await api.deleteRepo(repo.id);
              onChanged();
            } catch (caught) {
              setError(caught);
            }
          }}
        >
          <Trash2 aria-hidden="true" size={16} />
          {t("common.delete")}
        </button>
      </div>
      <div className="field">
        <label htmlFor={`context-${repo.id}`}>{t("settings.repos.context")}</label>
        <div className="inline-form">
          <input
            id={`context-${repo.id}`}
            value={context}
            maxLength={200}
            onChange={(event) => setContext(event.target.value)}
          />
          <button
            type="button"
            className="btn btn-quiet"
            disabled={!dirty}
            onClick={async () => {
              try {
                await api.updateRepo(repo.id, context.trim() || null);
                onChanged();
              } catch (caught) {
                setError(caught);
              }
            }}
          >
            {t("common.save")}
          </button>
        </div>
      </div>
      {error ? <ErrorNotice error={error} /> : null}
    </li>
  );
}

function AddRepoForm({ health, onAdded }: { health: HealthReport; onAdded: () => void }) {
  const { t } = useI18n();
  const [kind, setKind] = useState<"local" | "github">(
    health.localReposEnabled ? "local" : "github",
  );
  const [path, setPath] = useState("");
  const [fullName, setFullName] = useState({ owner: "", repo: "" });
  const [context, setContext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (kind === "local") await api.addLocalRepo(path.trim(), context.trim() || null);
      else
        await api.addGithubRepo(
          fullName.owner.trim(),
          fullName.repo.trim(),
          context.trim() || null,
        );
      setPath("");
      setFullName({ owner: "", repo: "" });
      setContext("");
      onAdded();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="add-repo" onSubmit={submit}>
      <div className="segmented" role="group">
        {(["local", "github"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={kind === value}
            className={kind === value ? "active" : ""}
            onClick={() => setKind(value)}
          >
            {t(value === "local" ? "settings.repos.local" : "settings.repos.github")}
          </button>
        ))}
      </div>
      {kind === "local" && !health.localReposEnabled ? (
        <Notice tone="warning">{t("settings.repos.localDisabled")}</Notice>
      ) : null}
      {kind === "local" ? (
        <div className="field">
          <label htmlFor="repo-path">{t("settings.repos.path")}</label>
          <input
            id="repo-path"
            value={path}
            required
            placeholder="/home/me/code/my-app"
            onChange={(event) => setPath(event.target.value)}
          />
        </div>
      ) : (
        <div className="form-grid">
          <div className="field">
            <label htmlFor="repo-owner">{t("settings.repos.owner")}</label>
            <input
              id="repo-owner"
              value={fullName.owner}
              required
              onChange={(event) => setFullName({ ...fullName, owner: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="repo-name">{t("settings.repos.name")}</label>
            <input
              id="repo-name"
              value={fullName.repo}
              required
              onChange={(event) => setFullName({ ...fullName, repo: event.target.value })}
            />
          </div>
        </div>
      )}
      <div className="field">
        <label htmlFor="repo-context">
          {t("settings.repos.context")}
          <span className="hint">{t("settings.repos.contextHint")}</span>
        </label>
        <input
          id="repo-context"
          value={context}
          maxLength={200}
          onChange={(event) => setContext(event.target.value)}
        />
      </div>
      {error ? <ErrorNotice error={error} /> : null}
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {t("settings.repos.add")}
        </button>
      </div>
    </form>
  );
}

function GithubTokenSection() {
  const { t } = useI18n();
  const [status, setStatus] = useState<{ configured: boolean; hint: string | null } | null>(null);
  const [token, setToken] = useState("");
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api.githubCredential().then(setStatus, setError);
  }, []);
  return (
    <section className="panel">
      <h2 className="panel-title">
        <KeyRound aria-hidden="true" size={18} />
        {t("settings.github")}
      </h2>
      <p className="muted">{t("settings.github.body")}</p>
      <a
        className="link"
        href="https://github.com/settings/personal-access-tokens/new"
        target="_blank"
        rel="noreferrer noopener"
      >
        <ExternalLink aria-hidden="true" size={14} />
        {t("settings.github.create")}
      </a>
      {status ? (
        <p>
          {status.configured
            ? t("settings.github.configured", { hint: status.hint ?? "" })
            : t("settings.github.notConfigured")}
        </p>
      ) : null}
      <form
        className="inline-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setError(null);
          try {
            setStatus(await api.saveGithubToken(token.trim()));
            setToken("");
          } catch (caught) {
            setError(caught);
          }
        }}
      >
        <label htmlFor="github-token" className="visually-hidden">
          {t("settings.github")}
        </label>
        <input
          id="github-token"
          type="password"
          autoComplete="off"
          value={token}
          placeholder={t("settings.github.placeholder")}
          onChange={(event) => setToken(event.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={token.trim().length < 20}>
          {t("common.save")}
        </button>
        {status?.configured ? (
          <button
            type="button"
            className="btn btn-quiet btn-danger"
            onClick={async () => {
              await api.deleteGithubToken().catch(setError);
              setStatus({ configured: false, hint: null });
            }}
          >
            {t("settings.github.remove")}
          </button>
        ) : null}
      </form>
      {error ? <ErrorNotice error={error} /> : null}
    </section>
  );
}

export function SettingsPage({
  health,
  repos,
  usage,
  onReposChanged,
  onTokenChanged,
}: {
  health: HealthReport;
  repos: RepoSummary[];
  usage: UsageReport | null;
  onReposChanged: () => void;
  onTokenChanged: () => void;
}) {
  const { t } = useI18n();
  const [appToken, setAppTokenValue] = useState(getAppToken);
  const runsLimit = usage?.limits.aiRunsPerMonth ?? null;
  const runsShare = usage && runsLimit ? Math.min(1, usage.aiRuns / runsLimit) : 0;

  return (
    <div className="page settings">
      {health.authRequired ? (
        <section className="panel">
          <h2 className="panel-title">{t("settings.access")}</h2>
          <p className="muted">{t("settings.access.body")}</p>
          <form
            className="inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              setAppToken(appToken.trim());
              onTokenChanged();
            }}
          >
            <label htmlFor="app-token" className="visually-hidden">
              {t("settings.access")}
            </label>
            <input
              id="app-token"
              type="password"
              autoComplete="off"
              value={appToken}
              onChange={(event) => setAppTokenValue(event.target.value)}
            />
            <button type="submit" className="btn btn-primary">
              {t("common.save")}
            </button>
          </form>
        </section>
      ) : null}

      <section className="panel">
        <h1>{t("settings.repos")}</h1>
        {repos.length === 0 ? <p className="muted">{t("settings.repos.empty")}</p> : null}
        <ul className="repo-list">
          {repos.map((repo) => (
            <RepoRow key={repo.id} repo={repo} onChanged={onReposChanged} />
          ))}
        </ul>
        <AddRepoForm health={health} onAdded={onReposChanged} />
      </section>

      <GithubTokenSection />

      <section className="panel">
        <div className="panel-heading">
          <h2 className="panel-title">{t("settings.usage")}</h2>
          <Badge tone={health.plan === "pro" ? "pro" : "neutral"}>
            {t(health.plan === "pro" ? "plan.pro" : "plan.free")}
          </Badge>
        </div>
        <p className="muted">
          {t(health.plan === "pro" ? "settings.usage.pro" : "settings.usage.free")}
        </p>
        {usage ? (
          <div className="usage">
            <div className="usage-row">
              <span>
                {t("settings.usage.month", { month: usage.month })} · {t("settings.usage.runs")}
              </span>
              <strong>
                {usage.aiRuns} / {runsLimit ?? t("settings.usage.unlimited")}
              </strong>
            </div>
            {runsLimit ? (
              <div
                className="meter"
                role="meter"
                aria-valuemin={0}
                aria-valuemax={runsLimit}
                aria-valuenow={usage.aiRuns}
                aria-label={t("settings.usage.runs")}
              >
                <span
                  style={{ width: `${runsShare * 100}%` }}
                  className={runsShare >= 1 ? "meter-full" : ""}
                />
              </div>
            ) : null}
            <p className="muted small">
              {t("settings.usage.tokens", {
                input: formatNumber(usage.inputTokens),
                output: formatNumber(usage.outputTokens),
              })}{" "}
              · {t("settings.usage.cost", { cost: usage.costUsd.toFixed(4) })}
              {usage.unpricedCalls > 0
                ? ` ${t("settings.usage.unpriced", { n: usage.unpricedCalls })}`
                : ""}
            </p>
          </div>
        ) : null}
      </section>
    </div>
  );
}
