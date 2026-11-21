import { FileBrowseResponseSchema, FileSearchResponseSchema } from "@matrix-os/contracts";

export type WorktreeFileScope = { projectId: string; worktreeId: string };
export type WorktreeFileEntry = { name: string; type: "file" | "directory" };
const MAX_DIRECTORY_PAGES = 100;

function queryFor(scope: WorktreeFileScope, path: string) {
  const query = new URLSearchParams({ ...scope, limit: "100" });
  // An absent path means checkout root; the Gateway rejects empty paths.
  if (path) query.set("path", path);
  return query;
}

/** Match the native inspector's 10,000-entry bound and one timeout per directory. */
export async function loadWorktreeFileEntries(gatewayUrl: string, scope: WorktreeFileScope, path: string, signal: AbortSignal): Promise<WorktreeFileEntry[]> {
  const query = queryFor(scope, path);
  const budget = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  const entries: WorktreeFileEntry[] = [];
  const cursors: string[] = []; // At most MAX_DIRECTORY_PAGES, discarded after each load.
  for (let page = 0; page < MAX_DIRECTORY_PAGES; page++) {
    const response = await fetch(`${gatewayUrl}/api/coding-agents/files/browse?${query}`, {
      signal: AbortSignal.any([budget, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) throw new Error("WorktreeFilesUnavailable");
    const value = FileBrowseResponseSchema.parse(await response.json());
    for (const entry of value.entries.items) {
      if (entry.kind !== "file" && entry.kind !== "directory") continue;
      const prefix = path ? `${path}/` : "";
      if (!entry.path?.startsWith(prefix)) throw new Error("InvalidWorktreeEntry");
      const name = entry.path.slice(prefix.length);
      if (!name || name.includes("/")) throw new Error("InvalidWorktreeEntry");
      entries.push({ name, type: entry.kind });
    }
    if (!value.entries.hasMore) return entries;
    const cursor = value.entries.nextCursor;
    if (!cursor || cursors.includes(cursor)) throw new Error("InvalidWorktreeCursor");
    cursors.push(cursor);
    query.set("cursor", cursor);
  }
  throw new Error("WorktreeDirectoryLimitExceeded");
}

export async function searchWorktreeFiles(gatewayUrl: string, scope: WorktreeFileScope, path: string, query: string, signal: AbortSignal) {
  const params = queryFor(scope, path);
  params.set("query", query);
  const response = await fetch(`${gatewayUrl}/api/coding-agents/files/search?${params}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (!response.ok) throw new Error("WorktreeSearchUnavailable");
  const value = FileSearchResponseSchema.parse(await response.json());
  return { results: value.matches.items.filter(entry => entry.kind === "file").map(entry => ({
    path: entry.path, name: entry.path.split("/").at(-1)!, type: "file" as const,
  })), truncated: value.matches.hasMore };
}
