export const EXTENSION_LOADED_EVENT = "mypi:extension-loaded";
export const SKILLS_CHANGED_EVENT = "mypi:skills-changed";
export const SKILL_LOADED_EVENT = "mypi:skill-loaded";
export const OPENAI_USAGE_CHANGED_EVENT = "mypi:openai-usage-changed";
export const NESTED_AGENTS_CHANGED_EVENT = "mypi:nested-agents-changed";
export const SUBAGENTS_CHANGED_EVENT = "mypi:subagents-changed";
export const TODOS_CHANGED_EVENT = "mypi:todos-changed";
export const DICTATION_CHANGED_EVENT = "mypi:dictation-changed";
export const TALK_CHANGED_EVENT = "mypi:talk-changed";
export const TALK_STATUS_CHANGED_EVENT = "mypi:talk-status-changed";

export type DictationState = "idle" | "connecting" | "listening" | "finishing";
export type TalkState = "idle" | "connecting" | "listening" | "closing";

export interface TalkStatusPayload {
  state: TalkState;
  /** FaceTime idle represents armed standby rather than an inactive mic. */
  mode?: "facetime";
  /** Plain, single-line progress text, at most 160 UTF-16 code units. */
  detail?: string;
  /** Finite, nonnegative duration supplied by Talk; never extrapolated. */
  elapsedMs?: number;
}

export interface ExtensionLoadedPayload {
  id: string;
  label: string;
}

export interface DiscoveredSkill {
  name: string;
  path: string;
}

export interface SkillsChangedPayload {
  skills: DiscoveredSkill[];
}

export type SkillLoadedPayload = DiscoveredSkill;

export interface NestedAgentsChangedPayload {
  files: string[];
}

export interface SubagentsChangedPayload {
  states: import("../subagents/core.ts").SubagentState[];
}

export interface TodosChangedPayload {
  state: import("../todos/core.ts").TodoState;
}

export function isAgentInstructionFile(file: string): boolean {
  return ["agents.override.md", "agents.md", "claude.md"].includes(
    file.toLowerCase(),
  );
}

export function announceExtension(
  events: { emit(name: string, data: unknown): void },
  extension: ExtensionLoadedPayload,
): void {
  events.emit(EXTENSION_LOADED_EVENT, extension);
}
