import { CreditCard, ExternalLink, FolderGit2, Github, KeyRound, Lock, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type {
  GithubRepoOption,
  HealthReport,
  MeReport,
  RepoSummary,
  UsageReport,
} from "../../shared/schemas";
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

function GithubRepoPicker({ onPick }: { onPick: (repo: GithubRepoOption) => void }) {
  const { t } = useI18n();
  const [options, setOptions] = useState<GithubRepoOption[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!options) {
    return (
      <div className="field">
        <button
          type="button"
          className="btn btn-quiet"
          disabled={loading}
          onClick={async () => {
            setLoading(true);
            setError(null);
            try {
              setOptions(await api.githubRepos());
            } catch (caught) {
              setError(caught);
            } finally {
              setLoading(false);
            }
          }}
        >
          <Github aria-hidden="true" size={16} />
          {loading ? t("common.loading") : t("settings.repos.pickLoad")}
        </button>
        {error ? <ErrorNotice error={error} /> : null}
      </div>
    );
  }
  return (
    <div className="field">
      <label htmlFor="repo-picker">{t("settings.repos.pick")}</label>
      <select
        id="repo-picker"
        defaultValue=""
        onChange={(event) => {
          const picked = options.find((option) => option.fullName === event.target.value);
          if (picked) onPick(picked);
        }}
      >
        <option value="" disabled>
          {t("settings.repos.pickPlaceholder")}
        </option>
        {options.map((option) => (
          <option key={option.fullName} value={option.fullName}>
            {option.fullName}
            {option.private ? ` (${t("settings.repos.private")})` : ""}
          </option>
        ))}
      </select>
    </div>
  );
}

function AddRepoForm({
  health,
  canPick,
  onAdded,
}: {
  health: HealthReport;
  canPick: boolean;
  onAdded: () => void;
}) {
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
        <>
          {canPick ? (
            <GithubRepoPicker
              onPick={(picked) => {
                setFullName({ owner: picked.owner, repo: picked.name });
                if (!context && picked.description) setContext(picked.description.slice(0, 200));
              }}
            />
          ) : null}
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
        </>
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

function GithubTokenSection({ onChanged }: { onChanged: () => void }) {
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
            onChanged();
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
              onChanged();
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

function GithubAccountSection({ me }: { me: MeReport }) {
  const { t } = useI18n();
  if (!me.user) return null;
  return (
    <section className="panel">
      <h2 className="panel-title">
        <Github aria-hidden="true" size={18} />
        {t("settings.account")}
      </h2>
      <p>{t("settings.account.signedIn", { login: me.user.login })}</p>
      {me.github.privateRepos ? (
        <Notice tone="success">{t("settings.account.private")}</Notice>
      ) : (
        <>
          <p className="muted">{t("settings.account.publicOnly")}</p>
          <a
            className="btn btn-quiet"
            href={`/auth/github/login?private=1&next=${encodeURIComponent("/#settings")}`}
          >
            <Lock aria-hidden="true" size={16} />
            {t("settings.account.grant")}
          </a>
        </>
      )}
    </section>
  );
}

function BillingActions({ me, plan }: { me: MeReport; plan: string }) {
  const { t, lang } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (me.authMode === "local") return <p className="muted small">{t("billing.selfHosted")}</p>;
  if (!me.billing.enabled) return null;

  async function go(kind: "checkout" | "portal") {
    setBusy(true);
    setError(null);
    try {
      const { url } = kind === "checkout" ? await api.billingCheckout() : await api.billingPortal();
      window.location.assign(url);
    } catch (caught) {
      setError(caught);
      setBusy(false);
    }
  }

  return (
    <div className="billing">
      {me.billing.status ? (
        <p className="muted small">
          {t("billing.status", { status: me.billing.status })}
          {me.billing.renewsAt
            ? ` · ${t("billing.renews", {
                date: new Date(me.billing.renewsAt).toLocaleDateString(
                  lang === "zh" ? "zh-CN" : "en-US",
                ),
              })}`
            : ""}
        </p>
      ) : null}
      <div className="actions">
        {plan !== "pro" ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => go("checkout")}
          >
            <CreditCard aria-hidden="true" size={16} />
            {busy ? t("billing.redirecting") : t("billing.upgrade")}
          </button>
        ) : null}
        {me.billing.canManage ? (
          <button
            type="button"
            className="btn btn-quiet"
            disabled={busy}
            onClick={() => go("portal")}
          >
            {t("billing.manage")}
          </button>
        ) : null}
      </div>
      {error ? <ErrorNotice error={error} /> : null}
    </div>
  );
}

export function SettingsPage({
  health,
  me,
  needsToken,
  billingResult,
  repos,
  usage,
  onChanged,
  onTokenChanged,
}: {
  health: HealthReport;
  me: MeReport | null;
  needsToken: boolean;
  billingResult: string | null;
  repos: RepoSummary[];
  usage: UsageReport | null;
  onChanged: () => void;
  onTokenChanged: () => void;
}) {
  const { t } = useI18n();
  const [appToken, setAppTokenValue] = useState(getAppToken);
  const runsLimit = usage?.limits.aiRunsPerMonth ?? null;
  const runsShare = usage && runsLimit ? Math.min(1, usage.aiRuns / runsLimit) : 0;
  const plan = usage?.plan ?? me?.plan ?? "free";
  const canPick = Boolean(me && (me.github.oauth || me.github.pat));

  return (
    <div className="page settings">
      {billingResult === "success" ? <Notice tone="success">{t("billing.success")}</Notice> : null}
      {billingResult === "cancel" ? <Notice tone="info">{t("billing.cancel")}</Notice> : null}

      {health.authRequired ? (
        <section className="panel">
          <h2 className="panel-title">{t("settings.access")}</h2>
          {needsToken ? <Notice tone="warning">{t("settings.access.needed")}</Notice> : null}
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

      {me?.authMode === "github" ? <GithubAccountSection me={me} /> : null}

      {!needsToken ? (
        <section className="panel">
          <h1>{t("settings.repos")}</h1>
          {repos.length === 0 ? <p className="muted">{t("settings.repos.empty")}</p> : null}
          <ul className="repo-list">
            {repos.map((repo) => (
              <RepoRow key={repo.id} repo={repo} onChanged={onChanged} />
            ))}
          </ul>
          <AddRepoForm health={health} canPick={canPick} onAdded={onChanged} />
        </section>
      ) : null}

      {me?.authMode === "local" && !needsToken ? (
        <GithubTokenSection onChanged={onChanged} />
      ) : null}

      {me ? (
        <section className="panel">
          <div className="panel-heading">
            <h2 className="panel-title">{t("settings.usage")}</h2>
            <Badge tone={plan === "pro" ? "pro" : "neutral"}>
              {t(plan === "pro" ? "plan.pro" : "plan.free")}
            </Badge>
          </div>
          <p className="muted">
            {t(plan === "pro" ? "settings.usage.pro" : "settings.usage.free")}
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
          <BillingActions me={me} plan={plan} />
        </section>
      ) : null}
    </div>
  );
}
