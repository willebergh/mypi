import { StringEnum, Type } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { announceExtension } from "../resource-status/protocol.ts";
import {
  applyTodoAction,
  cloneTodoState,
  emptyTodoState,
  isTodoState,
  type TodoAction,
  type TodoState,
} from "./core.ts";

const TOOL_NAME = "todo";
const WIDGET_KEY = "mypi-todos";

const TodoParameters = Type.Object({
  action: StringEnum(
    ["list", "add", "complete", "edit", "remove", "clear"] as const,
    { description: "Todo operation to perform" },
  ),
  id: Type.Optional(
    Type.Number({ description: "Todo id for complete, edit, or remove" }),
  ),
  text: Type.Optional(
    Type.String({ description: "Todo text for add or edit" }),
  ),
});

interface TodoDetails {
  action: TodoAction["action"];
  state: TodoState;
}

export default function todosExtension(pi: ExtensionAPI) {
  let state = emptyTodoState();
  let requestRender: (() => void) | undefined;

  const refresh = () => requestRender?.();

  const reconstructState = (ctx: ExtensionContext) => {
    state = emptyTodoState();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message.role !== "toolResult" || message.toolName !== TOOL_NAME) continue;
      const details = message.details as TodoDetails | undefined;
      if (details && isTodoState(details.state)) {
        state = cloneTodoState(details.state);
      }
    }
    refresh();
  };

  pi.on("session_start", async (_event, ctx) => {
    announceExtension(pi.events, { id: "todos", label: "todos" });
    reconstructState(ctx);

    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget(
      WIDGET_KEY,
      (tui, theme) => {
        requestRender = () => tui.requestRender();
        return {
          invalidate() {},
          dispose() {
            requestRender = undefined;
          },
          render(width: number): string[] {
            if (state.items.length === 0) return [];

            const availableWidth = Math.max(1, width);
            const completed = state.items.filter((item) => item.completed).length;
            const lines = [
              truncateToWidth(
                theme.fg(
                  "accent",
                  `Todos (${completed}/${state.items.length} completed)`,
                ),
                availableWidth,
              ),
            ];

            for (const item of state.items) {
              const marker = item.completed
                ? theme.fg("success", "✓")
                : theme.fg("dim", "○");
              const id = theme.fg("accent", `#${item.id}`);
              const text = item.completed
                ? theme.fg("dim", theme.strikethrough(item.text))
                : theme.fg("text", item.text);
              lines.push(
                ...wrapTextWithAnsi(
                  `  ${marker} ${id} ${text}`,
                  availableWidth,
                ),
              );
            }
            return lines;
          },
        };
      },
      { placement: "belowEditor" },
    );
  });

  pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

  pi.on("session_shutdown", async (_event, ctx) => {
    requestRender = undefined;
    if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Todo list",
    description:
      "Manage the session todo list. Use it to list, add, complete, edit, remove, or clear todos. Keep the list current while working through multi-step tasks.",
    parameters: TodoParameters,
    executionMode: "sequential",
    async execute(_toolCallId, parameters) {
      const action = parameters as TodoAction;
      const mutation = applyTodoAction(state, action);
      state = mutation.state;
      refresh();
      return {
        content: [{ type: "text", text: mutation.message }],
        details: {
          action: action.action,
          state: cloneTodoState(state),
        } satisfies TodoDetails,
      };
    },
  });

  pi.registerCommand("todos", {
    description: "Show the current session todo list",
    handler: async (_args, ctx) => {
      const result = applyTodoAction(state, { action: "list" });
      ctx.ui.notify(result.message, "info");
    },
  });
}
