import { join } from "node:path";

export type SkillSource = {
  readonly label: string;
  readonly dir: string;
  readonly kind: "directory-scan" | "flat-scan";
};

/** Canonical discovery order shared by the kernel, Plugins and Chat recipes. */
export function skillSources(homePath: string): SkillSource[] {
  return [
    { label: ".agents/skills", dir: join(homePath, ".agents", "skills"), kind: "directory-scan" },
    { label: ".claude/skills", dir: join(homePath, ".claude", "skills"), kind: "directory-scan" },
    { label: "agents/skills", dir: join(homePath, "agents", "skills"), kind: "flat-scan" },
  ];
}
