import {
  BookOpenCheck,
  Bot,
  CheckCircle2,
  FileText,
  GitCommitHorizontal,
  PartyPopper,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import type {
  ChangeStory,
  Draft,
  GenerationResult,
  PlatformId,
  PostMetrics,
} from "../../shared/schemas";
import { api, localDay } from "../api";
import { useI18n, type TranslationKey } from "../i18n";
import { CardsPanel } from "./CardsPanel";
import { DraftEditor } from "./DraftEditor";
import { PostMetricsPanel } from "./PostMetricsPanel";
import { Badge, CopyButton, ErrorNotice, Notice, formatDateTime, formatNumber } from "./ui";

function StoryCard({ story, result }: { story: ChangeStory; result: GenerationResult }) {
  const { t } = useI18n();
  const commitUrl = (sha: string) =>
    result.commits.find((commit) => commit.sha === sha)?.url ?? null;
  return (
    <article className={`story story-${story.shareability}`}>
      <header className="story-header">
        <Badge tone={story.kind}>{t(`story.kind.${story.kind}` as TranslationKey)}</Badge>
        <Badge tone={`share-${story.shareability}`}>
          {t(`story.share.${story.shareability}` as TranslationKey)}
        </Badge>
      </header>
      <h3>{story.title}</h3>
      <p>{story.summary}</p>
      {story.angle ? <p className="story-angle">💡 {story.angle}</p> : null}
      {story.facts.length > 0 ? (
        <div className="facts">
          <span className="facts-label">{t("story.facts")}</span>
          <ul>
            {story.facts.map((fact) => (
              <li key={fact.id}>
                <span>{fact.text}</span>
                {fact.sourceShas.map((sha) => {
                  const url = commitUrl(sha);
                  return url ? (
                    <a
                      key={sha}
                      className="sha"
                      href={url}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {sha.slice(0, 7)}
                    </a>
                  ) : (
                    <code key={sha} className="sha">
                      {sha.slice(0, 7)}
                    </code>
                  );
                })}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </article>
  );
}

type MetricsByPlatform = Partial<Record<PlatformId, PostMetrics>>;

function DraftTabs({
  result,
  sharedPlatforms,
  metrics,
  onDraftSaved,
  onShared,
  onMetrics,
}: {
  result: GenerationResult;
  sharedPlatforms: PlatformId[];
  metrics: MetricsByPlatform;
  onDraftSaved: (draft: Draft) => void;
  onShared: (platform: PlatformId) => void;
  onMetrics: (platform: PlatformId, metrics: PostMetrics | null) => void;
}) {
  const { t } = useI18n();
  const [active, setActive] = useState<PlatformId>(result.drafts[0]?.platform ?? "jike");
  const [error, setError] = useState<unknown>(null);
  const current = result.drafts.find((draft) => draft.platform === active) ?? result.drafts[0];

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const next =
      (index + (event.key === "ArrowRight" ? 1 : -1) + result.drafts.length) % result.drafts.length;
    const platform = result.drafts[next]?.platform;
    if (platform) {
      setActive(platform);
      document.getElementById(`tab-${platform}`)?.focus();
    }
  }

  if (!current) return <p className="muted">{t("draft.noDrafts")}</p>;
  return (
    <div>
      <div className="tabs" role="tablist" aria-label={t("result.drafts")}>
        {result.drafts.map((draft, index) => (
          <button
            key={draft.platform}
            id={`tab-${draft.platform}`}
            role="tab"
            type="button"
            aria-selected={draft.platform === current.platform}
            aria-controls={`panel-${draft.platform}`}
            tabIndex={draft.platform === current.platform ? 0 : -1}
            className="tab"
            onClick={() => setActive(draft.platform)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {draft.status === "ok" ? (
              <CheckCircle2 aria-hidden="true" size={16} className="tab-ok" />
            ) : (
              <TriangleAlert aria-hidden="true" size={16} className="tab-review" />
            )}
            <span>{t(`platform.${draft.platform}` as TranslationKey)}</span>
            <span className="visually-hidden">
              {draft.status === "ok" ? t("draft.ok") : t("draft.review")}
            </span>
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`panel-${current.platform}`}
        aria-labelledby={`tab-${current.platform}`}
        className="tabpanel"
      >
        {error ? <ErrorNotice error={error} /> : null}
        <DraftEditor
          key={current.platform}
          generationId={result.id}
          draft={current}
          shared={sharedPlatforms.includes(current.platform)}
          onSaved={onDraftSaved}
          onShared={async () => {
            setError(null);
            try {
              await api.share(result.id, current.platform, localDay());
              onShared(current.platform);
            } catch (caught) {
              setError(caught);
            }
          }}
        />
        {sharedPlatforms.includes(current.platform) || metrics[current.platform] ? (
          <PostMetricsPanel
            key={`metrics-${current.platform}`}
            generationId={result.id}
            platform={current.platform}
            metrics={metrics[current.platform] ?? null}
            onChanged={(next) => onMetrics(current.platform, next)}
          />
        ) : null}
      </div>
    </div>
  );
}

export function GenerationView({
  initial,
  initialShared = [],
  initialMetrics = {},
  onShared,
}: {
  initial: GenerationResult;
  initialShared?: PlatformId[];
  initialMetrics?: MetricsByPlatform;
  onShared?: () => void;
}) {
  const { t, lang } = useI18n();
  const [result, setResult] = useState(initial);
  const [sharedPlatforms, setSharedPlatforms] = useState<PlatformId[]>(initialShared);
  const [metrics, setMetrics] = useState<MetricsByPlatform>(initialMetrics);
  const cost = result.usage.reduce((sum, item) => sum + (item.costUsd ?? 0), 0);

  return (
    <div className="generation">
      {result.mode === "baseline" && result.baselineReason ? (
        <Notice tone="info">{result.baselineReason}</Notice>
      ) : null}

      <section className="panel headline-panel" aria-labelledby="headline">
        <div className="headline-meta">
          <Badge tone={result.mode === "ai" ? "ai" : "neutral"}>
            {result.mode === "ai" ? (
              <Bot aria-hidden="true" size={14} />
            ) : (
              <FileText aria-hidden="true" size={14} />
            )}
            {result.mode === "ai" ? t("result.ai") : t("result.baseline")}
          </Badge>
          <span className="muted">
            {result.repoLabel} · {formatDateTime(result.window.since, lang)} ~{" "}
            {formatDateTime(result.window.until, lang)}
          </span>
        </div>
        <h2 id="headline" className="headline">
          {result.dayHeadline ?? result.repoLabel}
        </h2>
        <dl className="stat-row">
          <div>
            <dt>{t("result.commits")}</dt>
            <dd>{formatNumber(result.totals.commits)}</dd>
          </div>
          <div>
            <dt>+ / −</dt>
            <dd>
              +{formatNumber(result.totals.additions)} / −{formatNumber(result.totals.deletions)}
            </dd>
          </div>
          <div>
            <dt>{t("result.files")}</dt>
            <dd>{formatNumber(result.totals.filesChanged)}</dd>
          </div>
        </dl>
        {result.milestones.length > 0 ? (
          <ul className="milestones">
            {result.milestones.map((milestone) => (
              <li key={`${milestone.kind}-${milestone.value}`}>
                <PartyPopper aria-hidden="true" size={16} />
                <span className="visually-hidden">{t("result.milestone")}：</span>
                {milestone.label}
              </li>
            ))}
          </ul>
        ) : null}
        <ul className="trust-notes">
          {result.redactionCount > 0 ? (
            <li>
              <ShieldCheck aria-hidden="true" size={16} />
              {t("result.redacted", { n: result.redactionCount })}
            </li>
          ) : null}
          {result.excludedFileCount > 0 ? (
            <li>
              <ShieldCheck aria-hidden="true" size={16} />
              {t("result.excluded", { n: result.excludedFileCount })}
            </li>
          ) : null}
          {result.truncated ? (
            <li>
              <TriangleAlert aria-hidden="true" size={16} />
              {t("result.truncated")}
            </li>
          ) : null}
          {result.exemplarCount ? (
            <li>
              <BookOpenCheck aria-hidden="true" size={16} />
              {t("result.exemplars", { n: result.exemplarCount })}
            </li>
          ) : null}
          {result.usage.length > 0 ? (
            <li>
              <Sparkles aria-hidden="true" size={16} />
              {t("result.cost", { calls: result.usage.length, cost: cost.toFixed(4) })}
            </li>
          ) : null}
        </ul>
      </section>

      {result.totals.commits === 0 ? <Notice tone="info">{t("result.empty")}</Notice> : null}

      {result.stories.length > 0 ? (
        <section className="panel" aria-labelledby="stories-title">
          <h2 id="stories-title" className="panel-title">
            {t("result.stories")}
          </h2>
          <p className="muted">{t("result.storiesHint")}</p>
          <div className="stories">
            {result.stories.map((story) => (
              <StoryCard key={story.id} story={story} result={result} />
            ))}
          </div>
        </section>
      ) : null}

      {result.drafts.length > 0 ? (
        <section className="panel" aria-labelledby="drafts-title">
          <h2 id="drafts-title" className="panel-title">
            {t("result.drafts")}
          </h2>
          <DraftTabs
            result={result}
            sharedPlatforms={sharedPlatforms}
            onDraftSaved={(draft) =>
              setResult((previous) => ({
                ...previous,
                drafts: previous.drafts.map((item) =>
                  item.platform === draft.platform ? draft : item,
                ),
              }))
            }
            metrics={metrics}
            onShared={(platform) => {
              setSharedPlatforms((previous) => [...new Set([...previous, platform])]);
              onShared?.();
            }}
            onMetrics={(platform, next) =>
              setMetrics((previous) => {
                const updated = { ...previous };
                if (next) updated[platform] = next;
                else delete updated[platform];
                return updated;
              })
            }
          />
        </section>
      ) : null}

      {result.totals.commits > 0 ? <CardsPanel result={result} /> : null}

      <section className="panel" aria-labelledby="changelog-title">
        <div className="panel-heading">
          <h2 id="changelog-title" className="panel-title">
            <GitCommitHorizontal aria-hidden="true" size={18} />
            {t("result.changelog")}
          </h2>
          <CopyButton text={result.changelog} />
        </div>
        <p className="muted">{t("result.changelogHint")}</p>
        <pre className="changelog">{result.changelog}</pre>
      </section>
    </div>
  );
}
