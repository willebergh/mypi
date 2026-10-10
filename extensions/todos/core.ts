export interface TodoItem {
  id: number;
  text: string;
  completed: boolean;
  completedAt?: number;
}

export interface TodoState {
  items: TodoItem[];
  nextId: number;
}

export type TodoAction =
  | { action: "list" }
  | { action: "add"; text?: string }
  | { action: "complete"; id?: number }
  | { action: "edit"; id?: number; text?: string }
  | { action: "remove"; id?: number }
  | { action: "clear" };

export interface TodoMutation {
  state: TodoState;
  message: string;
}

export function emptyTodoState(): TodoState {
  return { items: [], nextId: 1 };
}

export function cloneTodoState(state: TodoState): TodoState {
  return {
    items: state.items.map((item) => ({ ...item })),
    nextId: state.nextId,
  };
}

function requiredId(action: TodoAction): number {
  if (!("id" in action) || action.id === undefined || !Number.isInteger(action.id)) {
    throw new Error(`A todo id is required for ${action.action}`);
  }
  return action.id;
}

function requiredText(action: TodoAction): string {
  if (!("text" in action) || typeof action.text !== "string" || !action.text.trim()) {
    throw new Error(`Non-empty todo text is required for ${action.action}`);
  }
  return action.text.trim();
}

function findItem(state: TodoState, id: number): TodoItem {
  const item = state.items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`Todo #${id} was not found`);
  return item;
}

export function applyTodoAction(
  currentState: TodoState,
  action: TodoAction,
): TodoMutation {
  const state = cloneTodoState(currentState);

  switch (action.action) {
    case "list":
      return {
        state,
        message: state.items.length
          ? state.items
              .map(
                (item) =>
                  `[${item.completed ? "x" : " "}] #${item.id}: ${item.text}`,
              )
              .join("\n")
          : "No todos",
      };

    case "add": {
      const text = requiredText(action);
      const item: TodoItem = {
        id: state.nextId,
        text,
        completed: false,
      };
      state.nextId += 1;
      state.items.push(item);
      return { state, message: `Added todo #${item.id}: ${item.text}` };
    }

    case "complete": {
      const item = findItem(state, requiredId(action));
      item.completed = true;
      item.completedAt = Date.now();
      return { state, message: `Completed todo #${item.id}: ${item.text}` };
    }

    case "edit": {
      const item = findItem(state, requiredId(action));
      item.text = requiredText(action);
      return { state, message: `Updated todo #${item.id}: ${item.text}` };
    }

    case "remove": {
      const item = findItem(state, requiredId(action));
      state.items = state.items.filter((candidate) => candidate.id !== item.id);
      return { state, message: `Removed todo #${item.id}: ${item.text}` };
    }

    case "clear": {
      const count = state.items.length;
      return {
        state: emptyTodoState(),
        message: `Cleared ${count} todo${count === 1 ? "" : "s"}`,
      };
    }
  }
}

export function isTodoState(value: unknown): value is TodoState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  if (!Number.isInteger(state.nextId) || (state.nextId as number) < 1) return false;
  if (!Array.isArray(state.items)) return false;
  return state.items.every(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      Number.isInteger((item as Record<string, unknown>).id) &&
      typeof (item as Record<string, unknown>).text === "string" &&
      typeof (item as Record<string, unknown>).completed === "boolean" &&
      ((item as Record<string, unknown>).completedAt === undefined ||
        (typeof (item as Record<string, unknown>).completedAt === "number" &&
          Number.isFinite((item as Record<string, unknown>).completedAt))),
  );
}
