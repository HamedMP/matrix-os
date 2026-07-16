import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, posix, resolve } from "node:path";
import { homedir } from "node:os";

export interface FileTransferClient {
  gatewayUrl: string;
  token: string;
}

export interface UploadOptions {
  force?: boolean;
  secret?: boolean;
}

export interface DownloadOptions {
  force?: boolean;
  secret?: boolean;
}

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function debugTransferFailure(context: string, err: unknown): void {
  if (process.env.MATRIX_CLI_DEBUG !== "1") return;
  const kind = err instanceof Error ? err.name : typeof err;
  console.error(`[debug] ${context}: ${kind}`);
}

export function expandLocalPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

export function normalizeMatrixPath(remotePath: string): string {
  const localHome = homedir();
  const shellExpandedHomeRelative = remotePath === localHome
    ? "."
    : remotePath.startsWith(`${localHome}/`)
      ? remotePath.slice(localHome.length + 1)
      : remotePath;
  const homeRelative = shellExpandedHomeRelative === "~"
    ? "."
    : shellExpandedHomeRelative.startsWith("~/")
      ? shellExpandedHomeRelative.slice(2) || "."
      : shellExpandedHomeRelative;
  if (!homeRelative || homeRelative.startsWith("/")) {
    throw codedError(
      "Matrix paths must stay within your Matrix home. Use a path such as `~/dev/file.txt`.",
      "invalid_remote_path",
    );
  }
  const normalized = posix.normalize(homeRelative);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw codedError(
      "Matrix paths must stay within your Matrix home. Use a path such as `~/dev/file.txt`.",
      "invalid_remote_path",
    );
  }
  return normalized;
}

function blobUrl(
  client: FileTransferClient,
  remotePath: string,
  options: UploadOptions = {},
  localFilename?: string,
): string {
  const url = new URL("/api/files/blob", client.gatewayUrl);
  url.searchParams.set("path", normalizeMatrixPath(remotePath));
  if (localFilename) url.searchParams.set("filename", localFilename);
  if (options.force) url.searchParams.set("force", "true");
  if (options.secret) url.searchParams.set("secret", "true");
  return url.toString();
}

function authHeaders(client: FileTransferClient): Record<string, string> {
  return { authorization: `Bearer ${client.token}` };
}

