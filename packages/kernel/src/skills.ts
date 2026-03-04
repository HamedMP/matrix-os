import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
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

export interface SkillDefinition {
  name: string;
  description: string;
  triggers: string[];
  fileName: string;
  category: string;
  tools_needed: string[];
  channel_hints: string[];
  examples: string[];
  composable_with: string[];
}

const skillBodyCache = new Map<string, string>();
const knowledgeCache = new Map<string, string>();

export function clearSkillCache(): void {
  skillBodyCache.clear();
}

export function clearKnowledgeCache(): void {
  knowledgeCache.clear();
}

export function loadSkills(homePath: string): SkillDefinition[] {
  const skillsDir = join(homePath, "agents", "skills");
  if (!existsSync(skillsDir)) return [];

  let files: string[];
  try {
    files = readdirSync(skillsDir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }

  const skills: SkillDefinition[] = [];

  for (const file of files) {
    const content = readFileSync(join(skillsDir, file), "utf-8");
    const { frontmatter, body } = parseFrontmatter(content);

    const result = SkillFrontmatterSchema.safeParse(frontmatter);
    if (!result.success) {
      console.warn(
        `[skills] Skipping ${file}: invalid frontmatter -- ${result.error.issues.map((i) => i.message).join(", ")}`,
      );
      continue;
    }

    const meta = result.data;

    skillBodyCache.set(meta.name, body.trim() || content);

    skills.push({
      name: meta.name,
      description: meta.description,
      triggers: meta.triggers,
      fileName: file,
      category: meta.category,
      tools_needed: meta.tools_needed,
      channel_hints: meta.channel_hints,
      examples: meta.examples,
      composable_with: meta.composable_with,
    });
  }

  return skills;
}

export function loadSkillBody(
  homePath: string,
  skillName: string,
): string | null {
  const cached = skillBodyCache.get(skillName);
  if (cached !== undefined) return cached;

  const skillsDir = join(homePath, "agents", "skills");
  if (!existsSync(skillsDir)) return null;

  let files: string[];
  try {
    files = readdirSync(skillsDir).filter((f) => f.endsWith(".md"));
  } catch {
    return null;
  }

  for (const file of files) {
    const content = readFileSync(join(skillsDir, file), "utf-8");
    const { frontmatter, body } = parseFrontmatter(content);
    if (frontmatter.name === skillName) {
      const value = body.trim() || content;
      skillBodyCache.set(skillName, value);
      return value;
    }
  }

  return null;
}

export function cacheKnowledgeFiles(homePath: string): void {
  const knowledgeDir = join(homePath, "agents", "knowledge");
  if (!existsSync(knowledgeDir)) return;

  let files: string[];
  try {
    files = readdirSync(knowledgeDir).filter((f) => f.endsWith(".md"));
  } catch {
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
