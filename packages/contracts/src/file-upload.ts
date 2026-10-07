/** Shared selected-file rules for Native Mobile, Web views and Electron Desktop. */
export const MAX_SELECTED_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_SELECTED_UPLOAD_QUEUE = 32;
export const SELECTED_UPLOAD_TIMEOUT_MS = 30_000;
const MAX_CONCURRENT = 3;
const MAX_SUBSCRIBERS = 16;

export function isSafeUploadName(value: string): boolean {
  return value.length > 0 && value.length <= 255 && value === value.trim()
    && value !== "." && value !== ".." && !/[/\\\u0000-\u001f\u007f]/u.test(value)
    && new TextEncoder().encode(value).byteLength <= 255;
}

export function isSafeUploadDirectory(value: string): boolean {
  return value.length <= 4096 && (value === "" || value.split("/").every(isSafeUploadName));
}

export type SelectedUploadRow = {
  id: string;
  name: string;
  destination: string;
  status: "queued" | "uploading" | "failed" | "cancelled";
  error?: string;
};

export class SelectedUploadError extends Error {
  constructor(public readonly code: "file_exists" | "unavailable") {
    super(code === "file_exists" ? "A file with this name already exists." : "Upload failed. Try again.");
    this.name = "SelectedUploadError";
  }
}

type SelectedFile = { name: string; size: number };
type Pending<T> = SelectedUploadRow & { file: T; scope: string };

/** The transport is captured by each controller, so queued work cannot move runtimes. */
export function createSelectedFileUploadController<T extends SelectedFile>(options: {
  getScope: () => string;
  upload: (file: T, path: string, signal: AbortSignal) => Promise<unknown>;
  onUploaded: (directory: string) => void;
  release?: (file: T) => void;
}) {
  let pending: Pending<T>[] = [];
  let sequence = 0;
  let disposed = false;
  let snapshot: SelectedUploadRow[] = [];
  const active = new Map<string, AbortController>();
  const listeners = new Set<(rows: SelectedUploadRow[]) => void>();
  const emit = () => {
    if (disposed) return;
    snapshot = pending.map(({ file: _file, scope: _scope, ...row }) => row);
    for (const listener of listeners) listener(snapshot);
  };
  const release = (file: T) => {
    try { options.release?.(file); }
    catch (error: unknown) { console.warn("[selected-upload] local cleanup failed", error instanceof Error ? error.name : "UnknownError"); }
  };
  const removeItem = (item: Pending<T>) => {
    if (!pending.includes(item)) return;
    pending = pending.filter(candidate => candidate !== item);
    release(item.file);
  };
  const pump = () => {
    if (disposed) return;
    const queued = pending.filter(item => item.status === "queued").slice(0, MAX_CONCURRENT - active.size);
    for (const item of queued) {
      if (options.getScope() !== item.scope) {
        item.status = "failed";
        item.error = "Select the original computer to retry this upload.";
        continue;
      }
      const controller = new AbortController();
      active.set(item.id, controller);
      item.status = "uploading";
      const path = item.destination ? `${item.destination}/${item.name}` : item.name;
      // Promise boundary catches synchronous transport failures too.
      void Promise.resolve().then(() => {
        if (disposed || controller.signal.aborted || options.getScope() !== item.scope) throw new SelectedUploadError("unavailable");
        return options.upload(item.file, path, controller.signal);
      })
        .then(() => {
          if (disposed || item.status === "cancelled") return;
          removeItem(item);
          if (options.getScope() === item.scope) options.onUploaded(item.destination);
        }).catch((error: unknown) => {
          if (disposed || item.status === "cancelled") return;
          item.status = "failed";
          item.error = error instanceof SelectedUploadError ? error.message : "Upload failed. Try again.";
        }).finally(() => {
          active.delete(item.id);
          emit();
          pump();
        });
    }
    emit();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: (rows: SelectedUploadRow[]) => void) {
      if (disposed || listeners.size >= MAX_SUBSCRIBERS) throw new Error("upload subscribers unavailable");
      listeners.add(listener);
      listener(snapshot);
      return () => { listeners.delete(listener); };
    },
    enqueue(files: readonly T[], destination: string) {
      for (const file of files) {
        if (disposed || pending.length >= MAX_SELECTED_UPLOAD_QUEUE || !isSafeUploadName(file.name)
          || !isSafeUploadDirectory(destination) || !Number.isSafeInteger(file.size) || file.size < 0) {
          release(file);
          continue;
        }
        const tooLarge = file.size > MAX_SELECTED_UPLOAD_BYTES;
        pending.push({ id: `upload-${++sequence}`, file, scope: options.getScope(), name: file.name,
          destination, status: tooLarge ? "failed" : "queued", ...(tooLarge ? { error: "Files are limited to 10 MB." } : {}) });
      }
      pump();
    },
    retry(id: string) {
      if (disposed || active.has(id)) return;
      const item = pending.find(candidate => candidate.id === id && ["failed", "cancelled"].includes(candidate.status));
      if (!item || item.file.size > MAX_SELECTED_UPLOAD_BYTES || options.getScope() !== item.scope) return;
      item.status = "queued";
      item.error = undefined;
      pump();
    },
    cancel(id: string) {
      const item = pending.find(candidate => candidate.id === id);
      if (!item) return;
      item.status = "cancelled";
      item.error = "Upload cancelled. You can retry.";
      active.get(id)?.abort();
      emit();
    },
    remove(id: string) {
      const item = pending.find(candidate => candidate.id === id);
      if (!item) return;
      active.get(id)?.abort();
      item.status = "cancelled";
      removeItem(item);
      emit();
    },
    clear() {
      for (const controller of active.values()) controller.abort();
      active.clear();
      for (const item of pending) { item.status = "cancelled"; release(item.file); }
      pending = [];
      emit();
    },
    dispose() {
      disposed = true;
      for (const controller of active.values()) controller.abort();
      active.clear();
      for (const item of pending) { item.status = "cancelled"; release(item.file); }
      pending = [];
      listeners.clear();
    },
  };
}
