import type { AgentAttachment } from "@matrix-os/contracts";
import type { ApiClient } from "../../../lib/api";

export const MAX_ATTACHMENT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS = 8;
const MAX_SUBSCRIBERS = 16;
const MAX_CONCURRENT_UPLOADS = 3;
const UPLOAD_TIMEOUT_MS = 30_000;
const SAFE_FILE_NAME = /^[^/\\\u0000-\u001f\u007f]+$/;
const SAFE_RASTER_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export interface LocalConversationAttachment {
  localId: string;
  uploadId: string;
  uploadPath: string;
  file: File;
  previewUrl?: string;
  status: "ready" | "uploading" | "failed";
  error?: string;
  uploadedPath?: string;
}

export type UploadedConversationAttachments = {
  ok: true;
  paths: string[];
  attachments: AgentAttachment[];
};

export interface LocalAttachmentController {
  getSnapshot(): readonly LocalConversationAttachment[];
  subscribe(listener: () => void): () => void;
  add(files: readonly File[]): void;
  remove(localId: string): void;
  retry(localId: string): Promise<void>;
  uploadAll(): Promise<UploadedConversationAttachments | { ok: false }>;
  clear(): void;
  dispose(): void;
}

type InternalAttachment = LocalConversationAttachment;

function defaultId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

function shouldPreview(file: File): boolean {
  return SAFE_RASTER_TYPES.has(file.type);
}

function validFile(file: File): boolean {
  return file.name.length > 0
    && file.name.length <= 255
    && file.name !== "."
    && file.name !== ".."
    && SAFE_FILE_NAME.test(file.name)
    && !(file.name === ".." || file.name.includes("/"))
    && !("webkitRelativePath" in file && file.webkitRelativePath.length > 0);
}

function attachmentReference(item: InternalAttachment): AgentAttachment | null {
  if (!item.uploadedPath) return null;
  return {
    id: `desktop_upload_${item.uploadId}`,
    kind: shouldPreview(item.file) ? "image" : "file",
    label: item.file.name,
    path: item.uploadedPath,
    ...(item.file.type ? { mimeType: item.file.type } : {}),
    sizeBytes: item.file.size,
  };
}

export function appendHermesAttachmentPaths(prompt: string, paths: readonly string[]): string {
  if (paths.length === 0) return prompt.trim();
  const body = prompt.trim() || "Please inspect the attached files.";
  const references = paths.map((path) => `- ~/${path} (/home/matrix/home/${path})`).join("\n");
  return `${body}\n\nAttached files (available on your Matrix computer):\n${references}`;
}

export function createLocalAttachmentController(options: {
  api: ApiClient | null;
  createId?: () => string;
}): LocalAttachmentController {
  let items: InternalAttachment[] = [];
  let snapshot: readonly LocalConversationAttachment[] = [];
  let disposed = false;
  let uploadInFlight = false;
  const listeners = new Set<() => void>();

  const emit = () => {
    snapshot = items.map((item) => ({ ...item }));
    for (const listener of listeners) listener();
  };

  const revoke = (item: InternalAttachment) => {
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  };

  const uploadOne = async (item: InternalAttachment): Promise<boolean> => {
    if (disposed || !options.api || item.file.size > MAX_ATTACHMENT_FILE_BYTES) return false;
    if (item.uploadedPath) return true;
    item.status = "uploading";
    item.error = undefined;
    emit();
    try {
      const response = await options.api.putBytes<{ ok?: boolean; path?: unknown; size?: unknown }>(
        `/api/files/blob?path=${encodeURIComponent(item.uploadPath)}`,
        item.file,
        { "content-type": item.file.type || "application/octet-stream" },
        { timeoutMs: UPLOAD_TIMEOUT_MS },
      );
      if (response.path !== item.uploadPath || typeof response.size !== "number") {
        throw new Error("invalid upload response");
      }
      if (disposed || !items.includes(item)) return false;
      item.uploadedPath = response.path;
      item.status = "ready";
      emit();
      return true;
    } catch (err: unknown) {
      console.warn("[desktop attachments] upload failed:", err instanceof Error ? err.message : String(err));
      if (!disposed && items.includes(item)) {
        item.status = "failed";
        item.error = "Upload failed. Try again.";
        emit();
      }
      return false;
    }
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (listeners.size >= MAX_SUBSCRIBERS) throw new Error("attachment subscribers unavailable");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    add(files) {
      if (disposed || uploadInFlight) return;
      for (const file of files) {
        if (items.length >= MAX_ATTACHMENTS) break;
        if (!validFile(file)) continue;
        const uploadId = (options.createId ?? defaultId)().replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 96);
        if (!uploadId || uploadId.includes("..")) continue;
        items.push({
          localId: `local_${uploadId}`,
          uploadId,
          uploadPath: `temporary/desktop-chat/${uploadId}-${file.name}`,
          file,
          ...(shouldPreview(file) ? { previewUrl: URL.createObjectURL(file) } : {}),
          status: file.size <= MAX_ATTACHMENT_FILE_BYTES ? "ready" : "failed",
          ...(file.size > MAX_ATTACHMENT_FILE_BYTES ? { error: "Files are limited to 10 MB." } : {}),
        });
      }
      emit();
    },
    remove(localId) {
      if (uploadInFlight) return;
      const item = items.find((candidate) => candidate.localId === localId);
      if (!item) return;
      items = items.filter((candidate) => candidate !== item);
      revoke(item);
      emit();
    },
    async retry(localId) {
      if (uploadInFlight) return;
      const item = items.find((candidate) => candidate.localId === localId);
      if (!item || item.status !== "failed" || item.file.size > MAX_ATTACHMENT_FILE_BYTES) return;
      await uploadOne(item);
    },
    async uploadAll() {
      if (uploadInFlight) return { ok: false };
      uploadInFlight = true;
      const batch = [...items];
      try {
        const pending = batch.filter((item) => !item.uploadedPath && item.status !== "failed");
        let cursor = 0;
        const worker = async () => {
          while (cursor < pending.length) {
            const index = cursor++;
            await uploadOne(pending[index]!);
          }
        };
        await Promise.all(Array.from(
          { length: Math.min(MAX_CONCURRENT_UPLOADS, pending.length) },
          () => worker(),
        ));
        const batchStillCurrent = items.length === batch.length
          && batch.every((item, index) => items[index] === item);
        if (disposed || !batchStillCurrent || batch.some((item) => !item.uploadedPath)) return { ok: false };
        const attachments = batch.map(attachmentReference);
        if (attachments.some((attachment) => !attachment)) return { ok: false };
        return {
          ok: true,
          paths: batch.map((item) => item.uploadedPath!),
          attachments: attachments as AgentAttachment[],
        };
      } finally {
        uploadInFlight = false;
      }
    },
    clear() {
      if (uploadInFlight) return;
      for (const item of items) revoke(item);
      items = [];
      emit();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const item of items) revoke(item);
      items = [];
      snapshot = [];
      listeners.clear();
    },
  };
}
