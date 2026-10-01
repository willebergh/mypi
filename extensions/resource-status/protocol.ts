export const EXTENSION_LOADED_EVENT = "mypi:extension-loaded";
export const SKILLS_CHANGED_EVENT = "mypi:skills-changed";
export const SKILL_LOADED_EVENT = "mypi:skill-loaded";
export const OPENAI_USAGE_CHANGED_EVENT = "mypi:openai-usage-changed";
export const NESTED_AGENTS_CHANGED_EVENT = "mypi:nested-agents-changed";

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

export function announceExtension(
  events: { emit(name: string, data: unknown): void },
  extension: ExtensionLoadedPayload,
): void {
  events.emit(EXTENSION_LOADED_EVENT, extension);
}
