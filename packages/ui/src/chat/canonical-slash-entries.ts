import type { CanonicalProviderInstanceDescriptor, ProjectAgentContext } from "@matrix-os/contracts";

interface SlashEntry {
  id: string;
  displayName: string;
  description: string;
  invocation: string;
}

export type CanonicalSlashEntry = SlashEntry & (
  | { kind: "skill" | "command" }
  | { kind: "project_skill"; path: string }
);

export interface ProjectChatSkillCatalog {
  skills: ProjectAgentContext["skills"];
  available: boolean;
}

/** Project chats show project manifests and runtime commands, without a fallback
 * to installed skills from the computer or another project. */
export function listCanonicalSlashEntries(
  instance: CanonicalProviderInstanceDescriptor | undefined,
  projectSkills?: ProjectChatSkillCatalog,
): CanonicalSlashEntry[] {
  const skills = projectSkills
    ? projectSkills.skills.map(({ source, name }) => {
      const path = `${source}/${name}/SKILL.md`;
      return { id: path, path, kind: "project_skill" as const, displayName: name, description: path, invocation: `/${name}` };
    })
    : instance?.skills.map(entry => ({ ...entry, kind: "skill" as const })) ?? [];
  return [...skills, ...(instance?.commands.map(entry => ({ ...entry, kind: "command" as const })) ?? [])];
}

export function matchChatSlashToken(value: string, cursor = value.length): {token:string;query:string;start:number;end:number} | null {
  const end = Math.min(value.length, Math.max(0, cursor));
  const match = value.slice(0,end).match(/(?:^|\s)(\/[a-z0-9_.-]*)$/i);
  const token = match?.[1];
  return token ? {token,query:token.slice(1).toLocaleLowerCase(),start:end-token.length,end} : null;
}

export function filterCanonicalSlashEntries(entries: readonly CanonicalSlashEntry[], query: string): CanonicalSlashEntry[] {
  return entries.filter(entry => entry.invocation.slice(1).toLocaleLowerCase().includes(query)
    || entry.displayName.toLocaleLowerCase().includes(query));
}

export function chatSlashStatusMessage({loading,instance,entryCount,projectSkills}: {
  loading: boolean; instance?: CanonicalProviderInstanceDescriptor; entryCount: number; projectSkills?: ProjectChatSkillCatalog;
}): string {
  if (loading) return projectSkills ? "Loading project skills and commands…" : "Loading skills and commands…";
  if (projectSkills) {
    if (!projectSkills.available) return "Project skills are unavailable in this Chat.";
    return entryCount === 0 ? "No project skills or commands found." : "No matching project skills or commands.";
  }
  if (!instance) return "Skills and commands are unavailable in this Chat.";
  return entryCount === 0 ? "No skills or commands are available for this model." : "No matching skills or commands.";
}
