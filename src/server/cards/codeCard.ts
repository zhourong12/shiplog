import type { CodeSnippet, CommitRecord } from "../../shared/schemas.js";
import { splitUnifiedDiff } from "../prep/filter.js";
import {
  cardTokens,
  escapeXml,
  monoFont,
  sansFont,
  truncateEnd,
  truncateMiddle,
  type CardTheme,
} from "./theme.js";

export type Snippet = CodeSnippet;

const MAX_LINES = 18;

/** Pick the hunk with the most added lines from an already filtered and redacted patch. */
export function pickSnippet(commit: Pick<CommitRecord, "patch">): Snippet | null {
  let best: { path: string; lines: Snippet["lines"]; added: number } | null = null;
  for (const file of splitUnifiedDiff(commit.patch)) {
    const hunks = file.text.split(/\n(?=@@ )/).filter((hunk) => hunk.startsWith("@@"));
    for (const hunk of hunks) {
      const lines = hunk
        .split("\n")
        .slice(1)
        .filter((line) => !line.startsWith("\\ No newline"))
        .map((line) => ({
          kind: line.startsWith("+")
            ? ("add" as const)
            : line.startsWith("-")
              ? ("del" as const)
              : ("ctx" as const),
          text: line.slice(1),
        }));
      const added = lines.filter((line) => line.kind === "add").length;
      if (added > 0 && (!best || added > best.added)) best = { path: file.path, lines, added };
    }
  }
  if (!best) return null;
  const firstAdd = best.lines.findIndex((line) => line.kind === "add");
  const start = Math.max(0, firstAdd - 2);
  return { path: best.path, lines: best.lines.slice(start, start + MAX_LINES) };
}

export interface CodeCardInput {
  title: string;
  repoLabel: string;
  snippet: Snippet;
  theme?: CardTheme;
}

const WIDTH = 1080;
const HEIGHT = 1080;
const PAD = 64;

export function renderCodeCard(input: CodeCardInput): string {
  const tokens = cardTokens[input.theme ?? "dark"];
  const fontSize = 26;
  const lineHeight = 40;
  const maxChars = 56;
  const codeTop = 250;
  const parts: string[] = [];
  parts.push(
    `<text x="${PAD}" y="${PAD + 40}" font-size="26" font-weight="600" fill="${tokens.textSecondary}">${escapeXml(`SHIPLOG · ${truncateEnd(input.repoLabel, 30)}`)}</text>`,
    `<text x="${PAD}" y="${PAD + 104}" font-size="44" font-weight="700" fill="${tokens.textPrimary}">${escapeXml(truncateEnd(input.title, 22))}</text>`,
    `<text x="${PAD}" y="${PAD + 150}" font-size="24" fill="${tokens.textMuted}" font-family="${escapeXml(monoFont)}">${escapeXml(truncateMiddle(input.snippet.path, 60))}</text>`,
    `<rect x="${PAD - 16}" y="${codeTop - 24}" width="${WIDTH - PAD * 2 + 32}" height="${input.snippet.lines.length * lineHeight + 48}" rx="20" fill="${tokens.codeSurface}"/>`,
  );
  input.snippet.lines.forEach((line, index) => {
    const y = codeTop + index * lineHeight;
    if (line.kind !== "ctx") {
      parts.push(
        `<rect x="${PAD - 16}" y="${y}" width="${WIDTH - PAD * 2 + 32}" height="${lineHeight}" fill="${line.kind === "add" ? tokens.addedWash : tokens.removedWash}"/>`,
      );
    }
    // The +/− marker carries the meaning; the wash only supports it.
    const marker = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
    const content = truncateEnd(line.text.replace(/\t/g, "  "), maxChars);
    parts.push(
      `<text x="${PAD}" y="${y + 28}" font-size="${fontSize}" fill="${tokens.codeGutter}" font-family="${escapeXml(monoFont)}">${marker}</text>`,
      `<text x="${PAD + 32}" y="${y + 28}" font-size="${fontSize}" fill="${tokens.codeText}" font-family="${escapeXml(monoFont)}" xml:space="preserve">${escapeXml(content)}</text>`,
    );
  });
  parts.push(
    `<text x="${WIDTH / 2}" y="${HEIGHT - 36}" font-size="22" fill="${tokens.textMuted}" text-anchor="middle">${escapeXml("由 ShipLog 从提交记录生成 · 密钥已自动脱敏")}</text>`,
  );
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family="${escapeXml(sansFont)}" role="img" aria-label="${escapeXml(`代码片段卡：${input.title}`)}">`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="${tokens.surface}"/>`,
    ...parts,
    "</svg>",
  ].join("\n");
}
