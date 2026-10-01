import { stat } from "node:fs/promises";
import path from "node:path";

export const AGENTS_FILENAME = "AGENTS.md";

export type TargetKind = "file" | "directory" | "unknown";

export function toPosix(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function normalizeReferencedPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  const unwrapped =
    trimmed.length >= 2 &&
    ((trimmed.startsWith("`") && trimmed.endsWith("`")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
      ? trimmed.slice(1, -1)
      : trimmed;

  return unwrapped.startsWith("@") ? unwrapped.slice(1) : unwrapped;
}

async function targetDirectory(
  root: string,
  rawPath: string,
  kind: TargetKind,
): Promise<string | undefined> {
  const normalized = normalizeReferencedPath(rawPath);
  if (!normalized) return undefined;

  const absoluteTarget = path.resolve(root, normalized);
  if (!isInside(root, absoluteTarget)) return undefined;

  if (path.basename(absoluteTarget) === AGENTS_FILENAME || kind === "file") {
    return path.dirname(absoluteTarget);
  }

  if (kind === "directory") return absoluteTarget;

  try {
    return (await stat(absoluteTarget)).isDirectory()
      ? absoluteTarget
      : path.dirname(absoluteTarget);
  } catch {
    return path.dirname(absoluteTarget);
  }
}

/**
 * Find nested AGENTS.md files that govern a target path.
 *
 * The root AGENTS.md is deliberately excluded because Pi already discovers the
 * working directory's AGENTS.md and applicable files in its parent directories.
 */
export async function findApplicableAgentsFiles(
  rootPath: string,
  rawPath: string,
  kind: TargetKind = "unknown",
): Promise<string[]> {
  const root = path.resolve(rootPath);
  const directory = await targetDirectory(root, rawPath, kind);
  if (!directory) return [];

  const directories: string[] = [];
  let current = directory;

  while (current !== root) {
    if (!isInside(root, current)) return [];
    directories.push(current);

    const parent = path.dirname(current);
    if (parent === current) return [];
    current = parent;
  }

  const results: string[] = [];
  for (const candidateDirectory of directories.reverse()) {
    const candidate = path.join(candidateDirectory, AGENTS_FILENAME);
    try {
      if ((await stat(candidate)).isFile()) results.push(candidate);
    } catch {
      // A missing or unreadable candidate does not govern the target.
    }
  }

  return results;
}

/** Extract path-like mentions such as `src/foo.ts`, ./src, or @docs/guide.md. */
export function extractPathMentions(text: string): string[] {
  const matches = new Set<string>();
  const pattern =
    /(?:^|[\s`"'(])((?:@?\.?\.?\/)?(?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.@-]+)(?=$|[\s`"'),:;])/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const value = match[1]?.replace(/[.!?]+$/, "");
    if (value && !value.includes("://")) {
      matches.add(normalizeReferencedPath(value));
    }
  }

  return [...matches];
}

export interface ReferencedPath {
  path: string;
  kind: TargetKind;
}

export function pathsFromToolCall(
  toolName: string,
  input: unknown,
): ReferencedPath[] {
  if (typeof input !== "object" || input === null) return [];
  const record = input as Record<string, unknown>;

  if (
    (toolName === "read" || toolName === "edit" || toolName === "write") &&
    typeof record.path === "string"
  ) {
    return [{ path: record.path, kind: "file" }];
  }

  if (
    (toolName === "grep" || toolName === "find" || toolName === "ls") &&
    typeof record.path === "string"
  ) {
    return [{ path: record.path, kind: "directory" }];
  }

  if (
    (toolName === "bash" || toolName === "powershell") &&
    typeof record.command === "string"
  ) {
    return extractPathMentions(record.command).map((mentionedPath) => ({
      path: mentionedPath,
      kind: "unknown",
    }));
  }

  return [];
}
