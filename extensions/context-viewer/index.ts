import type {
  ExtensionAPI,
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import { announceExtension } from "../resource-status/protocol.ts";

class ReadonlyPromptViewer implements Component {
  private renderedLines: string[] = [];
  private cacheWidth?: number;

  constructor(
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly systemPrompt: string,
    private readonly done: () => void,
  ) {}

  handleInput(data: string): void {
    if (
      this.keybindings.matches(data, "tui.select.cancel") ||
      matchesKey(data, Key.escape) ||
      data === "q"
    ) {
      this.done();
    }
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    if (this.cacheWidth === safeWidth && this.renderedLines.length > 0) {
      return this.renderedLines;
    }

    const lines = [
      truncateToWidth(
        this.theme.fg("accent", this.theme.bold("System prompt")),
        safeWidth,
        "",
      ),
      "",
    ];

    for (const line of this.systemPrompt.split("\n")) {
      if (line.length === 0) {
        lines.push("");
      } else {
        lines.push(...wrapTextWithAnsi(line, safeWidth));
      }
    }

    lines.push(
      "",
      truncateToWidth(
        this.theme.fg(
          "dim",
          "Use terminal scrollback or the mouse to scroll • Esc/q close",
        ),
        safeWidth,
        "",
      ),
    );

    this.cacheWidth = safeWidth;
    this.renderedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cacheWidth = undefined;
    this.renderedLines = [];
  }
}

export default function contextViewer(pi: ExtensionAPI) {
  pi.on("session_start", () => {
    announceExtension(pi.events, {
      id: "context-viewer",
      label: "context viewer",
    });
  });

  pi.registerCommand("context-viewer", {
    description: "Show the effective system prompt sent as agent instructions",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) {
          ctx.ui.notify("The context viewer requires interactive TUI mode", "warning");
        }
        return;
      }

      await ctx.ui.custom<void>((_tui, theme, keybindings, done) =>
        new ReadonlyPromptViewer(
          theme,
          keybindings,
          ctx.getSystemPrompt(),
          done,
        ),
      );
    },
  });
}
