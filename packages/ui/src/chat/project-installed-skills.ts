import { InstalledSkillManifestPathSchema } from "@matrix-os/contracts";
import type { ProjectInstalledSkill } from "./project-agent-context";

export { PROJECT_SKILL_FILE_MAX_BYTES } from "@matrix-os/contracts";
export const PROJECT_INSTALLED_SKILLS_PATH = "/api/settings/skills";
export const PROJECT_INSTALLED_SKILLS_RESPONSE_LIMIT = 256 * 1024;

export function projectInstalledSkillFilePath(file: string): string | null {
  return InstalledSkillManifestPathSchema.safeParse(file).success
    ? `${PROJECT_INSTALLED_SKILLS_PATH}/manifest?path=${encodeURIComponent(file)}`
    : null;
}

export function parseProjectInstalledSkills(raw: unknown): ProjectInstalledSkill[] {
  if (!Array.isArray(raw)) return [];
  const files = new Set<string>();
  return raw.slice(0, 200).flatMap((value: unknown) => {
    if (typeof value !== "object" || !value) return [];
    const { name, file, description, enabled } = value as Record<string, unknown>;
    if (enabled !== true || typeof name !== "string" || !name.trim() || name.length > 128
      || typeof file !== "string" || files.has(file) || !projectInstalledSkillFilePath(file)) return [];
    files.add(file);
    const summary = typeof description === "string" ? description.trim().slice(0, 512) : "";
    return [{ name, file, ...(summary ? { description: summary } : {}) }];
  });
}
