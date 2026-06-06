import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
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

export interface DownloadFileOptions {
  expectedSize?: number;
  maxBytes?: number;
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
  options: DownloadFileOptions = {},
): Promise<void> {
  const res = await fetch(presignedUrl, {
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(`Download failed: ${res.status}`);
  }

  const contentLength = Number(res.headers.get("content-length") ?? "");
  if (
    options.maxBytes !== undefined &&
    Number.isFinite(contentLength) &&
    contentLength > options.maxBytes
  ) {
    throw new Error(`Downloaded content exceeded ${options.maxBytes} bytes`);
  }
  await mkdir(dirname(localPath), { recursive: true, mode: 0o700 });
  const tmpPath = `${localPath}.matrixos-${randomUUID()}.tmp`;
  try {
    const { size, hash } = await writeResponseBodyToTempFile(res, tmpPath, options);
    if (options.expectedSize !== undefined && size !== options.expectedSize) {
      throw new Error("Downloaded content size did not match expected size");
    }
    if (expectedHash && hash !== expectedHash) {
      throw new Error("Downloaded content hash did not match expected hash");
    }
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

async function writeResponseBodyToTempFile(
  res: Response,
  tmpPath: string,
  options: DownloadFileOptions,
): Promise<{ size: number; hash: string }> {
  const hash = createHash("sha256");
  let size = 0;
  const writer = createWriteStream(tmpPath, {
    flags: "wx",
    mode: 0o600,
  });
  let writerFailure: unknown;
  const recordWriterError = (err: unknown): void => {
    writerFailure = err;
  };
  writer.on("error", recordWriterError);
  const writerClosed = new Promise<void>((resolve) => {
    writer.once("close", resolve);
  });

  const waitForWriterEvent = (event: "drain" | "finish"): Promise<void> => {
    if (writerFailure) {
      return Promise.reject(writerFailure);
    }
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        writer.off(event, onEvent);
        writer.off("error", onError);
      };
      const onEvent = () => {
        cleanup();
        resolve();
      };
      const onError = (err: unknown) => {
        cleanup();
        reject(err);
      };
      writer.once(event, onEvent);
      writer.once("error", onError);
    });
  };

  const writeChunk = async (chunk: Uint8Array): Promise<void> => {
    size += chunk.byteLength;
    if (options.maxBytes !== undefined && size > options.maxBytes) {
      throw new Error(`Downloaded content exceeded ${options.maxBytes} bytes`);
    }
    hash.update(chunk);
    if (!writer.write(chunk)) {
      await waitForWriterEvent("drain");
    }
  };

  try {
    if (!res.body) {
      const buffer = Buffer.from(await res.arrayBuffer());
      await writeChunk(buffer);
    } else {
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            await writeChunk(value);
          }
        }
      } finally {
        reader.releaseLock();
      }
    }
    const finished = waitForWriterEvent("finish");
    writer.end();
    await finished;
    await writerClosed;
  } catch (err: unknown) {
    writer.destroy();
    await writerClosed;
    throw err;
  } finally {
    writer.off("error", recordWriterError);
  }

  return {
    size,
    hash: `sha256:${hash.digest("hex")}`,
  };
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
