import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseFrontmatter } from "./agents.js";

export interface SkillRegistryEntry {
  name: string;
  description: string;
  version: string;
  author: string;
  category: string;
  contentHash: string;
  publishedAt: string;
  downloads: number;
}

interface RegistryData {
  skills: SkillRegistryEntry[];
}

export interface SkillRegistry {
  publish(skillName: string): SkillRegistryEntry;
  install(skillName: string): { installed: boolean; reason?: string };
  list(category?: string): SkillRegistryEntry[];
  get(name: string): SkillRegistryEntry | null;
}

function registryPath(homePath: string): string {
  return join(homePath, "system", "skill-registry.json");
}

function loadRegistryData(homePath: string): RegistryData {
  const path = registryPath(homePath);
  if (!existsSync(path)) return { skills: [] };
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { skills: [] };
  }
}

function saveRegistryData(homePath: string, data: RegistryData): void {
  const dir = join(homePath, "system");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(registryPath(homePath), JSON.stringify(data, null, 2), "utf-8");
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function bumpPatch(version: string): string {
  const parts = version.split(".");
  if (parts.length !== 3) return "1.0.1";
  const patch = parseInt(parts[2], 10);
  return `${parts[0]}.${parts[1]}.${patch + 1}`;
}

export function createSkillRegistry(homePath: string): SkillRegistry {
  let data = loadRegistryData(homePath);

  return {
    publish(skillName: string): SkillRegistryEntry {
      const skillsDir = join(homePath, "agents", "skills");
      const filePath = join(skillsDir, `${skillName}.md`);
      if (!existsSync(filePath)) {
        throw new Error(`Skill file not found: ${filePath}`);
      }

      const content = readFileSync(filePath, "utf-8");
      const { frontmatter } = parseFrontmatter(content);
      const contentHash = hashContent(content);

      const existing = data.skills.find((s) => s.name === skillName);

      const entry: SkillRegistryEntry = {
        name: frontmatter.name ?? skillName,
        description: frontmatter.description ?? "",
        version: existing ? bumpPatch(existing.version) : "1.0.0",
        author: typeof frontmatter.author === "string" ? frontmatter.author : "local",
        category: typeof frontmatter.category === "string" ? frontmatter.category : "utility",
        contentHash,
        publishedAt: new Date().toISOString(),
        downloads: existing?.downloads ?? 0,
      };

      if (existing) {
        const idx = data.skills.indexOf(existing);
        data.skills[idx] = entry;
      } else {
        data.skills.push(entry);
      }

      saveRegistryData(homePath, data);
      return entry;
    },

    install(skillName: string): { installed: boolean; reason?: string } {
      const entry = data.skills.find((s) => s.name === skillName);
      if (!entry) {
        return { installed: false, reason: "Skill not found in registry" };
      }

      const skillsDir = join(homePath, "agents", "skills");
      const targetPath = join(skillsDir, `${skillName}.md`);
      if (existsSync(targetPath)) {
        return { installed: false, reason: "Skill already installed locally" };
      }

      if (!existsSync(skillsDir)) {
        mkdirSync(skillsDir, { recursive: true });
      }

      const registryContent = entry.description
        ? `---\nname: ${entry.name}\ndescription: ${entry.description}\ntriggers: []\ncategory: ${entry.category}\ntools_needed: []\nchannel_hints:\n  - any\nexamples: []\ncomposable_with: []\n---\n\n# ${entry.name}\n\nInstalled from skill registry v${entry.version}.\n`
        : `---\nname: ${entry.name}\ndescription: Skill from registry\ntriggers: []\ncategory: ${entry.category}\ntools_needed: []\nchannel_hints:\n  - any\nexamples: []\ncomposable_with: []\n---\n\n# ${entry.name}\n\nInstalled from skill registry v${entry.version}.\n`;

      writeFileSync(targetPath, registryContent, "utf-8");

      entry.downloads += 1;
      saveRegistryData(homePath, data);

      return { installed: true };
    },

    list(category?: string): SkillRegistryEntry[] {
      if (category) {
        return data.skills.filter((s) => s.category === category);
      }
      return [...data.skills];
    },

    get(name: string): SkillRegistryEntry | null {
      return data.skills.find((s) => s.name === name) ?? null;
    },
  };
}
