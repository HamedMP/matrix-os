export const DEFAULT_DENY_LIST: readonly string[] = [
  "spawn_agent",
  "manage_cron",
  "sync_files",
] as const;

export function isToolDenied(
  toolName: string,
  userDenyList: string[] = [],
  userAllowList: string[] = [],
): boolean {
  if (DEFAULT_DENY_LIST.includes(toolName)) return true;
  if (userDenyList.includes(toolName)) return true;
  return false;
}
