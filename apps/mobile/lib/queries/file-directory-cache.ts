import type { FileEntry, FileListResponse } from "@/lib/requests";

export function appendCreatedFileEntry(
  current: FileListResponse,
  name: string,
  type: FileEntry["type"],
): FileListResponse {
  if (current.entries.some((entry) => entry.name === name)) return current;
  return {
    ...current,
    entries: [...current.entries, { name, type, gitStatus: null }],
  };
}
