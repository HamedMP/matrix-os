import {
  stat as fsStat,
  mkdir,
  writeFile,
  rename,
  cp,
  access,
  readdir,
} from "node:fs/promises";
import { basename, dirname, extname, join, posix, relative } from "node:path";
import { existsSync } from "node:fs";
import {
  isDeniedFileApiPath,
  resolveExistingFileApiPath,
  resolveWithinHome,
  resolveWritableFileApiPath,
  normalizeHomeRelativePath,
} from "./path-security.js";
import { getMimeType } from "./file-utils.js";
import {
  CreateFileRequestSchema,
  RenameFileRequestSchema,
  type FileEntryCapabilities,
  type FileOperationResultCode,
} from "./file-management/contracts.js";
import {
  getFileEntryCapabilities,
  isFileManagementMutationAllowed,
  isFileManagementParentAllowed,
} from "./file-management/policy.js";

type ErrnoException = NodeJS.ErrnoException;

export interface FileStatResult {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  modified: string;
  created: string;
  mime?: string;
}

export interface FileManagementMutationResult {
  ok: boolean;
  path?: string;
  resultCode?: FileOperationResultCode;
  capabilities?: FileEntryCapabilities;
  errorCode?: "invalid_path" | "protected" | "destination_conflict" | "source_missing" | "failed";
}

export async function createFile(
  homePath: string,
  input: unknown,
): Promise<FileManagementMutationResult> {
  const parsed = CreateFileRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errorCode: "invalid_path" };

  const { parentDirectory, name, kind } = parsed.data;
  const parent = resolveExistingFileApiPath(homePath, parentDirectory);
  if (!parent) return { ok: false, errorCode: "invalid_path" };
  if (!isFileManagementParentAllowed(homePath, parentDirectory)) {
    return { ok: false, errorCode: "protected" };
  }

  try {
    if (!(await fsStat(parent)).isDirectory()) return { ok: false, errorCode: "invalid_path" };
  } catch (err: unknown) {
    console.warn("[file-ops] Failed to inspect create parent:", err instanceof Error ? err.message : String(err));
    return { ok: false, errorCode: "failed" };
  }

  const requestedPath = parentDirectory ? `${parentDirectory}/${name}` : name;
  const target = resolveWritableFileApiPath(homePath, requestedPath);
  if (!target || !isFileManagementParentAllowed(homePath, parentDirectory)) {
    return { ok: false, errorCode: "protected" };
  }

  try {
    if (kind === "directory") {
      await mkdir(target);
    } else {
      await writeFile(target, "", { flag: "wx" });
    }
    const path = normalizeHomeRelativePath(homePath, target);
    if (!path) return { ok: false, errorCode: "failed" };
    return {
      ok: true,
      path,
      resultCode: "created",
      capabilities: getFileEntryCapabilities(homePath, path),
    };
  } catch (err: unknown) {
    if ((err as ErrnoException).code === "EEXIST") {
      return { ok: false, errorCode: "destination_conflict" };
    }
    console.warn("[file-ops] Typed create failed:", err instanceof Error ? err.message : String(err));
    return { ok: false, errorCode: "failed" };
  }
}

export async function renameFile(
  homePath: string,
  input: unknown,
): Promise<FileManagementMutationResult> {
  const parsed = RenameFileRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errorCode: "invalid_path" };

  const { path: sourcePath, name } = parsed.data;
  const parentDirectory = posix.dirname(sourcePath);
  const targetPath = `${parentDirectory}/${name}`;
  const source = resolveExistingFileApiPath(homePath, sourcePath);
  const target = resolveWritableFileApiPath(homePath, targetPath);
  if (!source || !target) return { ok: false, errorCode: "invalid_path" };
  if (!isFileManagementMutationAllowed(homePath, sourcePath) || !isFileManagementParentAllowed(homePath, parentDirectory)) {
    return { ok: false, errorCode: "protected" };
  }
  if (existsSync(target)) return { ok: false, errorCode: "destination_conflict" };

  const reauthorizedSource = resolveExistingFileApiPath(homePath, sourcePath);
  const reauthorizedTarget = resolveWritableFileApiPath(homePath, targetPath);
  if (!reauthorizedSource) return { ok: false, errorCode: "source_missing" };
  if (!reauthorizedTarget || !isFileManagementMutationAllowed(homePath, sourcePath) || !isFileManagementParentAllowed(homePath, parentDirectory)) {
    return { ok: false, errorCode: "protected" };
  }
  if (existsSync(reauthorizedTarget)) return { ok: false, errorCode: "destination_conflict" };
  try {
    await rename(reauthorizedSource, reauthorizedTarget);
    const path = normalizeHomeRelativePath(homePath, reauthorizedTarget);
    if (!path) return { ok: false, errorCode: "failed" };
    return {
      ok: true,
      path,
      resultCode: "renamed",
      capabilities: getFileEntryCapabilities(homePath, path),
    };
  } catch (err: unknown) {
    if ((err as ErrnoException).code === "EEXIST") {
      return { ok: false, errorCode: "destination_conflict" };
    }
    console.warn("[file-ops] Typed rename failed:", err instanceof Error ? err.message : String(err));
    return { ok: false, errorCode: "failed" };
  }
}

