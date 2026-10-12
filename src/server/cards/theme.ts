export type CardTheme = "light" | "dark";

/**
 * Card colors. Series and sequential steps come from a validated data-viz palette
 * (categorical slots 1-4 pass adjacent CVD checks in both modes); text always uses
 * text tokens, never series colors.
 */
export interface CardTokens {
  surface: string;
  surfaceRaised: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  hairline: string;
  accent: string;
  series: [string, string, string, string];
  other: string;
  heat: [string, string, string, string, string];
  addedWash: string;
  removedWash: string;
  codeSurface: string;
  codeText: string;
  codeGutter: string;
}

export const cardTokens: Record<CardTheme, CardTokens> = {
  light: {
    surface: "#fcfcfb",
    surfaceRaised: "#f4f3ef",
    textPrimary: "#0b0b0b",
    textSecondary: "#52514e",
    textMuted: "#6f6e69",
    hairline: "#e4e3de",
    accent: "#2a78d6",
    series: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"],
    other: "#a3a29c",
    heat: ["#ecebe6", "#b7d3f6", "#6da7ec", "#2a78d6", "#184f95"],
    addedWash: "rgba(12, 163, 12, 0.14)",
    removedWash: "rgba(208, 59, 59, 0.12)",
    codeSurface: "#f4f3ef",
    codeText: "#1f1f1d",
    codeGutter: "#6f6e69",
  },
  dark: {
    surface: "#1a1a19",
    surfaceRaised: "#242422",
    textPrimary: "#f0efec",
    textSecondary: "#c3c2b7",
    textMuted: "#9d9c94",
    hairline: "#34342f",
    accent: "#3987e5",
    series: ["#3987e5", "#d95926", "#199e70", "#c98500"],
    other: "#6f6e69",
    heat: ["#2a2a28", "#104281", "#1c5cab", "#2a78d6", "#5598e7"],
    addedWash: "rgba(12, 163, 12, 0.22)",
    removedWash: "rgba(208, 59, 59, 0.22)",
    codeSurface: "#242422",
    codeText: "#f0efec",
    codeGutter: "#9d9c94",
  },
};

export const sansFont =
  "'PingFang SC','Hiragino Sans GB','Microsoft YaHei','Noto Sans CJK SC','Source Han Sans SC',system-ui,-apple-system,'Segoe UI',sans-serif";
export const monoFont =
  "'JetBrains Mono','SFMono-Regular','Menlo','Consolas','Noto Sans Mono CJK SC',monospace";

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function compactNumber(value: number): string {
  if (value >= 10_000) return `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return value.toLocaleString("en-US");
}

/** Keep the end of long paths: the file name is what readers recognise. */
export function truncateMiddle(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return `…${chars.slice(chars.length - max + 1).join("")}`;
}

export function truncateEnd(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return `${chars.slice(0, max - 1).join("")}…`;
}

/** A horizontal bar with a 4px rounded data-end and a square baseline end. */
export function barPath(x: number, y: number, width: number, height: number, radius = 4): string {
  const w = Math.max(width, 0);
  if (w <= radius) return `M${x},${y}h${w}v${height}h${-w}Z`;
  return [
    `M${x},${y}`,
    `h${w - radius}`,
    `a${radius},${radius} 0 0 1 ${radius},${radius}`,
    `v${height - 2 * radius}`,
    `a${radius},${radius} 0 0 1 ${-radius},${radius}`,
    `h${-(w - radius)}`,
    "Z",
  ].join(" ");
}
