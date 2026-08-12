import type { ApiClient } from "../../lib/api";
import { AppError } from "../../lib/errors";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_QUEUE = 32;
const MAX_CONCURRENT = 3;
const MAX_SUBSCRIBERS = 16;
const UPLOAD_TIMEOUT_MS = 30_000;
const SAFE_FILE_NAME = /^[^/\\\u0000-\u001f\u007f]+$/;

export type FileUploadRow = {
  id: string;
  name: string;
  destination: string;
  status: "queued" | "uploading" | "failed";
  error?: string;
};

type PendingUpload = FileUploadRow & { file: File; scope: string };

function joinUploadPath(destination: string, fileName: string): string {
  return destination ? `${destination}/${fileName}` : fileName;
}

function validFileName(fileName: string): boolean {
  return fileName.length > 0
    && fileName.length <= 255
    && fileName !== "."
    && fileName !== ".."
    && SAFE_FILE_NAME.test(fileName);
}

function uploadErrorMessage(error: unknown): string {
  if (error instanceof AppError && error.detail === "file_exists") {
    return "A file with this name already exists.";
  }
  return "Upload failed. Try again.";
}

export function createFileUploadController(options: {
  api: ApiClient;
  getScope: () => string;
  onUploaded: (directory: string) => void;
}) {
  let pending: PendingUpload[] = [];
  let active = 0;
  let disposed = false;
  let sequence = 0;
  const listeners = new Set<(rows: FileUploadRow[]) => void>();

  const emit = () => {
    const rows = pending.map(({ file: _file, scope: _scope, ...row }) => row);
    for (const listener of listeners) listener(rows);
  };

  const pump = () => {
    if (disposed || active >= MAX_CONCURRENT) return;
    const availableSlots = MAX_CONCURRENT - active;
    const queued = pending.filter((candidate) => candidate.status === "queued").slice(0, availableSlots);
    for (const item of queued) {
      item.status = "uploading";
      active += 1;
      emit();
      const path = joinUploadPath(item.destination, item.file.name);
      void options.api.putBytes<{ path: string }>(
        `/api/files/blob?path=${encodeURIComponent(path)}`,
        item.file,
        { "content-type": item.file.type || "application/octet-stream" },
        { timeoutMs: UPLOAD_TIMEOUT_MS },
      ).then(() => {
        pending = pending.filter((candidate) => candidate.id !== item.id);
        if (!disposed && options.getScope() === item.scope) options.onUploaded(item.destination);
      }).catch((error: unknown) => {
        item.status = "failed";
        item.error = uploadErrorMessage(error);
      }).finally(() => {
        active -= 1;
        emit();
        pump();
      });
    }
  };

  return {
    subscribe(listener: (rows: FileUploadRow[]) => void) {
      if (listeners.size >= MAX_SUBSCRIBERS) throw new Error("upload subscribers unavailable");
      listeners.add(listener);
      emit();
      return () => listeners.delete(listener);
    },
    enqueue(files: readonly File[], destination: string) {
      if (disposed) return;
      const scope = options.getScope();
      for (const file of files) {
        if (pending.length >= MAX_QUEUE) break;
        if (!validFileName(file.name)) continue;
        sequence += 1;
        const tooLarge = file.size > MAX_FILE_BYTES;
        pending.push({
          id: `upload-${sequence}`,
          name: file.name,
          destination,
          status: tooLarge ? "failed" : "queued",
          ...(tooLarge ? { error: "Files are limited to 10 MB." } : {}),
          file,
          scope,
        });
      }
      emit();
      pump();
    },
    retry(id: string) {
      const item = pending.find((candidate) => candidate.id === id && candidate.status === "failed");
      if (!item || item.file.size > MAX_FILE_BYTES) return;
      item.status = "queued";
      item.error = undefined;
      emit();
      pump();
    },
    remove(id: string) {
      const next = pending.filter((candidate) => candidate.id !== id || candidate.status === "uploading");
      if (next.length === pending.length) return;
      pending = next;
      emit();
    },
    dispose() {
      disposed = true;
      pending = [];
      listeners.clear();
    },
  };
}
