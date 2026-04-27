import {
  readFileSync,
  existsSync,
  readdirSync,
  lstatSync,
  realpathSync,
  symlinkSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { join, basename, dirname, relative } from "node:path";
import { z } from "zod/v4";
import { parseFrontmatter } from "./agents.js";

const SkillFrontmatterSchema = z.object({
  name: z.string(),
  description: z.string(),
  triggers: z.array(z.string()).optional().default([]),
  category: z.string().optional().default("utility"),
  tools_needed: z.array(z.string()).optional().default([]),
  channel_hints: z.array(z.string()).optional().default(["any"]),
  examples: z.array(z.string()).optional().default([]),
  composable_with: z.array(z.string()).optional().default([]),
});

export type SkillFormat = "flat" | "directory";

export interface SkillDefinition {
  name: string;
  description: string;
  triggers: string[];
  fileName: string;
  sourcePath: string;
  format: SkillFormat;
  category: string;
  tools_needed: string[];
  channel_hints: string[];
  examples: string[];
  composable_with: string[];
}

const skillBodyCache = new Map<string, string>();
const knowledgeCache = new Map<string, string>();

function warnSkillFallback(context: string, err: unknown): void {
  console.warn(`[skills] ${context}: ${err instanceof Error ? err.message : String(err)}`);
}

export function clearSkillCache(): void {
  skillBodyCache.clear();
}

export function clearKnowledgeCache(): void {
  knowledgeCache.clear();
}

type Source = {
  readonly label: string;
  readonly dir: string;
  readonly kind: "directory-scan" | "flat-scan";
};

function skillSources(homePath: string): Source[] {
  return [
    {
      label: ".agents/skills",
      dir: join(homePath, ".agents", "skills"),
      kind: "directory-scan",
    },
    {
      label: ".claude/skills",
      dir: join(homePath, ".claude", "skills"),
      kind: "directory-scan",
    },
    {
      label: "agents/skills",
      dir: join(homePath, "agents", "skills"),
      kind: "flat-scan",
    },
  ];
}

function tryRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch (err: unknown) {
    warnSkillFallback(`Could not resolve realpath for ${path}`, err);
    return null;
  }
}

function parseSkillFile(
  filePath: string,
  format: SkillFormat,
  label: string,
): SkillDefinition | null {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err: unknown) {
    warnSkillFallback(`Could not read ${filePath}`, err);
    return null;
  }

  const { frontmatter, body } = parseFrontmatter(content);
  const result = SkillFrontmatterSchema.safeParse(frontmatter);
  if (!result.success) {
    console.warn(
      `[skills] Skipping ${label}/${basename(filePath)}: invalid frontmatter -- ${result.error.issues.map((i) => i.message).join(", ")}`,
    );
    return null;
  }
  const meta = result.data;

  skillBodyCache.set(`${label}:${meta.name}`, body.trim() || content);
  if (!skillBodyCache.has(meta.name)) {
    skillBodyCache.set(meta.name, body.trim() || content);
  }

  const fileName =
    format === "directory"
      ? `${basename(dirname(filePath))}/SKILL.md`
      : basename(filePath);

  return {
    name: meta.name,
    description: meta.description,
    triggers: meta.triggers,
    fileName,
    sourcePath: filePath,
    format,
    category: meta.category,
    tools_needed: meta.tools_needed,
    channel_hints: meta.channel_hints,
    examples: meta.examples,
    composable_with: meta.composable_with,
  };
}

