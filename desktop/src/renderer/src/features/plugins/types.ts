// Types and tolerant parsers for the Plugins hub data paths. Skills come from
// the gateway route GET /api/settings/skills
// (packages/gateway/src/routes/settings.ts) as
// [{ name, file, description?, enabled }]. The renderer only displays
// name/file/description — never skill file contents.

export const MAX_SKILLS = 200;

export interface SkillInfo {
  name: string;
  // Gateway-relative path of the SKILL.md (e.g. ".agents/skills/qmd/SKILL.md").
  file: string;
  description: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
}

export function parseSkills(value: unknown): SkillInfo[] {
  if (!Array.isArray(value)) return [];
  const out: SkillInfo[] = [];
  for (const raw of value.slice(0, MAX_SKILLS)) {
    const record = asRecord(raw);
    if (!record) continue;
    const name = asTrimmedString(record.name, 128);
    if (!name) continue;
    const file = asTrimmedString(record.file, 512) ?? "";
    const description = asTrimmedString(record.description, 512);
    out.push({ name, file, description });
  }
  return out;
}
