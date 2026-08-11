import {
  stat as fsStat,
  access,
  readdir,
} from "node:fs/promises";
import { basename, extname, posix } from "node:path";
import { existsSync } from "node:fs";
import {
  containsDeniedFileApiPath,
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
import {
  getNativeFileCapability,
  NativeFileCapabilityUnavailableError,
  type NativeFileCapability,
  type NativeFileCapabilityResult,
} from "./file-management/native-file-capability.js";

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
  recoveryPath?: string;
  partialPath?: string;
  errorCode?: "invalid_path" | "protected" | "destination_conflict" | "source_missing" | "cleanup_failed" | "failed";
}

export interface FileCopyDependencies {
  beforeNativeMutation?: () => Promise<void>;
}

export type NoReplaceFileMoveCapability = Pick<NativeFileCapability, "move">;

export interface NoReplaceFileMoveDependencies {
  moveCapability?: NoReplaceFileMoveCapability;
  requestId?: string;
}

export function isSameOrDescendantPath(source: string, target: string): boolean {
  return target === source || target.startsWith(`${source}/`);
}

async function runNativeMutation(
  operation: () => Promise<NativeFileCapabilityResult>,
  requestId?: string,
): Promise<NativeFileCapabilityResult> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (!(error instanceof NativeFileCapabilityUnavailableError)) {
      const requestContext = requestId ? ` for request ${requestId}` : "";
      console.warn(`[file-ops] Native file-management operation failed${requestContext}:`, error instanceof Error ? error.message : String(error));
    }
    return { ok: false, code: "unsupported_platform" };
  }
}

/**
 * The narrow native boundary used by batch moves. Production callers get the
 * Linux no-replace capability; tests may inject the same move contract on
 * platforms where the addon cannot load. There is deliberately no JS fallback.
 */
