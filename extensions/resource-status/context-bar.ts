import type {
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  compactContextBarLayout,
  compactProgressBarLayout,
  type CompactContextBarLayout,
} from "./core.ts";

function progressColor(percent: number | null): ThemeColor {
  if (percent === null) return "dim";
  if (percent >= 90) return "error";
  if (percent >= 70) return "warning";
  return "success";
}

function renderLayout(theme: Theme, layout: CompactContextBarLayout): string {
  const color = progressColor(layout.percent);
  const cells = layout.cells.map((cell, index) => {
    const isFilled = index < layout.filled;
    const isLabel = cell !== "█" && cell !== "░";
    if (isLabel) {
      return theme.inverse(theme.fg(isFilled ? color : "dim", cell));
    }
    if (isFilled) return theme.fg(color, "█");
    return theme.inverse(theme.fg("dim", " "));
  });
  return theme.fg("dim", "[") + cells.join("") + theme.fg("dim", "]");
}

export function renderCompactProgressBar(
  theme: Theme,
  percent: number | null,
  rightLabel: string,
): string {
  return renderLayout(theme, compactProgressBarLayout(percent, rightLabel));
}

export function renderCompactContextBar(
  theme: Theme,
  tokens: number | null,
  contextWindow: number | undefined,
  suppliedPercent?: number | null,
): string {
  return renderLayout(
    theme,
    compactContextBarLayout(tokens, contextWindow, suppliedPercent),
  );
}
