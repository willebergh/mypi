export interface NamedResource {
  id: string;
  label: string;
}

export function sortedUniqueLabels(resources: NamedResource[]): string[] {
  const labels = new Map<string, string>();
  for (const resource of resources) labels.set(resource.id, resource.label);
  return [...labels.values()].sort((a, b) => a.localeCompare(b));
}

export function resourceSummary(label: string, values: string[]): string {
  return values.length === 0
    ? `${label} (0): none`
    : `${label} (${values.length}): ${values.join(" · ")}`;
}

export interface ProgressBar {
  percent: number | null;
  barWidth: number;
  filled: number;
}

export interface ContextProgress extends ProgressBar {
  tokens: number | null;
  contextWindow: number;
  tokenLabel: string;
}

export function compactTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${Math.round(tokens / 1_000)}k`;
}

export interface CompactContextBarLayout {
  cells: string[];
  filled: number;
  percent: number | null;
}

export function compactProgressBarLayout(
  percent: number | null,
  rightLabel: string,
  leftLabel?: string,
): CompactContextBarLayout {
  const width = 32;
  const clamped =
    percent === null ? null : Math.max(0, Math.min(100, percent));
  const filled = clamped === null ? 0 : Math.round((clamped / 100) * width);
  const cells: string[] = Array.from({ length: width }, (_, index) =>
    index < filled ? "█" : "░",
  );
  const percentLabel = clamped === null ? "?%" : `${clamped.toFixed(1)}%`;

  if (leftLabel === undefined) {
    for (const [index, character] of [...percentLabel].entries()) {
      if (index + 3 < width) cells[index + 3] = character;
    }
    const rightStart = Math.max(0, width - 3 - rightLabel.length);
    for (const [index, character] of [...rightLabel].entries()) {
      if (index + rightStart < width) cells[index + rightStart] = character;
    }
    return { cells, filled, percent: clamped };
  }

  const rightCharacters = [...rightLabel].slice(-(width - 2));
  const rightStart = width - 1 - rightCharacters.length;
  const percentEnd = 20;
  const percentStart = percentEnd - percentLabel.length;
  const visibleLeftLabel = [...leftLabel].slice(0, Math.max(0, percentStart - 2));
  for (const [index, character] of visibleLeftLabel.entries()) {
    cells[index + 1] = character;
  }
  for (const [index, character] of [...percentLabel].entries()) {
    cells[index + percentStart] = character;
  }
  for (const [index, character] of rightCharacters.entries()) {
    cells[index + rightStart] = character;
  }
  return { cells, filled, percent: clamped };
}

export function compactContextBarLayout(
  tokens: number | null,
  contextWindow: number | undefined,
  suppliedPercent?: number | null,
  leftLabel?: string,
): CompactContextBarLayout {
  if (!contextWindow || contextWindow <= 0) {
    return { cells: Array(32).fill("░"), filled: 0, percent: null };
  }
  const calculatedPercent =
    tokens !== null ? (tokens / contextWindow) * 100 : null;
  const percent = suppliedPercent === undefined ? calculatedPercent : suppliedPercent;
  const tokenLabel = `${tokens === null ? "?" : compactTokens(tokens)}/${compactTokens(contextWindow)}`;
  const layout = compactProgressBarLayout(percent, tokenLabel, leftLabel);
  if (leftLabel !== undefined) {
    const labelEnd = Math.min(15, 1 + [...leftLabel].length);
    for (let index = labelEnd; index < 15; index += 1) {
      layout.cells[index] = " ";
    }
  }
  return layout;
}

export function compactContextBar(
  tokens: number | null,
  contextWindow: number | undefined,
  suppliedPercent?: number | null,
  leftLabel?: string,
): string {
  const layout = compactContextBarLayout(
    tokens,
    contextWindow,
    suppliedPercent,
    leftLabel,
  );
  return `[${layout.cells.join("")}]`;
}

export function progressBar(
  percent: number | null,
  width: number,
  fixedWidth: number,
): ProgressBar {
  const clamped = percent === null ? null : Math.min(100, Math.max(0, percent));
  const barWidth = Math.max(4, Math.min(32, width - fixedWidth));
  return {
    percent: clamped,
    barWidth,
    filled: clamped === null ? 0 : Math.round((clamped / 100) * barWidth),
  };
}

export function contextProgress(
  usage: {
    percent: number | null;
    tokens: number | null;
    contextWindow: number;
  },
  width: number,
): ContextProgress {
  const percent =
    usage.percent === null ? null : Math.min(100, Math.max(0, usage.percent));
  const tokenLabel = `${usage.tokens === null ? "?" : compactTokens(usage.tokens)}/${compactTokens(usage.contextWindow)}`;
  const percentLabel = percent === null ? "?" : `${percent.toFixed(1)}%`;
  const progress = progressBar(
    percent,
    width,
    "Context []  · ".length + percentLabel.length + tokenLabel.length,
  );

  return {
    ...progress,
    tokens: usage.tokens,
    contextWindow: usage.contextWindow,
    tokenLabel,
  };
}
