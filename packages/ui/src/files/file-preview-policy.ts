import { FileResourceRefSchema, type FileResourceRef } from "@matrix-os/contracts";

function filePreviewUrl(
  endpoint: "metadata" | "content",
  rawResource: FileResourceRef,
  options: { download?: boolean } = {},
): string {
  const resource = FileResourceRefSchema.parse(rawResource);
  const query = new URLSearchParams({ kind: resource.kind });
  if (resource.kind === "home") {
    query.set("path", resource.path);
  } else if (resource.kind === "project") {
    query.set("projectId", resource.projectId);
    if (resource.worktreeId) query.set("worktreeId", resource.worktreeId);
    query.set("path", resource.path);
  } else {
    query.set("chatId", resource.chatId);
    query.set("artifactId", resource.artifactId);
  }
  if (endpoint === "content" && options.download) query.set("download", "true");
  return `/api/file-previews/${endpoint}?${query.toString()}`;
}

export function filePreviewMetadataUrl(resource: FileResourceRef): string {
  return filePreviewUrl("metadata", resource);
}

export function filePreviewContentUrl(
  resource: FileResourceRef,
  options?: { download?: boolean },
): string {
  return filePreviewUrl("content", resource, options);
}