export async function completeRemotePaths(
  client: FileTransferClient,
  remotePrefix: string,
): Promise<string[]> {
  const homeStyle = remotePrefix === "~" || remotePrefix.startsWith("~/");
  const relativePrefix = remotePrefix === "~"
    ? ""
    : homeStyle
      ? remotePrefix.slice(2)
      : remotePrefix;
  if (relativePrefix.startsWith("/")) return [];

  const separator = relativePrefix.lastIndexOf("/");
  const parentPrefix = separator >= 0 ? relativePrefix.slice(0, separator) : "";
  const namePrefix = separator >= 0 ? relativePrefix.slice(separator + 1) : relativePrefix;
  let parentPath: string;
  try {
    parentPath = normalizeMatrixPath(parentPrefix || ".");
  } catch (err) {
    debugTransferFailure("remote completion path rejected", err);
    return [];
  }

  const url = new URL("/api/files/list", client.gatewayUrl);
  url.searchParams.set("path", parentPath);
  try {
    const res = await fetch(url, {
      headers: authHeaders(client),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const payload = (await res.json()) as { entries?: unknown };
    if (!Array.isArray(payload.entries)) return [];
    const displayParent = parentPrefix ? `${parentPrefix}/` : "";
    const displayHome = homeStyle ? "~/" : "";
    return payload.entries
      .slice(0, 500)
      .flatMap((entry): string[] => {
        if (!entry || typeof entry !== "object") return [];
        const { name, type } = entry as { name?: unknown; type?: unknown };
        if (
          typeof name !== "string" ||
          !name.startsWith(namePrefix) ||
          /[\r\n]/.test(name) ||
          (type !== "file" && type !== "directory")
        ) {
          return [];
        }
        return [`${displayHome}${displayParent}${name}${type === "directory" ? "/" : ""}`];
      });
  } catch (err) {
    debugTransferFailure("remote completion request failed", err);
    return [];
  }
}

const SAFE_TRANSFER_ERRORS: Record<string, { code: string; message: string }> = {
  invalid_path: {
    code: "invalid_remote_path",
    message: "Matrix paths must stay within your Matrix home. Use a path such as `~/dev/file.txt`.",
  },
  not_file: {
    code: "remote_path_not_file",
    message: "Matrix source must be a regular file.",
  },
  file_exists: {
    code: "remote_file_exists",
    message: "Remote file already exists. Re-run with --force to overwrite.",
  },
  payload_too_large: {
    code: "payload_too_large",
    message: "File is too large for single-file transfer.",
  },
};

async function safeTransferErrorCode(res: Response): Promise<string | null> {
  try {
    const payload = (await res.json()) as { error?: unknown };
    return typeof payload.error === "string" ? payload.error : null;
  } catch (err) {
    debugTransferFailure("transfer error response was not JSON", err);
    return null;
  }
}

async function errorForResponse(res: Response, fallback: string): Promise<Error> {
  if (res.status === 401 || res.status === 403) {
    return codedError("Auth token rejected or expired. Run `matrix login` again.", "auth_rejected");
  }
  const serverCode = await safeTransferErrorCode(res);
  if (serverCode && SAFE_TRANSFER_ERRORS[serverCode]) {
    const safe = SAFE_TRANSFER_ERRORS[serverCode];
    return codedError(safe.message, safe.code);
  }
  if (res.status === 404) return codedError("Remote file not found.", "remote_file_not_found");
  if (res.status === 409) {
    return codedError("Remote file already exists. Re-run with --force to overwrite.", "remote_file_exists");
  }
  if (res.status === 413) {
    return codedError("File is too large for single-file transfer.", "payload_too_large");
  }
  return codedError(fallback, "request_failed");
}

export async function uploadLocalFile(
  client: FileTransferClient,
  localPath: string,
  remotePath: string,
  options: UploadOptions = {},
): Promise<{ ok: true; path: string; size: number }> {
  const resolvedLocal = expandLocalPath(localPath);
  let localStat;
  try {
    localStat = await stat(resolvedLocal);
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      throw codedError("Local file not found.", "local_file_not_found");
    }
    throw err;
  }
  if (!localStat.isFile()) {
    throw codedError("Local path must be a regular file.", "local_path_not_file");
  }

  const bytes = await readFile(resolvedLocal);
  const res = await fetch(blobUrl(client, remotePath, options, basename(resolvedLocal)), {
    method: "PUT",
    headers: authHeaders(client),
    body: new Blob([bytes]),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw await errorForResponse(res, "Upload failed.");
  }
  return (await res.json()) as { ok: true; path: string; size: number };
}

export async function downloadRemoteFile(
  client: FileTransferClient,
  remotePath: string,
  localPath: string,
  options: DownloadOptions = {},
): Promise<{ ok: true; path: string; size: number }> {
  const resolvedLocal = expandLocalPath(localPath);
  try {
    const existing = await lstat(resolvedLocal);
    if (existing.isSymbolicLink()) {
      throw codedError("Refusing to overwrite local symlink.", "local_symlink");
    }
    if (!options.force) {
      throw codedError("Local file already exists. Re-run with --force to overwrite.", "local_file_exists");
    }
  } catch (err: unknown) {
    if (
      !(err instanceof Error) ||
      !("code" in err) ||
      (err as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw err;
    }
  }

  const res = await fetch(blobUrl(client, remotePath), {
    headers: authHeaders(client),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw await errorForResponse(res, "Download failed.");
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  const parentDir = dirname(resolvedLocal);
  const directoryMode = options.secret ? 0o700 : 0o755;
  const missingParentDirs: string[] = [];
  for (let currentDir = parentDir; ; currentDir = dirname(currentDir)) {
    try {
      await lstat(currentDir);
      break;
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        missingParentDirs.push(currentDir);
        const nextDir = dirname(currentDir);
        if (nextDir === currentDir) {
          break;
        }
        continue;
      }
      throw err;
    }
  }
  await mkdir(parentDir, { recursive: true, mode: directoryMode });
  for (const createdDir of missingParentDirs.reverse()) {
    await chmod(createdDir, directoryMode);
  }
  const tmpPath = `${resolvedLocal}.matrix-download-${randomUUID()}.tmp`;
  const mode = options.secret ? 0o600 : 0o644;
  try {
    await writeFile(tmpPath, bytes, { flag: "wx", mode });
    await chmod(tmpPath, mode);
    await rename(tmpPath, resolvedLocal);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch (cleanupErr: unknown) {
      void cleanupErr;
    }
    throw err;
  }
  return { ok: true, path: resolvedLocal, size: bytes.byteLength };
}
