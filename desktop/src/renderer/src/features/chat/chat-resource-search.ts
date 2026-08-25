import {
  FileBrowseResponseSchema,
  FileSearchResponseSchema,
  type CanonicalChatResourceReference,
} from "@matrix-os/contracts";
import type { ApiClient } from "../../lib/api";

const MAX_RESULTS = 30;

export async function searchHomeChatResources(
  api: Pick<ApiClient, "get">,
  query: string,
): Promise<CanonicalChatResourceReference[]> {
  if (!query.trim()) return [];
  const response = await api.get<{ results?: unknown; entries?: unknown }>(
    `/api/files/search?q=${encodeURIComponent(query.trim())}&limit=${MAX_RESULTS}`,
  );
  const items = Array.isArray(response.results)
    ? response.results
    : Array.isArray(response.entries) ? response.entries : [];
  return items.slice(0, MAX_RESULTS).flatMap((item) => {
    const path = typeof item === "string"
      ? item
      : item && typeof item === "object" && typeof (item as { path?: unknown }).path === "string"
        ? (item as { path: string }).path
        : null;
    if (!path) return [];
    const kind = item && typeof item === "object" && (item as { kind?: unknown }).kind === "directory"
      ? "folder" as const
      : "file" as const;
    return [{ kind, id: path, label: path }];
  });
}

export async function searchProjectChatResources(
  api: Pick<ApiClient, "get">,
  projectId: string,
  query: string,
): Promise<CanonicalChatResourceReference[]> {
  const path = query.trim()
    ? `/api/coding-agents/files/search?projectId=${encodeURIComponent(projectId)}&query=${encodeURIComponent(query.trim())}&limit=${MAX_RESULTS}`
    : `/api/coding-agents/files/browse?projectId=${encodeURIComponent(projectId)}&limit=${MAX_RESULTS}`;
  const response = await api.get<unknown>(path);
  const files = query.trim()
    ? FileSearchResponseSchema.parse(response).matches.items
    : FileBrowseResponseSchema.parse(response).entries.items;
  return files.map((file) => ({
    kind: file.kind === "directory" ? "folder" as const : "file" as const,
    id: file.path,
    label: file.path,
  }));
}
