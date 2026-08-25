import {
  FileBrowseResponseSchema,
  FileSearchResponseSchema,
  CanonicalChatResourceReferenceSchema,
  type CanonicalChatResourceReference,
} from "@matrix-os/contracts";
import type { ApiClient } from "../../lib/api";

const MAX_RESULTS = 30;

function stablePathHash(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193) >>> 0;
    right = Math.imul(right ^ code, 0x85ebca6b) >>> 0;
  }
  return `${left.toString(16).padStart(8, "0")}${right.toString(16).padStart(8, "0")}`;
}

export function canonicalResourceReferenceForPath(
  kind: "file" | "folder",
  path: string,
): CanonicalChatResourceReference {
  const direct = CanonicalChatResourceReferenceSchema.safeParse({ kind, id: path, label: path });
  if (direct.success) return direct.data;
  return CanonicalChatResourceReferenceSchema.parse({
    kind,
    id: `${kind}_${stablePathHash(path)}`,
    label: path,
  });
}

export async function searchHomeChatResources(
  api: Pick<ApiClient, "get">,
  query: string,
): Promise<CanonicalChatResourceReference[]> {
  if (!query.trim()) {
    const response = await api.get<{ entries?: unknown }>("/api/files/list?path=");
    const entries = Array.isArray(response.entries) ? response.entries : [];
    return entries.slice(0, MAX_RESULTS).flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const { name, type } = entry as { name?: unknown; type?: unknown };
      if (typeof name !== "string" || (type !== "file" && type !== "directory")) return [];
      return [canonicalResourceReferenceForPath(type === "directory" ? "folder" : "file", name)];
    });
  }
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
    const itemType = item && typeof item === "object"
      ? (item as { kind?: unknown; type?: unknown }).kind
        ?? (item as { type?: unknown }).type
      : undefined;
    const kind = itemType === "directory"
      ? "folder" as const
      : "file" as const;
    return [canonicalResourceReferenceForPath(kind, path)];
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
  return files.map((file) => canonicalResourceReferenceForPath(
    file.kind === "directory" ? "folder" : "file",
    file.path,
  ));
}

export async function searchGlobalChatResources(
  api: Pick<ApiClient, "get">,
  projectId: string | null,
  query: string,
): Promise<CanonicalChatResourceReference[]> {
  if (projectId) {
    const [projectResult] = await Promise.allSettled([
      searchProjectChatResources(api, projectId, query),
    ]);
    if (projectResult?.status === "fulfilled" && projectResult.value.length > 0) {
      return projectResult.value;
    }
  }
  return searchHomeChatResources(api, query);
}