export async function moveFileNoReplace(
  homePath: string,
  sourcePath: string,
  targetPath: string,
  dependencies: NoReplaceFileMoveDependencies = {},
): Promise<NativeFileCapabilityResult> {
  return runNativeMutation(() =>
    (dependencies.moveCapability ?? getNativeFileCapability()).move(
      homePath,
      sourcePath,
      targetPath,
      false,
    ), dependencies.requestId);
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
  if (!target) return { ok: false, errorCode: "invalid_path" };
  if (
    !isFileManagementParentAllowed(homePath, parentDirectory)
    || !isFileManagementMutationAllowed(homePath, requestedPath)
  ) {
    return { ok: false, errorCode: "protected" };
  }

  try {
    const nativeResult = await runNativeMutation(() =>
      getNativeFileCapability().create(homePath, requestedPath, kind, "", false, false));
    if (!nativeResult.ok) {
      if (nativeResult.code === "destination_conflict") return { ok: false, errorCode: "destination_conflict" };
      return { ok: false, errorCode: nativeResult.code === "invalid_path" ? "invalid_path" : "failed" };
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
  const targetPath = parentDirectory === "." ? name : `${parentDirectory}/${name}`;
  const source = resolveExistingFileApiPath(homePath, sourcePath);
  const target = resolveWritableFileApiPath(homePath, targetPath);
  if (!source || !target) return { ok: false, errorCode: "invalid_path" };
  if (
    !isFileManagementMutationAllowed(homePath, sourcePath)
    || !isFileManagementParentAllowed(homePath, parentDirectory)
    || !isFileManagementMutationAllowed(homePath, targetPath)
  ) {
    return { ok: false, errorCode: "protected" };
  }
  const reauthorizedSource = resolveExistingFileApiPath(homePath, sourcePath);
  const reauthorizedTarget = resolveWritableFileApiPath(homePath, targetPath);
  if (!reauthorizedSource) return { ok: false, errorCode: "source_missing" };
  if (
    !reauthorizedTarget
    || !isFileManagementMutationAllowed(homePath, sourcePath)
    || !isFileManagementParentAllowed(homePath, parentDirectory)
    || !isFileManagementMutationAllowed(homePath, targetPath)
  ) {
    return { ok: false, errorCode: "protected" };
  }
  if (isSameOrDescendantPath(sourcePath, targetPath)) {
    return { ok: false, errorCode: "invalid_path" };
  }
  try {
    const nativeResult = await runNativeMutation(() =>
      getNativeFileCapability().move(homePath, sourcePath, targetPath, false));
    if (!nativeResult.ok) {
      if (nativeResult.code === "destination_conflict") return { ok: false, errorCode: "destination_conflict" };
      if (nativeResult.code === "source_missing") return { ok: false, errorCode: "source_missing" };
      return { ok: false, errorCode: nativeResult.code === "invalid_path" ? "invalid_path" : "failed" };
    }
    const normalizedPath = normalizeHomeRelativePath(homePath, reauthorizedTarget);
    if (!normalizedPath) return { ok: false, errorCode: "failed" };
    return {
      ok: true,
      path: normalizedPath,
      resultCode: "renamed",
      capabilities: getFileEntryCapabilities(homePath, normalizedPath),
    };
  } catch (err: unknown) {
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
    const nativeResult = await runNativeMutation(() =>
      getNativeFileCapability().create(homePath, requestedPath, "directory", "", true, true));
    if (!nativeResult.ok) return { ok: false, error: "Failed to create directory" };
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
    const nativeResult = await runNativeMutation(() =>
      getNativeFileCapability().create(homePath, requestedPath, "file", content, true, false));
    if (!nativeResult.ok) {
      if (nativeResult.code === "destination_conflict") return { ok: false, error: "File already exists", status: 409 };
      return { ok: false, error: "Failed to create file" };
    }
    return { ok: true, path: requestedPath };
  } catch (err: unknown) {
    return { ok: false, error: "Failed to create file" };
  }
}

export async function fileRename(
  homePath: string,
  from: string,
  to: string,
): Promise<{ ok: boolean; error?: string; status?: number; recoveryPath?: string; partialPath?: string }> {
  const lexicalFrom = resolveWithinHome(homePath, from);
  const resolvedTo = resolveWritableFileApiPath(homePath, to);
  if (!lexicalFrom || !resolvedTo || isDeniedFileApiPath(homePath, from) || !isFileManagementMutationAllowed(homePath, from) || !isFileManagementMutationAllowed(homePath, to)) return { ok: false, error: "Invalid path" };

  if (!existsSync(lexicalFrom)) {
    return { ok: false, error: "Source not found", status: 404 };
  }

  const resolvedFrom = resolveExistingFileApiPath(homePath, from);
  if (!resolvedFrom || !resolvedTo || isDeniedFileApiPath(homePath, from) || isDeniedFileApiPath(homePath, to) || !isFileManagementMutationAllowed(homePath, from) || !isFileManagementMutationAllowed(homePath, to)) return { ok: false, error: "Invalid path" };

  try {
    if (!isFileManagementMutationAllowed(homePath, from) || !isFileManagementMutationAllowed(homePath, to)) return { ok: false, error: "Invalid path" };
    const reauthorizedFrom = resolveExistingFileApiPath(homePath, from);
    const reauthorizedTo = resolveWritableFileApiPath(homePath, to);
    if (!reauthorizedFrom || !reauthorizedTo || !isFileManagementMutationAllowed(homePath, from) || !isFileManagementMutationAllowed(homePath, to)) {
      return { ok: false, error: "Invalid path" };
    }
    if (isSameOrDescendantPath(from, to)) {
      return { ok: false, error: "Invalid path" };
    }
    const nativeResult = await runNativeMutation(() =>
      getNativeFileCapability().move(homePath, from, to, true));
    if (!nativeResult.ok) {
      if (nativeResult.code === "destination_conflict") return { ok: false, error: "Destination already exists", status: 409 };
      if (nativeResult.code === "source_missing") return { ok: false, error: "Source not found", status: 404 };
      if (nativeResult.code === "invalid_path") return { ok: false, error: "Invalid path" };
      return { ok: false, error: "Failed to rename" };
    }
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
  dependencies: FileCopyDependencies = {},
): Promise<{ ok: boolean; error?: string; status?: number; partialPath?: string }> {
  const lexicalFrom = resolveWithinHome(homePath, from);
  const resolvedTo = resolveWritableFileApiPath(homePath, to);
  if (!lexicalFrom || containsDeniedFileApiPath(homePath, lexicalFrom) || !resolvedTo || isDeniedFileApiPath(homePath, from) || !isFileManagementMutationAllowed(homePath, to)) return { ok: false, error: "Invalid path" };

  if (!existsSync(lexicalFrom)) {
    return { ok: false, error: "Source not found", status: 404 };
  }

  const resolvedFrom = resolveExistingFileApiPath(homePath, from);
  if (!resolvedFrom || containsDeniedFileApiPath(homePath, resolvedFrom) || !resolvedTo || isDeniedFileApiPath(homePath, from) || isDeniedFileApiPath(homePath, to) || !isFileManagementMutationAllowed(homePath, to)) return { ok: false, error: "Invalid path" };

  try {
    if (!isFileManagementMutationAllowed(homePath, to)) return { ok: false, error: "Invalid path" };
    const reauthorizedFrom = resolveExistingFileApiPath(homePath, from);
    const reauthorizedTo = resolveWritableFileApiPath(homePath, to);
    if (!reauthorizedFrom || containsDeniedFileApiPath(homePath, reauthorizedFrom) || !reauthorizedTo || !isFileManagementMutationAllowed(homePath, to)) {
      return { ok: false, error: "Invalid path" };
    }
    if (isSameOrDescendantPath(from, to)) {
      return { ok: false, error: "Invalid path" };
    }
    await dependencies.beforeNativeMutation?.();
    const nativeResult = await runNativeMutation(() =>
      getNativeFileCapability().copy(homePath, from, to, true));
    if (!nativeResult.ok) {
      if (nativeResult.code === "destination_conflict") {
        return {
          ok: false,
          error: "Destination already exists",
          status: 409,
          ...(nativeResult.partialPath ? { partialPath: nativeResult.partialPath } : {}),
        };
      }
      if (nativeResult.code === "source_missing") return { ok: false, error: "Source not found", status: 404 };
      if (nativeResult.code === "invalid_path") return { ok: false, error: "Invalid path" };
      if (nativeResult.code === "partial") {
        return nativeResult.partialPath
          ? { ok: false, error: "Failed to copy", partialPath: nativeResult.partialPath }
          : { ok: false, error: "Failed to copy" };
      }
      return { ok: false, error: "Failed to copy" };
    }
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
  if (!lexicalSource || containsDeniedFileApiPath(homePath, lexicalSource) || isDeniedFileApiPath(homePath, requestedPath)) return { ok: false, error: "Invalid path" };

  if (!existsSync(lexicalSource)) {
    return { ok: false, error: "Source not found", status: 404 };
  }

  const resolved = resolveExistingFileApiPath(homePath, requestedPath);
  if (!resolved || containsDeniedFileApiPath(homePath, resolved)) return { ok: false, error: "Invalid path" };

  const stats = await fsStat(resolved);
  const dir = posix.dirname(requestedPath);
  const name = basename(requestedPath);
  const MAX_COPIES = 100;
  const ext = stats.isDirectory() ? "" : extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;

  for (let copyNumber = 1; copyNumber <= MAX_COPIES; copyNumber++) {
    const suffix = copyNumber === 1 ? " copy" : ` copy ${copyNumber}`;
    const newName = `${base}${suffix}${ext}`;
    const requestedNewPath = dir === "." ? newName : `${dir}/${newName}`;
    const resolvedNew = resolveWritableFileApiPath(homePath, requestedNewPath);
    if (!resolvedNew || !isFileManagementMutationAllowed(homePath, requestedNewPath)) {
      return { ok: false, error: "Invalid path" };
    }

    try {
      const reauthorizedSource = resolveExistingFileApiPath(homePath, requestedPath);
      const reauthorizedTarget = resolveWritableFileApiPath(homePath, requestedNewPath);
      if (!reauthorizedSource || containsDeniedFileApiPath(homePath, reauthorizedSource) || !reauthorizedTarget || !isFileManagementMutationAllowed(homePath, requestedNewPath)) {
        return { ok: false, error: "Invalid path" };
      }
      const nativeResult = await runNativeMutation(() =>
        getNativeFileCapability().copy(homePath, requestedPath, requestedNewPath, false));
      if (!nativeResult.ok) {
        if (nativeResult.code === "destination_conflict") {
          if (nativeResult.partialPath) {
            return { ok: false, newPath: nativeResult.partialPath, error: "Failed to duplicate" };
          }
          continue;
        }
        if (nativeResult.code === "partial") {
          return {
            ok: false,
            newPath: nativeResult.partialPath ?? requestedNewPath,
            error: "Failed to duplicate",
          };
        }
        return { ok: false, error: "Failed to duplicate" };
      }
      const newPath = normalizeHomeRelativePath(homePath, reauthorizedTarget);
      if (!newPath) return { ok: false, error: "Failed to duplicate" };
      return { ok: true, newPath };
    } catch (err: unknown) {
      console.warn("[file-ops] Duplicate failed:", err instanceof Error ? err.message : String(err));
      return { ok: false, error: "Failed to duplicate" };
    }
  }

  return { ok: false, error: "Too many copies exist" };
}
