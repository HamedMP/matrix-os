import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, writeFile, mkdir, stat, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export interface PresignedUrl {
  path: string;
  url: string;
  expiresIn: number;
}

export interface GatewayClient {
  gatewayUrl: string;
  token: string;
}

export class AuthRejectedError extends Error {
  constructor(message = "Auth token rejected or expired. Re-run `matrixos login`.") {
    super(message);
    this.name = "AuthRejectedError";
  }
}

export class VersionConflictError extends Error {
  currentVersion: number;

  constructor(expectedVersion: number, currentVersion: number) {
    super(`Version conflict: expected ${expectedVersion}, server at ${currentVersion}`);
    this.name = "VersionConflictError";
    this.currentVersion = currentVersion;
  }
}

export async function requestPresignedUrls(
  client: GatewayClient,
  files: { path: string; action: "put" | "get"; hash?: string; size?: number }[],
): Promise<PresignedUrl[]> {
  const res = await fetch(`${client.gatewayUrl}/api/sync/presign`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: `Bearer ${client.token}`,
    },
    body: JSON.stringify({ files }),
    signal: AbortSignal.timeout(10_000),
  });

  if (res.status === 401 || res.status === 403) {
    throw new AuthRejectedError();
  }

  if (!res.ok) {
    throw new Error(`Presign request failed: ${res.status}`);
  }

  const data = (await res.json()) as { urls: PresignedUrl[] };
  return data.urls;
}

export async function uploadFile(
  presignedUrl: string,
  localPath: string,
): Promise<void> {
  const fileContent = await readFile(localPath);
  const fileStat = await stat(localPath);

  const res = await fetch(presignedUrl, {
    method: "PUT",
    body: fileContent,
    headers: {
      "Content-Length": String(fileStat.size),
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(`Upload failed: ${res.status}`);
  }
}

export async function downloadFile(
  presignedUrl: string,
  localPath: string,
  expectedHash?: string,
): Promise<void> {
  const res = await fetch(presignedUrl, {
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(`Download failed: ${res.status}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (expectedHash) {
    const actualHash = `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
    if (actualHash !== expectedHash) {
      throw new Error("Downloaded content hash did not match expected hash");
    }
  }
  await mkdir(dirname(localPath), { recursive: true, mode: 0o700 });
  const tmpPath = `${localPath}.matrixos-${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, buffer, { flag: "wx", mode: 0o600 });
    try {
      const localStat = await lstat(localPath);
      if (localStat.isSymbolicLink()) {
        throw new Error("refusing to overwrite symlink");
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
    await rename(tmpPath, localPath);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch (cleanupErr) {
      if (
        !(cleanupErr instanceof Error) ||
        !("code" in cleanupErr) ||
        (cleanupErr as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw cleanupErr;
      }
    }
    throw err;
  }
}

export async function commitFiles(
  client: GatewayClient,
  files: { path: string; hash: string; size: number; action?: "delete" }[],
  expectedVersion: number,
): Promise<{ manifestVersion: number; committed: number }> {
  const res = await fetch(`${client.gatewayUrl}/api/sync/commit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: `Bearer ${client.token}`,
    },
    body: JSON.stringify({ files, expectedVersion }),
    signal: AbortSignal.timeout(10_000),
  });

  if (res.status === 401 || res.status === 403) {
    throw new AuthRejectedError();
  }

  if (res.status === 409) {
    const data = (await res.json()) as { error: string; currentVersion: number };
    throw new VersionConflictError(expectedVersion, data.currentVersion);
  }

  if (!res.ok) {
    throw new Error(`Commit failed: ${res.status}`);
  }

  return (await res.json()) as { manifestVersion: number; committed: number };
}

export async function fetchManifest(client: GatewayClient): Promise<{
  manifest: unknown;
  etag: string | null;
}> {
  const res = await fetch(`${client.gatewayUrl}/api/sync/manifest`, {
    headers: {
      authorization: `Bearer ${client.token}`,
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (res.status === 401 || res.status === 403) {
    throw new AuthRejectedError();
  }

  if (!res.ok) {
    throw new Error(`Manifest fetch failed: ${res.status}`);
  }

  return {
    manifest: await res.json(),
    etag: res.headers.get("etag"),
  };
}
