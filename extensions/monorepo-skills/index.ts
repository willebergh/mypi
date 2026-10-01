import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  extractPathMentions,
  isInside,
  normalizeReferencedPath,
  pathsFromToolCall,
} from "../nested-agents/core.ts";
import {
  SKILLS_CHANGED_EVENT,
  announceExtension,
} from "../resource-status/protocol.ts";
import {
  discoverMonorepoSkills,
  readSkillName,
  type ScopedSkill,
} from "./core.ts";

const BLOCK_UNTIL_ADVERTISED = new Set(["edit", "write", "bash", "powershell"]);

interface CatalogSkill extends ScopedSkill {
  name: string;
}

export default function monorepoSkills(pi: ExtensionAPI) {
  let root = "";
  let catalog = new Map<string, CatalogSkill>();
  const active = new Set<string>();

  const publishActiveSkills = () => {
    const skills = [...active]
      .map((skillPath) => catalog.get(skillPath))
      .filter((skill): skill is CatalogSkill => Boolean(skill))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((skill) => ({ name: skill.name, path: skill.file }));
    pi.events.emit(SKILLS_CHANGED_EVENT, { skills });
  };

  const activateForAbsolutePaths = (targetPaths: string[]): CatalogSkill[] => {
    const newlyActive: CatalogSkill[] = [];
    for (const skill of catalog.values()) {
      if (active.has(skill.file)) continue;
      if (
        skill.scopeRoots.some((scopeRoot) =>
          targetPaths.some((targetPath) => isInside(scopeRoot, targetPath)),
        )
      ) {
        active.add(skill.file);
        newlyActive.push(skill);
      }
    }
    if (newlyActive.length > 0) publishActiveSkills();
    return newlyActive;
  };

  const resolveTargets = (rawPaths: string[]): string[] =>
    rawPaths
      .map(normalizeReferencedPath)
      .filter(Boolean)
      .map((targetPath) => path.resolve(root, targetPath))
      .filter((targetPath) => isInside(root, targetPath));

  pi.on("session_start", async () => {
    announceExtension(pi.events, {
      id: "monorepo-skills",
      label: "monorepo-skills",
    });
  });

  pi.on("resources_discover", async (event) => {
    const discovery = await discoverMonorepoSkills(event.cwd);
    root = discovery.root;
    active.clear();

    const skills = await Promise.all(
      discovery.scopedSkills.map(async (skill) => ({
        ...skill,
        name: await readSkillName(skill.file),
      })),
    );
    catalog = new Map(skills.map((skill) => [skill.file, skill]));

    // Skills scoped to the initial working directory remain available. Starting
    // at the repository root therefore exposes only repository-root skills.
    activateForAbsolutePaths([path.resolve(event.cwd)]);
    publishActiveSkills();

    // Pi needs the complete resource set for /skill:name expansion. We hide
    // inactive scoped skills from the model prompt until their subtree is used.
    if (discovery.skillFiles.length === 0) return;
    return { skillPaths: discovery.skillFiles };
  });

  pi.on("before_agent_start", async (event) => {
    if (!root || catalog.size === 0) return;

    const mentionedTargets = resolveTargets(extractPathMentions(event.prompt));
    activateForAbsolutePaths(mentionedTargets);

    event.systemPromptOptions.skills = event.systemPromptOptions.skills.filter(
      (skill) => {
        const skillPath = path.resolve(skill.filePath);
        return !catalog.has(skillPath) || active.has(skillPath);
      },
    );
  });

  pi.on("tool_call", async (event) => {
    if (!root || catalog.size === 0) return;

    const references = pathsFromToolCall(event.toolName, event.input);
    const targets = resolveTargets(references.map((reference) => reference.path));
    const newlyActive = activateForAbsolutePaths(targets);
    if (newlyActive.length === 0) return;

    pi.sendMessage(
      {
        customType: "monorepo-skills-activated",
        content: `## Newly available skills\n\nThe following skills apply to the subtree you are now working in. Read the relevant SKILL.md before using one.\n\n${newlyActive
          .map((skill) => `- **${skill.name}** — ${skill.file}`)
          .join("\n")}`,
        display: false,
        details: {
          skills: newlyActive.map((skill) => ({
            name: skill.name,
            path: skill.file,
          })),
        },
      },
      { deliverAs: "steer" },
    );

    if (BLOCK_UNTIL_ADVERTISED.has(event.toolName)) {
      return {
        block: true,
        reason: `Path-scoped skills were activated: ${newlyActive.map((skill) => skill.name).join(", ")}. Review the injected skill catalog, then retry this ${event.toolName} call.`,
      };
    }
  });
}
