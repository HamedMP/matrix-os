// Editor open/save logic (FR-041). The gateway file PUT is an unconditional
// overwrite, so every save stats first and refuses to clobber a newer server
// mtime; overwrite is a separate, user-confirmed path.
//
// Verified wire shapes (packages/gateway/src/server.ts, file-ops.ts):
//   GET /api/files/stat?path=<p> -> FileStatResult JSON: { name, path,
//     type: "file"|"directory", size?, modified: ISO string, created: ISO
//     string, mime? }; 404 when missing. mtime field is `modified` (ISO),
//     normalized here to epoch ms.
//   GET /files/{path}            -> raw text body
//   PUT /files/{path}            -> raw text body in, { ok: true } out
import { z } from "zod/v4";
import { AppError } from "../../../../shared/app-error";
import type { ApiClient } from "../../lib/api";

export interface OpenedFile {
  path: string;
  content: string;
  loadedMtime: number | null;
}

export interface FilesApi {
  stat(path: string): Promise<{ mtime: number | null }>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
}

const WireStatSchema = z.looseObject({
  modified: z.union([z.string(), z.number()]).optional(),
});

function encodeFilesPath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function normalizeMtime(value: string | number | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function createFilesApi(api: ApiClient): FilesApi {
  return {
    stat: async (path) => {
      let raw: unknown;
      try {
        raw = await api.get<unknown>(`/api/files/stat?path=${encodeURIComponent(path)}`);
      } catch (err: unknown) {
        // A missing file is a valid pre-save state (new file), not a failure.
        if (err instanceof AppError && err.category === "notFound") return { mtime: null };
        throw err;
      }
      const parsed = WireStatSchema.safeParse(raw);
      if (!parsed.success) return { mtime: null };
      return { mtime: normalizeMtime(parsed.data.modified) };
    },
    read: (path) => api.getText(`/files/${encodeFilesPath(path)}`),
    write: async (path, content) => {
      await api.putText<{ ok: boolean }>(`/files/${encodeFilesPath(path)}`, content);
    },
  };
}

export async function openFile(files: FilesApi, path: string): Promise<OpenedFile> {
  // Stat before read: if the file changes in between, the recorded mtime is
  // older than the content and the next save fails safe with a conflict.
  const { mtime } = await files.stat(path);
  const content = await files.read(path);
  return { path, content, loadedMtime: mtime };
}

export type SaveResult = { ok: true; newMtime: number | null } | { ok: false; reason: "conflict" };

export async function saveFile(
  files: FilesApi,
  file: OpenedFile,
  content: string,
): Promise<SaveResult> {
  const { mtime: serverMtime } = await files.stat(file.path);
  // Strict equality: null/null (file does not exist yet on either side) is
  // the only conflict-free null pairing. Network errors propagate as AppError.
  if (serverMtime !== file.loadedMtime) return { ok: false, reason: "conflict" };
  await files.write(file.path, content);
  const { mtime: newMtime } = await files.stat(file.path);
  return { ok: true, newMtime };
}

export async function saveFileOverwrite(
  files: FilesApi,
  path: string,
  content: string,
): Promise<number | null> {
  await files.write(path, content);
  const { mtime } = await files.stat(path);
  return mtime;
}
