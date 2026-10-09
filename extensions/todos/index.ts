import { StringEnum, Type } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  TODOS_CHANGED_EVENT,
  announceExtension,
} from "../resource-status/protocol.ts";
import {
  applyTodoAction,
  cloneTodoState,
  emptyTodoState,
  isTodoState,
  type TodoAction,
  type TodoState,
} from "./core.ts";

const TOOL_NAME = "todo";

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

  const publish = () => {
    pi.events.emit(TODOS_CHANGED_EVENT, { state: cloneTodoState(state) });
  };

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
    publish();
  };

  pi.on("session_start", async (_event, ctx) => {
    announceExtension(pi.events, { id: "todos", label: "todos" });
    reconstructState(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

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
      publish();
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
