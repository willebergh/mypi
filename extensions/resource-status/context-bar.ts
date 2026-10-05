import type {
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { compactContextBarLayout } from "./core.ts";

function progressColor(percent: number | null): ThemeColor {
  if (percent === null) return "dim";
  if (percent >= 90) return "error";
  if (percent >= 70) return "warning";
  return "success";
}

export function renderCompactContextBar(
  theme: Theme,
  tokens: number | null,
  contextWindow: number | undefined,
  suppliedPercent?: number | null,
): string {
  const layout = compactContextBarLayout(
    tokens,
    contextWindow,
    suppliedPercent,
  );
  const color = progressColor(layout.percent);
  const cells = layout.cells.map((cell, index) => {
    const isLabel = cell !== "█" && cell !== "░";
    if (isLabel) {
      return theme.inverse(
        theme.fg(index < layout.filled ? color : "dim", cell),
      );
    }
    return theme.fg(index < layout.filled ? color : "dim", cell);
  });
  return theme.fg("dim", "[") + cells.join("") + theme.fg("dim", "]");
}
