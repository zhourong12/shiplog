import { useEffect, useState } from "react";
import type { GenerationResult } from "../../shared/schemas";
import { fetchSvg } from "../api";
import { useI18n } from "../i18n";
import { ErrorNotice, Spinner } from "./ui";

type Theme = "light" | "dark";

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function download(href: string, filename: string) {
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
}

/** Rasterize at the SVG's own size (1080px wide) so posts stay sharp. */
async function svgToPng(svg: string): Promise<string> {
  const image = new Image();
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("图片渲染失败"));
  });
  image.src = svgDataUrl(svg);
  await loaded;
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || 1080;
  canvas.height = image.naturalHeight || 1350;
  canvas.getContext("2d")?.drawImage(image, 0, 0);
  return canvas.toDataURL("image/png");
}

function useSvg(path: string | null) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setSvg(null);
    setError(null);
    fetchSvg(path).then(
      (value) => !cancelled && setSvg(value),
      (caught: unknown) => !cancelled && setError(caught),
    );
    return () => {
      cancelled = true;
    };
  }, [path]);
  return { svg, error };
}

function CardPreview({
  title,
  path,
  alt,
  filename,
}: {
  title: string;
  path: string | null;
  alt: string;
  filename: string;
}) {
  const { t } = useI18n();
  const { svg, error } = useSvg(path);
  return (
    <figure className="card-preview">
      <figcaption>{title}</figcaption>
      {error ? <ErrorNotice error={error} /> : null}
      {!error && !svg ? <Spinner label={t("common.loading")} /> : null}
      {svg ? (
        <>
          <img src={svgDataUrl(svg)} alt={alt} />
          <div className="actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={async () => download(await svgToPng(svg), `${filename}.png`)}
            >
              {t("cards.downloadPng")}
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => download(svgDataUrl(svg), `${filename}.svg`)}
            >
              {t("cards.downloadSvg")}
            </button>
          </div>
        </>
      ) : null}
    </figure>
  );
}

export function CardsPanel({ result }: { result: GenerationResult }) {
  const { t } = useI18n();
  const [theme, setTheme] = useState<Theme>("light");
  const withSnippet = result.commits.filter((commit) => commit.snippet);
  const [sha, setSha] = useState(withSnippet[0]?.sha ?? "");
  const day = result.window.until.slice(0, 10);

  return (
    <section className="panel" aria-labelledby="cards-title">
      <div className="panel-heading">
        <h2 id="cards-title" className="panel-title">
          {t("result.cards")}
        </h2>
        <div className="segmented" role="group" aria-label={t("result.cards")}>
          {(["light", "dark"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={theme === value}
              className={theme === value ? "active" : ""}
              onClick={() => setTheme(value)}
            >
              {t(value === "light" ? "cards.theme.light" : "cards.theme.dark")}
            </button>
          ))}
        </div>
      </div>
      <div className="cards-grid">
        <CardPreview
          title={t("cards.stats")}
          alt={t("cards.alt.stats")}
          path={`/api/generations/${result.id}/cards/stats.svg?theme=${theme}`}
          filename={`shiplog-${day}-stats`}
        />
        <div>
          {withSnippet.length > 0 ? (
            <>
              <div className="field">
                <label htmlFor="code-card-commit">{t("cards.commit")}</label>
                <select
                  id="code-card-commit"
                  value={sha}
                  onChange={(event) => setSha(event.target.value)}
                >
                  {withSnippet.map((commit) => (
                    <option key={commit.sha} value={commit.sha}>
                      {commit.shortSha} · {commit.subject.slice(0, 60)}
                    </option>
                  ))}
                </select>
              </div>
              <CardPreview
                title={t("cards.code")}
                alt={t("cards.alt.code")}
                path={`/api/generations/${result.id}/cards/code.svg?sha=${sha}&theme=${theme}`}
                filename={`shiplog-${day}-code`}
              />
            </>
          ) : (
            <p className="muted">{t("cards.noSnippet")}</p>
          )}
        </div>
      </div>
    </section>
  );
}
