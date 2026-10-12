import { AlertTriangle, CheckCircle2, ExternalLink, PencilLine, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  charCount,
  composeText,
  composeUrl,
  platformSpecs,
  splitThread,
  xWeightedLength,
} from "../../shared/platformRules";
import type { Draft } from "../../shared/schemas";
import { api } from "../api";
import { useI18n } from "../i18n";
import { CopyButton, ErrorNotice } from "./ui";

function parseHashtags(value: string): string[] {
  return value
    .split(/[\s,，]+/)
    .map((tag) => tag.replace(/^#+|#+$/g, "").trim())
    .filter(Boolean);
}

export function DraftEditor({
  generationId,
  draft,
  shared,
  onSaved,
  onShared,
}: {
  generationId: string;
  draft: Draft;
  shared: boolean;
  onSaved: (draft: Draft) => void;
  onShared: () => void;
}) {
  const { t } = useI18n();
  const spec = platformSpecs[draft.platform];
  const [title, setTitle] = useState(draft.title ?? "");
  const [body, setBody] = useState(draft.body);
  const [hashtags, setHashtags] = useState(draft.hashtags.join(" "));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    setTitle(draft.title ?? "");
    setBody(draft.body);
    setHashtags(draft.hashtags.join(" "));
  }, [draft]);

  const current = useMemo(
    () => ({ platform: draft.platform, body, hashtags: parseHashtags(hashtags) }),
    [draft.platform, body, hashtags],
  );
  const text = composeText(current);
  const url = composeUrl(current);
  const dirty =
    title !== (draft.title ?? "") || body !== draft.body || hashtags !== draft.hashtags.join(" ");
  const platformLabel = t(`platform.${draft.platform}`);

  const counters = spec.thread
    ? splitThread(text).map((part, index) => {
        const weighted = xWeightedLength(part);
        return {
          label: t("draft.count.post", { i: index + 1, n: weighted, max: spec.thread!.partMax }),
          over: weighted > spec.thread!.partMax,
        };
      })
    : [
        {
          label: spec.bodyMax
            ? t("draft.count.chars", { n: charCount(text), max: spec.bodyMax })
            : t("draft.count.charsNoMax", { n: charCount(text) }),
          over: spec.bodyMax !== null && charCount(text) > spec.bodyMax,
        },
      ];

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const saved = await api.editDraft(generationId, draft.platform, {
        title: spec.titleRequired || title ? title : null,
        body,
        hashtags: parseHashtags(hashtags),
      });
      onSaved(saved);
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  }

  const titleId = `draft-title-${draft.platform}`;
  const bodyId = `draft-body-${draft.platform}`;
  const tagsId = `draft-tags-${draft.platform}`;
  return (
    <div className="draft-editor">
      <div className="draft-status">
        {draft.status === "ok" ? (
          <span className="status status-ok">
            <CheckCircle2 aria-hidden="true" size={18} />
            {t("draft.ok")}
          </span>
        ) : (
          <span className="status status-review">
            <AlertTriangle aria-hidden="true" size={18} />
            {t("draft.review")}
          </span>
        )}
        {draft.edited ? (
          <span className="status status-muted">
            <PencilLine aria-hidden="true" size={16} />
            {t("draft.edited")}
          </span>
        ) : null}
      </div>

      {draft.issues.length > 0 ? (
        <ul className="issues" aria-label={t("draft.review")}>
          {draft.issues.map((issue, index) => (
            <li key={index} className={`issue issue-${issue.severity}`}>
              {issue.severity === "error" ? (
                <XCircle aria-hidden="true" size={16} />
              ) : (
                <AlertTriangle aria-hidden="true" size={16} />
              )}
              <span>{issue.message}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {spec.titleRequired || draft.title ? (
        <div className="field">
          <label htmlFor={titleId}>
            {t("draft.title")}
            {spec.titleMax ? (
              <span className={`counter${charCount(title) > spec.titleMax ? " counter-over" : ""}`}>
                {t("draft.count.chars", { n: charCount(title), max: spec.titleMax })}
              </span>
            ) : null}
          </label>
          <input id={titleId} value={title} onChange={(event) => setTitle(event.target.value)} />
        </div>
      ) : null}

      <div className="field">
        <label htmlFor={bodyId}>
          {t("draft.body")}
          <span className="counters">
            {counters.map((counter) => (
              <span key={counter.label} className={`counter${counter.over ? " counter-over" : ""}`}>
                {counter.label}
              </span>
            ))}
          </span>
        </label>
        <textarea
          id={bodyId}
          value={body}
          rows={Math.min(18, Math.max(6, body.split("\n").length + 2))}
          onChange={(event) => setBody(event.target.value)}
        />
      </div>

      {spec.hashtagMax !== 0 ? (
        <div className="field">
          <label htmlFor={tagsId}>
            {t("draft.hashtags")}
            <span className="hint">{t("draft.hashtagsHint")}</span>
          </label>
          <input
            id={tagsId}
            value={hashtags}
            onChange={(event) => setHashtags(event.target.value)}
          />
        </div>
      ) : null}

      {error ? <ErrorNotice error={error} /> : null}

      <div className="actions">
        {dirty ? (
          <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>
            {saving ? t("common.saving") : t("draft.saveEdits")}
          </button>
        ) : null}
        <CopyButton
          text={title.trim() && !spec.thread ? `${title.trim()}\n\n${text}` : text}
          label={t("draft.copy")}
          className={dirty ? "btn btn-quiet" : "btn btn-primary"}
        />
        {url ? (
          <a className="btn btn-quiet" href={url} target="_blank" rel="noreferrer noopener">
            <ExternalLink aria-hidden="true" size={16} />
            {t("draft.open", { platform: platformLabel })}
          </a>
        ) : null}
        <button
          type="button"
          className={`btn ${shared ? "btn-done" : "btn-quiet"}`}
          disabled={shared}
          onClick={onShared}
        >
          {shared ? (
            <>
              <CheckCircle2 aria-hidden="true" size={16} />
              {t("draft.shared")}
            </>
          ) : (
            t("draft.markShared")
          )}
        </button>
      </div>
    </div>
  );
}
