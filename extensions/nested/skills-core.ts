import { homedir } from "node:os";
import path from "node:path";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  ".vercel",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(homedir(), value.slice(2));
  }
  return value;
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch {
    return false;
  }
}

/** Find the nearest repository root, falling back to the current directory. */
export async function findRepositoryRoot(cwd: string): Promise<string> {
  let current = path.resolve(cwd);

  while (true) {
    if (await exists(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(cwd);
    current = parent;
  }
}

interface WalkOptions {
  onFile: (file: string) => Promise<void> | void;
  visitedDirectories: Set<string>;
}

async function walk(directory: string, options: WalkOptions): Promise<void> {
  let canonicalDirectory: string;
  try {
    canonicalDirectory = await realpath(directory);
  } catch {
    return;
  }

  if (options.visitedDirectories.has(canonicalDirectory)) return;
  options.visitedDirectories.add(canonicalDirectory);

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        await walk(fullPath, options);
      }
      continue;
    }

    if (entry.isSymbolicLink()) {
      try {
        const target = await lstat(await realpath(fullPath));
        if (target.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name)) {
          await walk(fullPath, options);
        } else if (target.isFile()) {
          await options.onFile(fullPath);
        }
      } catch {
        // Ignore broken and inaccessible symlinks.
      }
      continue;
    }

    if (entry.isFile()) await options.onFile(fullPath);
  }
}

function isConventionalNestedSkill(file: string): boolean {
  if (path.basename(file) !== "SKILL.md") return false;

  const segments = path.resolve(file).split(path.sep);
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (
      (segment === ".agents" || segment === ".pi") &&
      segments[index + 1] === "skills"
    ) {
      return true;
    }
  }

  return false;
}

/** Find portable SKILL.md files below a configured file or directory. */
export async function collectSkillFiles(resourcePath: string): Promise<string[]> {
  const resolved = path.resolve(expandHome(resourcePath));
  let resource;
  try {
    resource = await lstat(resolved);
  } catch {
    return [];
  }

  if (resource.isFile()) {
    return resolved.endsWith(".md") ? [resolved] : [];
  }

  if (!resource.isDirectory() && !resource.isSymbolicLink()) return [];

  const skills: string[] = [];
  await walk(resolved, {
    visitedDirectories: new Set(),
    onFile(file) {
      if (path.basename(file) === "SKILL.md") skills.push(path.resolve(file));
    },
  });
  return skills;
}

function configuredSkillEntries(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }

  const skills = (value as Record<string, unknown>).skills;
  if (!Array.isArray(skills)) return [];

  return skills.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Resolve literal skill paths from a nested .pi/settings.json.
 *
 * Negative selectors and globs are left to Pi's own settings loader and are not
 * reinterpreted here. Exact `+path` inclusions are supported.
 */
export async function skillsFromSettings(settingsFile: string): Promise<string[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(settingsFile, "utf8"));
  } catch {
    return [];
  }

  const settingsDirectory = path.dirname(settingsFile);
  const results: string[] = [];

  for (const entry of configuredSkillEntries(parsed)) {
    if (entry.startsWith("!") || entry.startsWith("-")) continue;

    const value = entry.startsWith("+") ? entry.slice(1) : entry;
    if (!value || /[*?{}[\]]/.test(value)) continue;

    const expanded = expandHome(value);
    const resolved = path.isAbsolute(expanded)
      ? expanded
      : path.resolve(settingsDirectory, expanded);
    results.push(...(await collectSkillFiles(resolved)));
  }

  return results;
}

export async function readSkillName(skillFile: string): Promise<string> {
  try {
    const content = await readFile(skillFile, "utf8");
    const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/);
    const name = frontmatter?.[1].match(/^name:\s*(.+?)\s*$/m)?.[1];
    if (name) return name.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2");
  } catch {
    // Fall back to the skill directory name.
  }
  return path.basename(path.dirname(skillFile));
}

export interface ScopedSkill {
  file: string;
  scopeRoots: string[];
}

export interface MonorepoSkillDiscovery {
  root: string;
  skillFiles: string[];
  scopedSkills: ScopedSkill[];
  settingsFiles: string[];
}

function conventionalSkillScope(skillFile: string): string | undefined {
  let current = path.dirname(skillFile);
  while (true) {
    if (path.basename(current) === "skills") {
      const resourceDirectory = path.dirname(current);
      const resourceName = path.basename(resourceDirectory);
      if (resourceName === ".agents" || resourceName === ".pi") {
        return path.dirname(resourceDirectory);
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Discover nested .agents/.pi skills and literal skill references in nested settings. */
export async function discoverMonorepoSkills(
  cwd: string,
): Promise<MonorepoSkillDiscovery> {
  const root = await findRepositoryRoot(cwd);
  const directSkills: string[] = [];
  const settingsFiles: string[] = [];

  await walk(root, {
    visitedDirectories: new Set(),
    onFile(file) {
      if (isConventionalNestedSkill(file)) directSkills.push(path.resolve(file));
      if (
        path.basename(file) === "settings.json" &&
        path.basename(path.dirname(file)) === ".pi"
      ) {
        settingsFiles.push(path.resolve(file));
      }
    },
  });

  const configuredSkillGroups = await Promise.all(
    settingsFiles.map(async (settingsFile) => ({
      scopeRoot: path.dirname(path.dirname(settingsFile)),
      files: await skillsFromSettings(settingsFile),
    })),
  );
  const scopedByCanonicalPath = new Map<string, Set<string>>();

  const addScopedSkill = async (file: string, scopeRoot: string | undefined) => {
    if (!scopeRoot) return;
    let canonicalFile: string;
    try {
      canonicalFile = await realpath(file);
    } catch {
      canonicalFile = path.resolve(file);
    }
    // Keep scopes in the repository's lexical path space. On macOS, realpath()
    // rewrites /var to /private/var; mixing that with cwd-derived tool paths
    // would make valid subtree checks fail.
    const canonicalScope = path.resolve(scopeRoot);
    const scopes = scopedByCanonicalPath.get(canonicalFile) ?? new Set<string>();
    scopes.add(canonicalScope);
    scopedByCanonicalPath.set(canonicalFile, scopes);
  };

  await Promise.all(
    directSkills.map((file) => addScopedSkill(file, conventionalSkillScope(file))),
  );
  await Promise.all(
    configuredSkillGroups.flatMap((group) =>
      group.files.map((file) => addScopedSkill(file, group.scopeRoot)),
    ),
  );

  const scopedSkills = [...scopedByCanonicalPath.entries()]
    .map(([file, scopeRoots]) => ({
      file,
      scopeRoots: [...scopeRoots].sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.file.localeCompare(b.file));

  return {
    root,
    skillFiles: scopedSkills.map((skill) => skill.file),
    scopedSkills,
    settingsFiles: [...new Set(settingsFiles)].sort((a, b) => a.localeCompare(b)),
  };
}
