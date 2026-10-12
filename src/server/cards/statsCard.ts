import type { ActivityDay, CollectionTotals } from "../../shared/schemas.js";
import type { ChangeBreakdown } from "../insights.js";
import {
  barPath,
  cardTokens,
  compactNumber,
  escapeXml,
  sansFont,
  truncateEnd,
  truncateMiddle,
  type CardTheme,
} from "./theme.js";

export interface StatsCardInput {
  repoLabel: string;
  windowLabel: string;
  totals: CollectionTotals;
  breakdown: ChangeBreakdown;
  /** Most recent days last; the card shows the last 14. */
  activity: ActivityDay[];
  commitStreak: number;
  theme?: CardTheme;
}

/** Rough rendered width: CJK glyphs are full-width, Latin glyphs a bit over half. */
function estimateTextWidth(text: string, size: number): number {
  let width = 0;
  for (const char of text) width += (char.codePointAt(0) ?? 0) > 0x2e80 ? size : size * 0.56;
  return width;
}

const WIDTH = 1080;
const HEIGHT = 1350;
const PAD = 72;

function heatLevel(commits: number): 0 | 1 | 2 | 3 | 4 {
  if (commits <= 0) return 0;
  if (commits === 1) return 1;
  if (commits <= 3) return 2;
  if (commits <= 6) return 3;
  return 4;
}