export async function fileStat(
  homePath: string,
  requestedPath: string,
): Promise<FileStatResult | null> {
  const resolved = resolveWithinHome(homePath, requestedPath);
  if (!resolved || isDeniedFileApiPath(homePath, requestedPath)) return null;

  try {
    const stats = await fsStat(resolved);
    const name = basename(resolved);
    const type = stats.isDirectory() ? "directory" : "file";

    return {
      name,
      path: requestedPath,
      type,
      size: type === "file" ? stats.size : undefined,
      modified: new Date(stats.mtimeMs).toISOString(),
      created: new Date(stats.birthtimeMs).toISOString(),
      mime: type === "file" ? getMimeType(extname(name)) : undefined,
    };
  } catch (err: unknown) {
    console.warn("[file-ops] Stat failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

export async function fileMkdir(
  homePath: string,
  requestedPath: string,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const resolved = resolveWritableFileApiPath(homePath, requestedPath);
  if (!resolved || !isFileManagementMutationAllowed(homePath, requestedPath)) return { ok: false, error: "Invalid path" };

  try {
    if (!isFileManagementMutationAllowed(homePath, requestedPath)) return { ok: false, error: "Invalid path" };
    await mkdir(resolved, { recursive: true });
    return { ok: true, path: requestedPath };
  } catch (err: unknown) {
    console.warn("[file-ops] Mkdir failed:", err instanceof Error ? err.message : String(err));
    return { ok: false, error: "Failed to create directory" };
  }
}

export async function fileTouch(
  homePath: string,
  requestedPath: string,
  content = "",
): Promise<{ ok: boolean; path?: string; error?: string; status?: number }> {
  const resolved = resolveWritableFileApiPath(homePath, requestedPath);
  if (!resolved || !isFileManagementMutationAllowed(homePath, requestedPath)) return { ok: false, error: "Invalid path" };

  try {
    if (!isFileManagementMutationAllowed(homePath, requestedPath)) return { ok: false, error: "Invalid path" };
    const dir = dirname(resolved);
    await mkdir(dir, { recursive: true });
    await writeFile(resolved, content, { flag: "wx" });
    return { ok: true, path: requestedPath };
  } catch (err: unknown) {
    if ((err as ErrnoException).code === "EEXIST") {
      return { ok: false, error: "File already exists", status: 409 };
    }
    return { ok: false, error: "Failed to create file" };
  }
}

export async function fileRename(
  homePath: string,
  from: string,
  to: string,
): Promise<{ ok: boolean; error?: string; status?: number }> {
  const lexicalFrom = resolveWithinHome(homePath, from);
  const resolvedTo = resolveWritableFileApiPath(homePath, to);
  if (!lexicalFrom || !resolvedTo || isDeniedFileApiPath(homePath, from) || !isFileManagementMutationAllowed(homePath, from) || !isFileManagementMutationAllowed(homePath, to)) return { ok: false, error: "Invalid path" };

  if (!existsSync(lexicalFrom)) {
    return { ok: false, error: "Source not found", status: 404 };
  }

  const resolvedFrom = resolveExistingFileApiPath(homePath, from);
  if (!resolvedFrom || !resolvedTo || isDeniedFileApiPath(homePath, from) || isDeniedFileApiPath(homePath, to) || !isFileManagementMutationAllowed(homePath, from) || !isFileManagementMutationAllowed(homePath, to)) return { ok: false, error: "Invalid path" };

  if (existsSync(resolvedTo)) {
    return { ok: false, error: "Destination already exists", status: 409 };
  }

  try {
    if (!isFileManagementMutationAllowed(homePath, from) || !isFileManagementMutationAllowed(homePath, to)) return { ok: false, error: "Invalid path" };
    const dir = dirname(resolvedTo);
    await mkdir(dir, { recursive: true });
    await rename(resolvedFrom, resolvedTo);
    return { ok: true };
  } catch (err: unknown) {
    console.warn("[file-ops] Rename failed:", err instanceof Error ? err.message : String(err));
    return { ok: false, error: "Failed to rename" };
  }
}

export async function fileCopy(
  homePath: string,
  from: string,
  to: string,
): Promise<{ ok: boolean; error?: string; status?: number }> {
  const lexicalFrom = resolveWithinHome(homePath, from);
  const resolvedTo = resolveWritableFileApiPath(homePath, to);
  if (!lexicalFrom || !resolvedTo || isDeniedFileApiPath(homePath, from) || !isFileManagementMutationAllowed(homePath, from) || !isFileManagementMutationAllowed(homePath, to)) return { ok: false, error: "Invalid path" };

  if (!existsSync(lexicalFrom)) {
    return { ok: false, error: "Source not found", status: 404 };
  }

  const resolvedFrom = resolveExistingFileApiPath(homePath, from);
  if (!resolvedFrom || !resolvedTo || isDeniedFileApiPath(homePath, from) || isDeniedFileApiPath(homePath, to) || !isFileManagementMutationAllowed(homePath, from) || !isFileManagementMutationAllowed(homePath, to)) return { ok: false, error: "Invalid path" };

  if (existsSync(resolvedTo)) {
    return { ok: false, error: "Destination already exists", status: 409 };
  }

  try {
    if (!isFileManagementMutationAllowed(homePath, from) || !isFileManagementMutationAllowed(homePath, to)) return { ok: false, error: "Invalid path" };
    const dir = dirname(resolvedTo);
    await mkdir(dir, { recursive: true });
    await cp(resolvedFrom, resolvedTo, { recursive: true });
    return { ok: true };
  } catch (err: unknown) {
    console.warn("[file-ops] Copy failed:", err instanceof Error ? err.message : String(err));
    return { ok: false, error: "Failed to copy" };
  }
}

export async function fileDuplicate(
  homePath: string,
  requestedPath: string,
): Promise<{ ok: boolean; newPath?: string; error?: string; status?: number }> {
  const lexicalSource = resolveWithinHome(homePath, requestedPath);
  if (!lexicalSource || isDeniedFileApiPath(homePath, requestedPath) || !isFileManagementMutationAllowed(homePath, requestedPath)) return { ok: false, error: "Invalid path" };

  if (!existsSync(lexicalSource)) {
    return { ok: false, error: "Source not found", status: 404 };
  }

  const resolved = resolveExistingFileApiPath(homePath, requestedPath);
  if (!resolved) return { ok: false, error: "Invalid path" };

  const stats = await fsStat(resolved);
  const dir = dirname(requestedPath);
  const name = basename(requestedPath);

  const MAX_COPIES = 100;
  let newName: string;
  if (stats.isDirectory()) {
    newName = `${name} copy`;
    let counter = 2;
    while (counter <= MAX_COPIES && existsSync(join(dirname(resolved), newName))) {
      newName = `${name} copy ${counter}`;
      counter++;
    }
    if (counter > MAX_COPIES) return { ok: false, error: "Too many copies exist" };
  } else {
    const ext = extname(name);
    const base = ext ? name.slice(0, -ext.length) : name;
    newName = ext ? `${base} copy${ext}` : `${base} copy`;
    let counter = 2;
    while (counter <= MAX_COPIES && existsSync(join(dirname(resolved), newName))) {
      newName = ext ? `${base} copy ${counter}${ext}` : `${base} copy ${counter}`;
      counter++;
    }
    if (counter > MAX_COPIES) return { ok: false, error: "Too many copies exist" };
  }

  const requestedNewPath = join(dir, newName);
  const resolvedNew = resolveWritableFileApiPath(homePath, requestedNewPath);
  if (!resolvedNew || !isFileManagementMutationAllowed(homePath, requestedNewPath)) return { ok: false, error: "Invalid path" };
  const newPath = relative(homePath, resolvedNew);

  try {
    if (!isFileManagementMutationAllowed(homePath, requestedPath) || !isFileManagementMutationAllowed(homePath, requestedNewPath)) return { ok: false, error: "Invalid path" };
    await cp(resolved, resolvedNew, { recursive: true });
    return { ok: true, newPath };
  } catch (err: unknown) {
    console.warn("[file-ops] Duplicate failed:", err instanceof Error ? err.message : String(err));
    return { ok: false, error: "Failed to duplicate" };
  }
}