function scanDirectory(source: Source): SkillDefinition[] {
  if (!existsSync(source.dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(source.dir);
  } catch (err: unknown) {
    warnSkillFallback(`Could not scan ${source.dir}`, err);
    return [];
  }
  const out: SkillDefinition[] = [];
  for (const entry of entries) {
    const entryPath = join(source.dir, entry);
    let stat;
    try {
      stat = lstatSync(entryPath);
    } catch (err: unknown) {
      warnSkillFallback(`Could not inspect ${entryPath}`, err);
      continue;
    }
    // Accept both real dirs and symlinks to dirs.
    if (!stat.isDirectory() && !stat.isSymbolicLink()) continue;
    const skillMd = join(entryPath, "SKILL.md");
    if (!existsSync(skillMd)) continue;
    const def = parseSkillFile(skillMd, "directory", source.label);
    if (def) out.push(def);
  }
  return out;
}

function scanFlat(source: Source): SkillDefinition[] {
  if (!existsSync(source.dir)) return [];
  let files: string[];
  try {
    files = readdirSync(source.dir).filter((f) => f.endsWith(".md"));
  } catch (err: unknown) {
    warnSkillFallback(`Could not scan ${source.dir}`, err);
    return [];
  }
  const out: SkillDefinition[] = [];
  for (const file of files) {
    const def = parseSkillFile(join(source.dir, file), "flat", source.label);
    if (def) out.push(def);
  }
  return out;
}

export function loadSkills(homePath: string): SkillDefinition[] {
  const sources = skillSources(homePath);
  const byName = new Map<string, SkillDefinition>();
  const seenRealpaths = new Set<string>();

  for (const source of sources) {
    const defs =
      source.kind === "directory-scan" ? scanDirectory(source) : scanFlat(source);

    for (const def of defs) {
      // Resolve the underlying file (follows symlinks) to dedupe mirror entries.
      const real = tryRealpath(def.sourcePath);
      if (real && seenRealpaths.has(real)) continue;
      if (real) seenRealpaths.add(real);

      const existing = byName.get(def.name);
      if (existing) {
        if (existing.sourcePath !== def.sourcePath) {
          console.warn(
            `[skills] duplicate name '${def.name}' at ${def.sourcePath} (kept ${existing.sourcePath})`,
          );
        }
        continue;
      }
      byName.set(def.name, def);
    }
  }

  return [...byName.values()];
}

export function loadSkillBody(
  homePath: string,
  skillName: string,
): string | null {
  const cached = skillBodyCache.get(skillName);
  if (cached !== undefined) return cached;

  const sources = skillSources(homePath);
  for (const source of sources) {
    if (!existsSync(source.dir)) continue;

    if (source.kind === "directory-scan") {
      const skillMd = join(source.dir, skillName, "SKILL.md");
      if (existsSync(skillMd)) {
        const content = readFileSync(skillMd, "utf-8");
        const { body } = parseFrontmatter(content);
        const value = body.trim() || content;
        skillBodyCache.set(skillName, value);
        return value;
      }
      // Fall through to scan in case the directory name differs from the skill `name` field.
      let entries: string[];
      try {
        entries = readdirSync(source.dir);
      } catch (err: unknown) {
        warnSkillFallback(`Could not scan ${source.dir}`, err);
        continue;
      }
      for (const entry of entries) {
        const candidate = join(source.dir, entry, "SKILL.md");
        if (!existsSync(candidate)) continue;
        const content = readFileSync(candidate, "utf-8");
        const { frontmatter, body } = parseFrontmatter(content);
        if (frontmatter.name === skillName) {
          const value = body.trim() || content;
          skillBodyCache.set(skillName, value);
          return value;
        }
      }
      continue;
    }

    // Flat scan
    let files: string[];
    try {
      files = readdirSync(source.dir).filter((f) => f.endsWith(".md"));
    } catch (err: unknown) {
      warnSkillFallback(`Could not scan ${source.dir}`, err);
      continue;
    }
    for (const file of files) {
      const content = readFileSync(join(source.dir, file), "utf-8");
      const { frontmatter, body } = parseFrontmatter(content);
      if (frontmatter.name === skillName) {
        const value = body.trim() || content;
        skillBodyCache.set(skillName, value);
        return value;
      }
    }
  }

  return null;
}

/**
 * Populate home/.claude/skills/<name> as symlinks pointing to home/.agents/skills/<name>.
 *
 * This is the bridge that lets the Claude Agent SDK's native Skill tool discover
 * skills stored in the open Agent Skills canonical location. The SDK hardcodes
 * `.claude/skills/` as its scan path when `settingSources: ['project']` is set,
 * so we mirror the canonical directory into the location the SDK looks at.
 *
 * Idempotent. Does not overwrite existing non-symlink entries (so third-party
 * skills installed directly into .claude/skills/ keep working). Tolerates
 * symlink failures with a warning -- the Matrix router path still works even
 * if the SDK-native path loses visibility on that specific skill.
 */
export function ensureSdkSkillsMirror(homePath: string): void {
  const canonical = join(homePath, ".agents", "skills");
  if (!existsSync(canonical)) return;

  let entries: string[];
  try {
    entries = readdirSync(canonical);
  } catch (err: unknown) {
    warnSkillFallback(`Could not scan canonical skills ${canonical}`, err);
    return;
  }

  const claudeSkillsDir = join(homePath, ".claude", "skills");
  if (!existsSync(claudeSkillsDir)) {
    try {
      mkdirSync(claudeSkillsDir, { recursive: true });
    } catch (err) {
      console.warn(
        `[skills] Could not create ${claudeSkillsDir}: ${(err as Error).message}`,
      );
      return;
    }
  }

  const canonicalReal = tryRealpath(canonical);

  for (const entry of entries) {
    const source = join(canonical, entry);
    let srcStat;
    try {
      srcStat = lstatSync(source);
    } catch (err: unknown) {
      warnSkillFallback(`Could not inspect ${source}`, err);
      continue;
    }
    if (!srcStat.isDirectory()) continue;
    if (!existsSync(join(source, "SKILL.md"))) continue;

    const target = join(claudeSkillsDir, entry);

    if (existsSync(target)) {
      let targetStat;
      try {
        targetStat = lstatSync(target);
      } catch (err: unknown) {
        warnSkillFallback(`Could not inspect ${target}`, err);
        continue;
      }
      if (!targetStat.isSymbolicLink()) {
        console.info(
          `[skills] ${target} already exists and is not a symlink; leaving untouched`,
        );
        continue;
      }
      // Already a symlink -- verify it points into the canonical tree.
      const targetReal = tryRealpath(target);
      if (targetReal && canonicalReal && targetReal.startsWith(canonicalReal)) {
        continue; // already correct
      }
      // Points elsewhere: rewrite.
      try {
        unlinkSync(target);
      } catch (err) {
        console.warn(
          `[skills] Could not refresh symlink ${target}: ${(err as Error).message}`,
        );
        continue;
      }
    }

    const linkTarget = relative(claudeSkillsDir, source);
    try {
      symlinkSync(linkTarget, target, "dir");
    } catch (err) {
      console.warn(
        `[skills] Could not symlink ${target} -> ${linkTarget}: ${(err as Error).message}`,
      );
    }
  }
}

export function cacheKnowledgeFiles(homePath: string): void {
  const knowledgeDir = join(homePath, "agents", "knowledge");
  if (!existsSync(knowledgeDir)) return;

  let files: string[];
  try {
    files = readdirSync(knowledgeDir).filter((f) => f.endsWith(".md"));
  } catch (err: unknown) {
    warnSkillFallback(`Could not scan knowledge directory ${knowledgeDir}`, err);
    return;
  }

  for (const file of files) {
    const name = basename(file, ".md");
    const content = readFileSync(join(knowledgeDir, file), "utf-8");
    knowledgeCache.set(name, content);
  }
}

export function getKnowledge(name: string): string | null {
  return knowledgeCache.get(name) ?? null;
}

export function loadComposableSkills(
  homePath: string,
  skillName: string,
  skills: SkillDefinition[],
): { bodies: string[] } {
  const loaded = new Set<string>();
  const bodies: string[] = [];

  function load(name: string): void {
    if (loaded.has(name)) return;
    loaded.add(name);

    const body = loadSkillBody(homePath, name);
    if (!body) return;

    bodies.push(body);

    const skill = skills.find((s) => s.name === name);
    if (skill?.composable_with) {
      for (const companion of skill.composable_with) {
        load(companion);
      }
    }
  }

  load(skillName);
  return { bodies };
}

export function buildSkillsToc(skills: SkillDefinition[]): string {
  if (skills.length === 0) return "";

  const lines = skills.map(
    (s) => `- **${s.name}**: ${s.description} (triggers: ${s.triggers.join(", ")})`,
  );

  return lines.join("\n");
}
