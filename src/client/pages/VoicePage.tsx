import { Lock, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import type { HealthReport, UsageReport, VoiceProfile, VoiceState } from "../../shared/schemas";
import { api } from "../api";
import { Badge, ErrorNotice, Notice, Spinner } from "../components/ui";
import { useI18n } from "../i18n";

const lines = (value: string) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

export function VoicePage({ health, usage }: { health: HealthReport; usage: UsageReport | null }) {
  const { t } = useI18n();
  const [state, setState] = useState<VoiceState | null>(null);
  const [draft, setDraft] = useState<VoiceProfile | null>(null);
  const [lists, setLists] = useState({ catchphrases: "", dos: "", donts: "" });
  const [samples, setSamples] = useState("");
  const [busy, setBusy] = useState<"save" | "learn" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);

  const apply = (next: VoiceState) => {
    setState(next);
    setDraft(next.profile);
    setLists({
      catchphrases: next.profile.catchphrases.join("\n"),
      dos: next.profile.dos.join("\n"),
      donts: next.profile.donts.join("\n"),
    });
  };

  useEffect(() => {
    api.voice().then(apply, setError);
  }, []);

  if (!state || !draft) {
    return (
      <div className="page">
        {error ? <ErrorNotice error={error} /> : <Spinner label={t("common.loading")} />}
      </div>
    );
  }

  const canLearn = Boolean(usage?.limits.voiceLearning) && health.ai.configured;
  const sourceLabel =
    state.source === "learned"
      ? t("voice.source.learned", { n: state.samplesCount })
      : state.source === "manual"
        ? t("voice.source.manual")
        : t("voice.source.default");

  async function save() {
    if (!draft) return;
    setBusy("save");
    setError(null);
    setSaved(false);
    try {
      apply(
        await api.saveVoice({
          ...draft,
          catchphrases: lines(lists.catchphrases),
          dos: lines(lists.dos),
          donts: lines(lists.donts),
        }),
      );
      setSaved(true);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(null);
    }
  }

  async function learn() {
    setBusy("learn");
    setError(null);
    try {
      apply(await api.learnVoice(samples));
      setSamples("");
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="page voice">
      <section className="panel">
        <div className="panel-heading">
          <h1>{t("voice.title")}</h1>
          <Badge tone="neutral">{sourceLabel}</Badge>
        </div>
        <p className="muted">{t("voice.subtitle")}</p>
        {error ? <ErrorNotice error={error} /> : null}
        {saved ? <Notice tone="success">{t("common.save")} ✓</Notice> : null}
        <div className="form-grid">
          <div className="field">
            <label htmlFor="voice-language">{t("voice.language")}</label>
            <select
              id="voice-language"
              value={draft.language}
              onChange={(event) =>
                setDraft({ ...draft, language: event.target.value as VoiceProfile["language"] })
              }
            >
              <option value="zh">{t("voice.language.zh")}</option>
              <option value="en">{t("voice.language.en")}</option>
              <option value="mixed">{t("voice.language.mixed")}</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="voice-emoji">{t("voice.emoji")}</label>
            <select
              id="voice-emoji"
              value={draft.emojiUsage}
              onChange={(event) =>
                setDraft({ ...draft, emojiUsage: event.target.value as VoiceProfile["emojiUsage"] })
              }
            >
              <option value="none">{t("voice.emoji.none")}</option>
              <option value="light">{t("voice.emoji.light")}</option>
              <option value="heavy">{t("voice.emoji.heavy")}</option>
            </select>
          </div>
          <div className="field field-wide">
            <label htmlFor="voice-tone">{t("voice.tone")}</label>
            <input
              id="voice-tone"
              value={draft.tone}
              onChange={(event) => setDraft({ ...draft, tone: event.target.value })}
            />
          </div>
          <div className="field field-wide">
            <label htmlFor="voice-style">{t("voice.sentenceStyle")}</label>
            <input
              id="voice-style"
              value={draft.sentenceStyle}
              onChange={(event) => setDraft({ ...draft, sentenceStyle: event.target.value })}
            />
          </div>
          {(["catchphrases", "dos", "donts"] as const).map((key) => (
            <div className="field" key={key}>
              <label htmlFor={`voice-${key}`}>{t(`voice.${key}`)}</label>
              <textarea
                id={`voice-${key}`}
                rows={4}
                value={lists[key]}
                onChange={(event) => setLists({ ...lists, [key]: event.target.value })}
              />
            </div>
          ))}
        </div>
        <div className="actions">
          <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={save}>
            {busy === "save" ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h2 className="panel-title">
            <Sparkles aria-hidden="true" size={18} />
            {t("voice.learn.title")}
          </h2>
          {!usage?.limits.voiceLearning ? (
            <Badge tone="pro">
              <Lock aria-hidden="true" size={14} />
              {t("voice.learn.pro")}
            </Badge>
          ) : null}
        </div>
        <p className="muted">{t("voice.learn.body")}</p>
        {!health.ai.configured ? <Notice tone="warning">{t("voice.learn.needAi")}</Notice> : null}
        <div className="field">
          <label htmlFor="voice-samples" className="visually-hidden">
            {t("voice.learn.title")}
          </label>
          <textarea
            id="voice-samples"
            rows={8}
            value={samples}
            disabled={!canLearn}
            placeholder={"今天终于把导出功能做完了……\n---\n踩了一个时区的坑……"}
            onChange={(event) => setSamples(event.target.value)}
          />
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canLearn || busy !== null || samples.trim().length < 20}
            onClick={learn}
          >
            {busy === "learn" ? t("voice.learn.running") : t("voice.learn.action")}
          </button>
        </div>
      </section>
    </div>
  );
}
