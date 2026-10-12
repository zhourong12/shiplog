import { AlertTriangle, CheckCircle2, Info, Loader2, XCircle } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../i18n";

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner" role="status">
      <Loader2 aria-hidden="true" className="spin" size={18} />
      {label ? <span>{label}</span> : null}
    </span>
  );
}

type Tone = "info" | "success" | "warning" | "error";

const toneIcon: Record<Tone, ReactNode> = {
  info: <Info aria-hidden="true" size={18} />,
  success: <CheckCircle2 aria-hidden="true" size={18} />,
  warning: <AlertTriangle aria-hidden="true" size={18} />,
  error: <XCircle aria-hidden="true" size={18} />,
};

export function Notice({
  tone,
  title,
  children,
  action,
}: {
  tone: Tone;
  title?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={`notice notice-${tone}`} role={tone === "error" ? "alert" : undefined}>
      {toneIcon[tone]}
      <div className="notice-body">
        {title ? <strong>{title}</strong> : null}
        <div>{children}</div>
      </div>
      {action ? <div className="notice-action">{action}</div> : null}
    </div>
  );
}

export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useI18n();
  const message = error instanceof Error ? error.message : String(error);
  return (
    <Notice
      tone="error"
      title={t("error.title")}
      action={
        onRetry ? (
          <button type="button" className="btn btn-quiet" onClick={onRetry}>
            {t("common.retry")}
          </button>
        ) : null
      }
    >
      {message}
    </Notice>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: string; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function CopyButton({
  text,
  label,
  className = "btn btn-quiet",
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          // Fallback for browsers without clipboard permission.
          const area = document.createElement("textarea");
          area.value = text;
          document.body.append(area);
          area.select();
          document.execCommand("copy");
          area.remove();
        }
        setCopied(true);
      }}
    >
      <span aria-live="polite">{copied ? t("common.copied") : (label ?? t("common.copy"))}</span>
    </button>
  );
}

/** Modal with focus trap, Escape to close and focus restore. */
export function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const focusables = () =>
      Array.from(
        node?.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => !element.hasAttribute("disabled"));
    focusables()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      if (event.key === "Tab") {
        const items = focusables();
        const first = items[0];
        const last = items.at(-1);
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        ref={ref}
      >
        <header className="dialog-header">
          <h2 id="dialog-title">{title}</h2>
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            {t("common.close")}
          </button>
        </header>
        <div className="dialog-body">{children}</div>
      </div>
    </div>
  );
}

export function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

export function formatDateTime(iso: string, lang: "zh" | "en"): string {
  return new Date(iso).toLocaleString(lang === "zh" ? "zh-CN" : "en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
