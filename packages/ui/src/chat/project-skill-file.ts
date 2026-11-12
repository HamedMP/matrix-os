import { PROJECT_SKILL_FILE_MAX_BYTES } from "@matrix-os/contracts";
import {
  PROJECT_AGENT_SKILL_NAME_ERROR,
  type ProjectAgentConfigurationTemplate,
} from "./project-agent-context.js";

export type ProjectSkillDraft = ProjectAgentConfigurationTemplate | { error: string };

export const PROJECT_SKILL_DESCRIPTION_LIMIT = 1024;
export const PROJECT_SKILL_SIZE_ERROR = "The skill file must be 64 KB or smaller.";
export const PROJECT_SKILL_IMPORT_ERROR = "Choose a UTF-8 Markdown file with a name, description, and instructions.";
export const PROJECT_SKILL_COPY_ERROR = "The installed skill could not be read. Reopen the picker and try again.";

function skillPath(name: string): string | null {
  const slug = name.trim();
  return slug.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ? `.agents/skills/${slug}/SKILL.md` : null;
}

export function newProjectSkill(name: string, description: string, instructions: string): ProjectSkillDraft {
  const path = skillPath(name);
  if (!path) return { error: PROJECT_AGENT_SKILL_NAME_ERROR };
  if (!description.trim() || !instructions.trim()) return { error: "Enter a description and instructions for the skill." };

  const header = `---\nname: ${JSON.stringify(name.trim())}\ndescription: ${JSON.stringify(description.trim())}\n---\n\n`;
  const content = `${header}${instructions}${instructions.endsWith("\n") ? "" : "\n"}`;
  if (new TextEncoder().encode(content).byteLength > PROJECT_SKILL_FILE_MAX_BYTES) return { error: PROJECT_SKILL_SIZE_ERROR };
  return { path, content };
}

async function existingProjectSkill(content: string, installedName?: string): Promise<ProjectSkillDraft> {
  if (new TextEncoder().encode(content).byteLength > PROJECT_SKILL_FILE_MAX_BYTES) {
    return { error: PROJECT_SKILL_SIZE_ERROR };
  }
  if (content.startsWith("\uFEFF")) {
    return { error: "Save SKILL.md as UTF-8 without a byte-order mark and try again." };
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(content);
  if (!match || !match[2]?.trim() || content.includes("\0")) return { error: PROJECT_SKILL_IMPORT_ERROR };

  const { isScalar, parseDocument } = await import("yaml");
  const metadata = parseDocument(match[1] ?? "", { logLevel: "silent" });
  const name = metadata.get("name");
  const description = metadata.get("description");
  if (metadata.errors.length || typeof name !== "string" || typeof description !== "string" || !description.trim()) {
    return { error: PROJECT_SKILL_IMPORT_ERROR };
  }
  if (installedName !== undefined && name !== installedName) {
    // Older catalog parsing preserves the quotes around YAML scalars.
    const reported = parseDocument(installedName, { logLevel: "silent" });
    if (reported.errors.length || !isScalar(reported.contents) || reported.contents.value !== name) {
      return { error: PROJECT_SKILL_COPY_ERROR };
    }
  }

  // Legacy installed skills can have display names. Preserve the manifest and use a safe project directory.
  const destination = installedName === undefined ? name : name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const path = skillPath(destination);
  return path ? { path, content } : { error: PROJECT_AGENT_SKILL_NAME_ERROR };
}

export function copyProjectSkill(content: string, installedName: string): Promise<ProjectSkillDraft> {
  return existingProjectSkill(content, installedName);
}

export async function importProjectSkill(file: File): Promise<ProjectSkillDraft> {
  if (file.size > PROJECT_SKILL_FILE_MAX_BYTES) return { error: PROJECT_SKILL_SIZE_ERROR };
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
  } catch (error: unknown) {
    console.warn("[project-context] Could not read the imported skill:", error instanceof Error ? error.name : "UnknownError");
    return { error: PROJECT_SKILL_IMPORT_ERROR };
  }
  return existingProjectSkill(content);
}
