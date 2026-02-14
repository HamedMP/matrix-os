import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "./agents.js";

export interface SkillDefinition {
  name: string;
  description: string;
  triggers: string[];
  fileName: string;
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
    const { frontmatter } = parseFrontmatter(content);

    if (!frontmatter.name || !frontmatter.description) continue;

    skills.push({
      name: frontmatter.name as string,
      description: frontmatter.description as string,
      triggers: (frontmatter.triggers as string[]) ?? [],
      fileName: file,
    });
  }

  return skills;
}

export function loadSkillBody(
  homePath: string,
  skillName: string,
): string | null {
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
      return body.trim() || content;
    }
  }

  return null;
}

export function buildSkillsToc(skills: SkillDefinition[]): string {
  if (skills.length === 0) return "";

  const lines = skills.map(
    (s) => `- **${s.name}**: ${s.description} (triggers: ${s.triggers.join(", ")})`,
  );

  return lines.join("\n");
}
