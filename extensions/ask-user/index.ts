import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  Text,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { announceExtension } from "../resource-status/protocol.ts";
import {
  formatAskUserResult,
  normalizeQuestions,
  type AskUserResult,
  type QuestionAnswer,
  type RawQuestion,
  type SelectedAnswer,
  type UserQuestion,
} from "./core.ts";

const OptionSchema = Type.Object({
  label: Type.String({ description: "Answer shown to the user" }),
  description: Type.Optional(
    Type.String({ description: "Optional explanation shown below the answer" }),
  ),
});

const QuestionSchema = Type.Object({
  id: Type.String({ description: "Stable unique id used in the returned answers" }),
  label: Type.Optional(
    Type.String({ description: "Short progress label, such as Scope or Database" }),
  ),
  question: Type.String({ description: "Question shown to the user" }),
  mode: Type.Optional(
    StringEnum(["single", "multiple"] as const, {
      description: "Whether the user chooses one or multiple answers; defaults to single",
    }),
  ),
  options: Type.Optional(
    Type.Array(OptionSchema, {
      description: "Suggested answers. Free text and Skip are always added automatically.",
    }),
  ),
});

const AskUserParameters = Type.Object({
  questions: Type.Array(QuestionSchema, {
    description: "One or more questions to ask in a single interactive questionnaire",
  }),
});

type Row =
  | { type: "option"; optionIndex: number }
  | { type: "free-text" }
  | { type: "skip" }
  | { type: "continue" };

interface AnswerState {
  selected: Map<string, SelectedAnswer>;
  custom: SelectedAnswer[];
  skipped: boolean;
}

function emptyAnswerState(): AnswerState {
  return { selected: new Map(), custom: [], skipped: false };
}

function answerValues(state: AnswerState): SelectedAnswer[] {
  return [...state.selected.values(), ...state.custom];
}

function answered(state: AnswerState): boolean {
  return state.skipped || answerValues(state).length > 0;
}

