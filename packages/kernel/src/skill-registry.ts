import { access, mkdir, readFile, writeFile } from "node:fs/promises";
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
  publish(skillName: string): Promise<SkillRegistryEntry>;
  install(skillName: string): Promise<{ installed: boolean; reason?: string }>;
  list(category?: string): Promise<SkillRegistryEntry[]>;
  get(name: string): Promise<SkillRegistryEntry | null>;
}

function registryPath(homePath: string): string {
  return join(homePath, "system", "skill-registry.json");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw err;
  }
}

async function loadRegistryData(homePath: string): Promise<RegistryData> {
  const path = registryPath(homePath);
  if (!(await pathExists(path))) return { skills: [] };
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch (err: unknown) {
    console.warn(
      "[skill-registry] Failed to load registry data:",
      err instanceof Error ? err.message : String(err),
    );
    return { skills: [] };
  }
}

async function saveRegistryData(homePath: string, data: RegistryData): Promise<void> {
  const dir = join(homePath, "system");
  await mkdir(dir, { recursive: true });
  await writeFile(registryPath(homePath), JSON.stringify(data, null, 2), "utf-8");
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
  let dataPromise: Promise<RegistryData> | null = null;

  async function getData(): Promise<RegistryData> {
    if (!dataPromise) {
      dataPromise = loadRegistryData(homePath);
    }
    return dataPromise;
  }

  return {
    async publish(skillName: string): Promise<SkillRegistryEntry> {
      const data = await getData();
      const skillsDir = join(homePath, "agents", "skills");
      const filePath = join(skillsDir, `${skillName}.md`);
      if (!(await pathExists(filePath))) {
        throw new Error(`Skill file not found: ${filePath}`);
      }

      const content = await readFile(filePath, "utf-8");
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

      await saveRegistryData(homePath, data);
      return entry;
    },

    async install(skillName: string): Promise<{ installed: boolean; reason?: string }> {
      const data = await getData();
      const entry = data.skills.find((s) => s.name === skillName);
      if (!entry) {
        return { installed: false, reason: "Skill not found in registry" };
      }

      const skillsDir = join(homePath, "agents", "skills");
      const targetPath = join(skillsDir, `${skillName}.md`);
      if (await pathExists(targetPath)) {
        return { installed: false, reason: "Skill already installed locally" };
      }

      await mkdir(skillsDir, { recursive: true });

      const registryContent = entry.description
        ? `---\nname: ${entry.name}\ndescription: ${entry.description}\ntriggers: []\ncategory: ${entry.category}\ntools_needed: []\nchannel_hints:\n  - any\nexamples: []\ncomposable_with: []\n---\n\n# ${entry.name}\n\nInstalled from skill registry v${entry.version}.\n`
        : `---\nname: ${entry.name}\ndescription: Skill from registry\ntriggers: []\ncategory: ${entry.category}\ntools_needed: []\nchannel_hints:\n  - any\nexamples: []\ncomposable_with: []\n---\n\n# ${entry.name}\n\nInstalled from skill registry v${entry.version}.\n`;

      await writeFile(targetPath, registryContent, "utf-8");

      entry.downloads += 1;
      await saveRegistryData(homePath, data);

      return { installed: true };
    },

    async list(category?: string): Promise<SkillRegistryEntry[]> {
      const data = await getData();
      if (category) {
        return data.skills.filter((s) => s.category === category);
      }
      return [...data.skills];
    },

    async get(name: string): Promise<SkillRegistryEntry | null> {
      const data = await getData();
      return data.skills.find((s) => s.name === name) ?? null;
    },
  };
}