/** 1080×1350 (3:4) share card. Every number on it comes from git statistics. */
export function renderStatsCard(input: StatsCardInput): string {
  const tokens = cardTokens[input.theme ?? "light"];
  const parts: string[] = [];
  const text = (
    x: number,
    y: number,
    content: string,
    size: number,
    color: string,
    weight = 400,
    anchor: "start" | "end" | "middle" = "start",
  ) =>
    `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${escapeXml(content)}</text>`;

  // Header
  parts.push(text(PAD, 112, "SHIPLOG · 开发日记", 26, tokens.textSecondary, 600));
  parts.push(text(PAD, 176, truncateEnd(input.repoLabel, 26), 52, tokens.textPrimary, 700));
  parts.push(text(PAD, 222, input.windowLabel, 28, tokens.textSecondary));

  // Hero figure: commits
  parts.push(text(PAD, 380, compactNumber(input.totals.commits), 150, tokens.textPrimary, 600));
  const heroWidth = String(compactNumber(input.totals.commits)).length * 84;
  parts.push(text(PAD + heroWidth + 16, 380, "次提交", 36, tokens.textSecondary, 500));

  // Stat tiles
  const tiles = [
    { label: "新增行", value: `+${compactNumber(input.totals.additions)}` },
    { label: "删除行", value: `−${compactNumber(input.totals.deletions)}` },
    { label: "改动文件", value: compactNumber(input.totals.filesChanged) },
  ];
  const tileWidth = (WIDTH - PAD * 2 - 32) / 3;
  tiles.forEach((tile, index) => {
    const x = PAD + index * (tileWidth + 16);
    parts.push(
      `<rect x="${x}" y="430" width="${tileWidth}" height="132" rx="16" fill="${tokens.surfaceRaised}"/>`,
    );
    parts.push(text(x + 28, 488, tile.value, 48, tokens.textPrimary, 600));
    parts.push(text(x + 28, 532, tile.label, 24, tokens.textSecondary));
  });

  // Top files: single-series horizontal bars, value at the tip.
  let y = 640;
  parts.push(text(PAD, y, "改动最多的文件", 30, tokens.textPrimary, 600));
  y += 24;
  const files = input.breakdown.topFiles.slice(0, 4);
  const maxLines = Math.max(1, ...files.map((file) => file.lines));
  const barMax = WIDTH - PAD * 2 - 140;
  if (files.length === 0) {
    parts.push(text(PAD, y + 40, "这段时间没有可统计的代码改动", 24, tokens.textMuted));
    y += 72;
  }
  for (const file of files) {
    parts.push(text(PAD, y + 30, truncateMiddle(file.path, 46), 24, tokens.textSecondary));
    const width = Math.max(6, (file.lines / maxLines) * barMax);
    parts.push(`<path d="${barPath(PAD, y + 44, width, 20)}" fill="${tokens.series[0]}"/>`);
    parts.push(
      text(
        PAD + width + 12,
        y + 62,
        `${compactNumber(file.lines)} 行`,
        24,
        tokens.textPrimary,
        500,
      ),
    );
    y += 72;
  }

  // Language mix: one stacked 100% bar, 2px surface gaps, legend with labels and shares.
  y = Math.max(y + 48, 1000);
  parts.push(text(PAD, y, "语言分布（按改动行数）", 30, tokens.textPrimary, 600));
  const languages = input.breakdown.languages;
  const totalLines = languages.reduce((sum, item) => sum + item.lines, 0);
  if (totalLines === 0) {
    parts.push(text(PAD, y + 48, "暂无", 24, tokens.textMuted));
  } else {
    const shown = languages.slice(0, 4);
    const rest = languages.slice(4).reduce((sum, item) => sum + item.lines, 0);
    const segments = [
      ...shown.map((item, index) => ({
        label: item.language,
        lines: item.lines,
        color: tokens.series[index] ?? tokens.other,
      })),
      ...(rest > 0 ? [{ label: "其他", lines: rest, color: tokens.other }] : []),
    ];
    const barWidth = WIDTH - PAD * 2;
    const gap = 2;
    let x = PAD;
    const available = barWidth - gap * (segments.length - 1);
    segments.forEach((segment, index) => {
      const width = Math.max(2, (segment.lines / totalLines) * available);
      const isFirst = index === 0;
      const isLast = index === segments.length - 1;
      const rx = isFirst || isLast ? 6 : 0;
      parts.push(
        `<rect x="${x.toFixed(1)}" y="${y + 24}" width="${width.toFixed(1)}" height="22" rx="${rx}" fill="${segment.color}"/>`,
      );
      x += width + gap;
    });
    let legendX = PAD;
    let legendY = y + 88;
    for (const segment of segments) {
      const label = `${segment.label} ${Math.round((segment.lines / totalLines) * 100)}%`;
      const itemWidth = 26 + estimateTextWidth(label, 24) + 32;
      if (legendX + itemWidth > WIDTH - PAD) {
        legendX = PAD;
        legendY += 40;
      }
      parts.push(
        `<rect x="${legendX}" y="${legendY - 16}" width="16" height="16" rx="4" fill="${segment.color}"/>`,
      );
      parts.push(text(legendX + 26, legendY, label, 24, tokens.textSecondary));
      legendX += itemWidth;
    }
  }

  // 14-day heatmap (sequential, one hue) with streak.
  const recent = input.activity.slice(-14);
  const heatY = 1180;
  parts.push(text(PAD, heatY, "最近 14 天", 30, tokens.textPrimary, 600));
  parts.push(
    text(
      WIDTH - PAD,
      heatY,
      input.commitStreak > 0 ? `连续开发 ${input.commitStreak} 天` : "今天开始新的连续记录",
      26,
      tokens.textSecondary,
      500,
      "end",
    ),
  );
  const cell = 52;
  const cellGap = (WIDTH - PAD * 2 - cell * 14) / 13;
  recent.forEach((day, index) => {
    const x = PAD + index * (cell + cellGap);
    const level = heatLevel(day.commits);
    parts.push(
      `<rect x="${x.toFixed(1)}" y="${heatY + 24}" width="${cell}" height="${cell}" rx="8" fill="${tokens.heat[level]}"><title>${escapeXml(`${day.day}：${day.commits} 次提交`)}</title></rect>`,
    );
  });
  if (recent.length > 0) {
    parts.push(text(PAD, heatY + 104, recent[0]?.day.slice(5) ?? "", 22, tokens.textMuted));
    parts.push(
      text(
        WIDTH - PAD,
        heatY + 104,
        recent.at(-1)?.day.slice(5) ?? "",
        22,
        tokens.textMuted,
        400,
        "end",
      ),
    );
  }

  parts.push(
    text(
      WIDTH / 2,
      HEIGHT - 26,
      "由 ShipLog 根据 git 记录自动统计 · 锁文件与生成文件不计入",
      22,
      tokens.textMuted,
      400,
      "middle",
    ),
  );

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family="${escapeXml(sansFont)}" role="img" aria-label="${escapeXml(`${input.repoLabel} 开发数据卡：${input.totals.commits} 次提交，新增 ${input.totals.additions} 行，删除 ${input.totals.deletions} 行`)}">`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="${tokens.surface}"/>`,
    `<rect x="${PAD}" y="252" width="${WIDTH - PAD * 2}" height="1" fill="${tokens.hairline}"/>`,
    ...parts,
    "</svg>",
  ].join("\n");
}
