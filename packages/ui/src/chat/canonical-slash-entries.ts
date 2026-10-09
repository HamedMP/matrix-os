import type { CanonicalProviderInstanceDescriptor } from "@matrix-os/contracts";

export interface CanonicalSlashEntry {
  id: string;
  kind: "skill" | "command";
  displayName: string;
  description: string;
  invocation: string;
}

/** The selected instance is the authority. Installed Skills from other instances
 * or owner settings are not a fallback for an isolated route. */
export function listCanonicalSlashEntries(instance: CanonicalProviderInstanceDescriptor | undefined): CanonicalSlashEntry[] {
  return instance ? [
    ...instance.skills.map(entry => ({...entry,kind:"skill" as const})),
    ...instance.commands.map(entry => ({...entry,kind:"command" as const})),
  ] : [];
}

export function matchChatSlashToken(value: string, cursor = value.length): {token:string;query:string;start:number;end:number} | null {
  const end = Math.min(value.length, Math.max(0, cursor));
  const match = value.slice(0,end).match(/(?:^|\s)(\/[a-z0-9_-]*)$/i);
  const token = match?.[1];
  return token ? {token,query:token.slice(1).toLocaleLowerCase(),start:end-token.length,end} : null;
}

export function filterCanonicalSlashEntries(entries: readonly CanonicalSlashEntry[], query: string): CanonicalSlashEntry[] {
  return entries.filter(entry => entry.invocation.slice(1).toLocaleLowerCase().includes(query)
    || entry.displayName.toLocaleLowerCase().includes(query));
}

export function chatSlashStatusMessage({loading,instance,entryCount}: {
  loading: boolean; instance?: CanonicalProviderInstanceDescriptor; entryCount: number;
}): string {
  if (loading) return "Loading skills and commands…";
  if (!instance) return "Skills and commands are unavailable in this Chat.";
  return entryCount === 0 ? "No skills or commands are available for this model." : "No matching skills or commands.";
}
