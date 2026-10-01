import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  NESTED_AGENTS_CHANGED_EVENT,
  announceExtension,
} from "../resource-status/protocol.ts";
import {
  extractPathMentions,
  findApplicableAgentsFiles,
  pathsFromToolCall,
  toPosix,
  type ReferencedPath,
} from "./core.ts";

const CONTEXT_TYPE = "nested-agents-context";
const BLOCK_UNTIL_LOADED = new Set(["edit", "write", "bash", "powershell"]);

function uniqueSorted(paths: string[]): string[] {
  return [...new Set(paths)].sort((left, right) => {
    const depthDifference = left.split(path.sep).length - right.split(path.sep).length;
    return depthDifference || left.localeCompare(right);
  });
}

async function applicableFiles(
  root: string,
  references: ReferencedPath[],
): Promise<string[]> {
  const results = await Promise.all(
    references.map((reference) =>
      findApplicableAgentsFiles(root, reference.path, reference.kind),
    ),
  );
  return uniqueSorted(results.flat());
}

async function contextMessage(root: string, files: string[]) {
  const sections = await Promise.all(
    files.map(async (file) => {
      const relativePath = toPosix(path.relative(root, file));
      try {
        const content = (await readFile(file, "utf8")).trimEnd();
        return `### ${relativePath}\n\n${content}`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `### ${relativePath}\n\nUnable to read this instruction file: ${message}`;
      }
    }),
  );

  return {
    customType: CONTEXT_TYPE,
    content: `## Nested AGENTS.md instructions\n\nThe following project instructions apply to files under their directories. Follow all applicable instructions. When instructions conflict, the more deeply nested AGENTS.md takes precedence.\n\n${sections.join("\n\n---\n\n")}`,
    display: false,
    details: {
      files: files.map((file) => toPosix(path.relative(root, file))),
    },
  };
}

export default function nestedAgents(pi: ExtensionAPI) {
  let root = "";
  let currentTurn = -1;
  const delivered = new Set<string>();
  const queuedForTurn = new Map<string, number>();
  const loadedFiles = new Set<string>();

  const publishLoadedFiles = () => {
    pi.events.emit(NESTED_AGENTS_CHANGED_EVENT, {
      files: [...loadedFiles]
        .map((file) => toPosix(path.relative(root, file)))
        .sort((left, right) => left.localeCompare(right)),
    });
  };

  const markLoaded = (files: string[]) => {
    let changed = false;
    for (const file of files) {
      if (!loadedFiles.has(file)) changed = true;
      loadedFiles.add(file);
    }
    if (changed) publishLoadedFiles();
  };

  pi.on("session_start", async (_event, ctx) => {
    announceExtension(pi.events, {
      id: "nested-agents",
      label: "nested-agents",
    });
    root = path.resolve(ctx.cwd);
    currentTurn = -1;
    delivered.clear();
    queuedForTurn.clear();
    loadedFiles.clear();
    publishLoadedFiles();
  });

  pi.on("turn_start", async (event) => {
    currentTurn = event.turnIndex;
    for (const [file, availableTurn] of queuedForTurn) {
      if (availableTurn <= currentTurn) {
        delivered.add(file);
        queuedForTurn.delete(file);
      }
    }
  });

  pi.on("before_agent_start", async (event) => {
    if (!root) return;

    const references = extractPathMentions(event.prompt).map((mentionedPath) => ({
      path: mentionedPath,
      kind: "unknown" as const,
    }));
    const files = await applicableFiles(root, references);
    const needed = files.filter(
      (file) => !delivered.has(file) && !queuedForTurn.has(file),
    );

    if (needed.length === 0) return;
    for (const file of needed) delivered.add(file);
    markLoaded(needed);

    return { message: await contextMessage(root, needed) };
  });

  pi.on("tool_call", async (event) => {
    if (!root) return;

    const references = pathsFromToolCall(event.toolName, event.input);
    if (references.length === 0) return;

    const files = await applicableFiles(root, references);
    const notYetDelivered = files.filter((file) => !delivered.has(file));
    if (notYetDelivered.length === 0) return;

    const newlyQueued = notYetDelivered.filter(
      (file) => !queuedForTurn.has(file),
    );

    if (newlyQueued.length > 0) {
      const availableTurn = currentTurn + 1;
      for (const file of newlyQueued) queuedForTurn.set(file, availableTurn);
      markLoaded(newlyQueued);
      pi.sendMessage(await contextMessage(root, newlyQueued), {
        deliverAs: "steer",
      });
    }

    if (BLOCK_UNTIL_LOADED.has(event.toolName)) {
      const relativeFiles = notYetDelivered
        .map((file) => toPosix(path.relative(root, file)))
        .join(", ");
      return {
        block: true,
        reason: `Nested AGENTS.md instructions were loaded from ${relativeFiles}. Review them, then retry this ${event.toolName} call.`,
      };
    }
  });
}
