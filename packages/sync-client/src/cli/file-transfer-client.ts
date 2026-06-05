import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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

export function expandLocalPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

function blobUrl(client: FileTransferClient, remotePath: string, options: UploadOptions = {}): string {
  const url = new URL("/api/files/blob", client.gatewayUrl);
  url.searchParams.set("path", remotePath);
  if (options.force) url.searchParams.set("force", "true");
  if (options.secret) url.searchParams.set("secret", "true");
  return url.toString();
}

function authHeaders(client: FileTransferClient): Record<string, string> {
  return { authorization: `Bearer ${client.token}` };
}

function errorForResponse(res: Response, fallback: string): Error {
  if (res.status === 401 || res.status === 403) {
    return codedError("Auth token rejected or expired. Run `matrix login` again.", "auth_rejected");
  }
  if (res.status === 404) {
    return codedError("Remote file not found.", "remote_file_not_found");
  }
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
  const res = await fetch(blobUrl(client, remotePath, options), {
    method: "PUT",
    headers: authHeaders(client),
    body: new Blob([bytes]),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw errorForResponse(res, "Upload failed.");
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
    throw errorForResponse(res, "Download failed.");
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(resolvedLocal), { recursive: true, mode: options.secret ? 0o700 : 0o755 });
  const tmpPath = `${resolvedLocal}.matrix-download-${randomUUID()}.tmp`;
  const mode = options.secret ? 0o600 : 0o644;
  try {
    await writeFile(tmpPath, bytes, { flag: "wx", mode });
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