export default function askUserExtension(pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    announceExtension(pi.events, { id: "ask-user", label: "ask-user" });
  });

  pi.registerTool({
    name: "ask_user",
    label: "Ask user",
    description:
      "Ask the user one or more interactive questions. Use this instead of writing numbered questions in chat. Questions may allow one or multiple answers. Free text and Skip are always available.",
    promptGuidelines: [
      "Use ask_user instead of asking the user a numbered list of questions in prose.",
      "Group related clarification questions into one ask_user call.",
    ],
    parameters: AskUserParameters,
    executionMode: "sequential",

    async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
      const questions = normalizeQuestions(parameters.questions as RawQuestion[]);
      if (ctx.mode !== "tui") {
        const result: AskUserResult = {
          questions,
          answers: [],
          cancelled: true,
        };
        return {
          content: [
            {
              type: "text",
              text: "Interactive questions require Pi's terminal UI",
            },
          ],
          details: result,
        };
      }

      const result = await ctx.ui.custom<AskUserResult>(
        (tui, theme, _keybindings, done) => {
          let questionIndex = 0;
          let rowIndex = 0;
          let editing = false;
          let validationMessage: string | undefined;
          let cachedWidth: number | undefined;
          let cachedLines: string[] | undefined;
          const states = new Map(
            questions.map((question) => [question.id, emptyAnswerState()]),
          );

          const editorTheme: EditorTheme = {
            borderColor: (text) => theme.fg("accent", text),
            selectList: {
              selectedPrefix: (text) => theme.fg("accent", text),
              selectedText: (text) => theme.fg("accent", text),
              description: (text) => theme.fg("muted", text),
              scrollInfo: (text) => theme.fg("dim", text),
              noMatch: (text) => theme.fg("warning", text),
            },
          };
          const editor = new Editor(tui, editorTheme);

          const refresh = () => {
            cachedWidth = undefined;
            cachedLines = undefined;
            tui.requestRender();
          };

          const currentQuestion = (): UserQuestion => questions[questionIndex];
          const currentState = (): AnswerState => states.get(currentQuestion().id)!;
          const rows = (): Row[] => {
            const question = currentQuestion();
            const result: Row[] = question.options.map((_option, optionIndex) => ({
              type: "option",
              optionIndex,
            }));
            result.push({ type: "free-text" }, { type: "skip" });
            if (question.mode === "multiple") result.push({ type: "continue" });
            return result;
          };

          const buildResult = (cancelled: boolean): AskUserResult => ({
            questions,
            cancelled,
            answers: questions.map((question): QuestionAnswer => {
              const state = states.get(question.id)!;
              return {
                id: question.id,
                question: question.question,
                skipped: state.skipped,
                answers: answerValues(state),
              };
            }),
          });

          const advance = () => {
            validationMessage = undefined;
            if (questionIndex === questions.length - 1) {
              done(buildResult(false));
              return;
            }
            questionIndex += 1;
            rowIndex = 0;
            refresh();
          };

          const goBack = () => {
            if (questionIndex === 0) return;
            questionIndex -= 1;
            rowIndex = 0;
            validationMessage = undefined;
            refresh();
          };

          const selectRow = () => {
            const question = currentQuestion();
            const state = currentState();
            const row = rows()[rowIndex];
            validationMessage = undefined;

            if (row.type === "option") {
              const option = question.options[row.optionIndex];
              state.skipped = false;
              if (question.mode === "single") {
                state.selected.clear();
                state.custom = [];
                state.selected.set(option.label, {
                  label: option.label,
                  custom: false,
                });
                advance();
              } else {
                if (state.selected.has(option.label)) {
                  state.selected.delete(option.label);
                } else {
                  state.selected.set(option.label, {
                    label: option.label,
                    custom: false,
                  });
                }
                refresh();
              }
              return;
            }

            if (row.type === "free-text") {
              editing = true;
              editor.setText("");
              refresh();
              return;
            }

            if (row.type === "skip") {
              state.selected.clear();
              state.custom = [];
              state.skipped = true;
              advance();
              return;
            }

            if (!answered(state)) {
              validationMessage = "Choose at least one answer, enter free text, or Skip.";
              refresh();
              return;
            }
            advance();
          };

          editor.onSubmit = (value) => {
            const text = value.trim();
            if (!text) {
              validationMessage = "Free-text answers cannot be empty.";
              refresh();
              return;
            }

            const question = currentQuestion();
            const state = currentState();
            state.skipped = false;
            const custom = { label: text, custom: true };
            if (question.mode === "single") {
              state.selected.clear();
              state.custom = [custom];
              editing = false;
              editor.setText("");
              advance();
            } else {
              state.custom.push(custom);
              editing = false;
              editor.setText("");
              refresh();
            }
          };

          const handleInput = (data: string) => {
            if (editing) {
              if (matchesKey(data, Key.escape)) {
                editing = false;
                editor.setText("");
                validationMessage = undefined;
                refresh();
                return;
              }
              editor.handleInput(data);
              refresh();
              return;
            }

            if (matchesKey(data, Key.up)) {
              rowIndex = Math.max(0, rowIndex - 1);
              refresh();
              return;
            }
            if (matchesKey(data, Key.down)) {
              rowIndex = Math.min(rows().length - 1, rowIndex + 1);
              refresh();
              return;
            }
            if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) {
              goBack();
              return;
            }
            if (
              matchesKey(data, Key.enter) ||
              matchesKey(data, Key.space) ||
              data === " "
            ) {
              selectRow();
              return;
            }
            if (matchesKey(data, Key.escape)) {
              done(buildResult(true));
            }
          };

          const addWrapped = (
            lines: string[],
            prefix: string,
            text: string,
            width: number,
          ) => {
            const prefixWidth = visibleWidth(prefix);
            const available = Math.max(1, width - prefixWidth);
            const wrapped = wrapTextWithAnsi(text, available);
            for (let index = 0; index < wrapped.length; index += 1) {
              lines.push(
                `${index === 0 ? prefix : " ".repeat(prefixWidth)}${wrapped[index]}`,
              );
            }
          };

          const render = (width: number): string[] => {
            if (cachedLines && cachedWidth === width) return cachedLines;
            const renderWidth = Math.max(1, width);
            const question = currentQuestion();
            const state = currentState();
            const currentRows = rows();
            const lines: string[] = [];

            lines.push(theme.fg("accent", "─".repeat(renderWidth)));
            const progress = questions
              .map((candidate, index) => {
                const complete = answered(states.get(candidate.id)!);
                const text = ` ${complete ? "■" : "□"} ${candidate.label} `;
                return index === questionIndex
                  ? theme.bg("selectedBg", theme.fg("text", text))
                  : theme.fg(complete ? "success" : "muted", text);
              })
              .join(" ");
            lines.push(...wrapTextWithAnsi(progress, renderWidth));
            lines.push("");
            addWrapped(lines, " ", theme.fg("text", question.question), renderWidth);
            lines.push("");

            currentRows.forEach((row, index) => {
              const focused = index === rowIndex;
              let marker = " ";
              let label = "";
              let description: string | undefined;

              if (row.type === "option") {
                const option = question.options[row.optionIndex];
                const selected = state.selected.has(option.label);
                marker = question.mode === "multiple"
                  ? selected
                    ? "■"
                    : "□"
                  : selected
                    ? "●"
                    : "○";
                label = option.label;
                description = option.description;
              } else if (row.type === "free-text") {
                marker = state.custom.length ? "■" : "✎";
                label = state.custom.length
                  ? `Free text… (${state.custom.length} added)`
                  : "Free text…";
              } else if (row.type === "skip") {
                marker = state.skipped ? "■" : "↷";
                label = "Skip";
              } else {
                marker = "→";
                label = "Continue";
              }

              const prefix = focused ? theme.fg("accent", "> ") : "  ";
              const text = `${marker} ${label}`;
              const styled = focused
                ? theme.bg("selectedBg", theme.fg("text", text))
                : theme.fg("text", text);
              addWrapped(lines, prefix, styled, renderWidth);
              if (description) {
                addWrapped(lines, "    ", theme.fg("muted", description), renderWidth);
              }
            });

            if (editing) {
              lines.push("");
              lines.push(theme.fg("muted", " Free-text answer:"));
              for (const line of editor.render(Math.max(1, renderWidth - 2))) {
                lines.push(` ${line}`);
              }
            }

            if (validationMessage) {
              lines.push("");
              addWrapped(
                lines,
                " ",
                theme.fg("warning", validationMessage),
                renderWidth,
              );
            }

            lines.push("");
            const help = editing
              ? "Enter submit text · Esc return to options"
              : question.mode === "multiple"
                ? "↑↓ navigate · Space/Enter toggle · ← previous · Esc cancel"
                : "↑↓ navigate · Enter select · ← previous · Esc cancel";
            addWrapped(lines, " ", theme.fg("dim", help), renderWidth);
            lines.push(theme.fg("accent", "─".repeat(renderWidth)));

            cachedWidth = width;
            cachedLines = lines;
            return lines;
          };

          return {
            render,
            invalidate() {
              cachedWidth = undefined;
              cachedLines = undefined;
            },
            handleInput,
          };
        },
      );

      return {
        content: [{ type: "text", text: formatAskUserResult(result) }],
        details: result,
      };
    },

    renderCall(arguments_, theme) {
      const count = Array.isArray(arguments_.questions)
        ? arguments_.questions.length
        : 0;
      return new Text(
        theme.fg("toolTitle", theme.bold("ask_user ")) +
          theme.fg("muted", `${count} question${count === 1 ? "" : "s"}`),
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const details = result.details as AskUserResult | undefined;
      if (!details) return new Text("", 0, 0);
      if (details.cancelled) {
        return new Text(theme.fg("warning", "Questionnaire cancelled"), 0, 0);
      }
      return new Text(
        details.answers
          .map((answer) => {
            const value = answer.skipped
              ? theme.fg("dim", "skipped")
              : answer.answers.map((item) => item.label).join(", ");
            return `${theme.fg("success", "✓")} ${theme.fg("accent", answer.id)}: ${value}`;
          })
          .join("\n"),
        0,
        0,
      );
    },
  });
}
