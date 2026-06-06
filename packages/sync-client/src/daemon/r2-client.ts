import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, readFile, writeFile, mkdir, stat, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

const MULTIPART_COMPLETE_TIMEOUT_MS = 60_000;

export interface MultipartInfo {
  uploadId: string;
  partUrls: string[];
  partSize: number;
}

export interface PresignedUrl {
  path: string;
  url: string;
  expiresIn: number;
  multipart?: MultipartInfo;
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

export interface MultipartUploadedPart {
  partNumber: number;
  etag: string;
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

export async function completeMultipartUpload(
  client: GatewayClient,
  path: string,
  uploadId: string,
  parts: MultipartUploadedPart[],
): Promise<void> {
  const res = await fetch(`${client.gatewayUrl}/api/sync/multipart/complete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: `Bearer ${client.token}`,
    },
    body: JSON.stringify({ path, uploadId, parts }),
    signal: AbortSignal.timeout(MULTIPART_COMPLETE_TIMEOUT_MS),
  });

  if (res.status === 401 || res.status === 403) {
    throw new AuthRejectedError();
  }

  if (!res.ok) {
    throw new Error(`Multipart completion failed: ${res.status}`);
  }
}

export async function abortMultipartUpload(
  client: GatewayClient,
  path: string,
  uploadId: string,
): Promise<void> {
  const res = await fetch(`${client.gatewayUrl}/api/sync/multipart/abort`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: `Bearer ${client.token}`,
    },
    body: JSON.stringify({ path, uploadId }),
    signal: AbortSignal.timeout(10_000),
  });

  if (res.status === 401 || res.status === 403) {
    throw new AuthRejectedError();
  }

  if (!res.ok) {
    throw new Error(`Multipart abort failed: ${res.status}`);
  }
}

async function uploadMultipartFile(
  client: GatewayClient,
  presigned: PresignedUrl & { multipart: MultipartInfo },
  localPath: string,
): Promise<void> {
  const fileStat = await stat(localPath);
  const { multipart } = presigned;
  if (multipart.partSize <= 0) {
    throw new Error("Multipart upload returned an invalid part size");
  }
  const expectedPartCount = Math.ceil(fileStat.size / multipart.partSize);
  if (multipart.partUrls.length !== expectedPartCount) {
    throw new Error("Multipart upload returned the wrong number of part URLs");
  }

  const parts: MultipartUploadedPart[] = [];
  try {
    for (const [index, partUrl] of multipart.partUrls.entries()) {
      const partNumber = index + 1;
      const start = index * multipart.partSize;
      const endExclusive = Math.min(fileStat.size, start + multipart.partSize);
      const contentLength = endExclusive - start;
      const res = await fetch(partUrl, {
        method: "PUT",
        body: createReadStream(localPath, {
          start,
          end: endExclusive - 1,
        }) as unknown as BodyInit,
        headers: {
          "Content-Length": String(contentLength),
        },
        signal: AbortSignal.timeout(30_000),
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      if (!res.ok) {
        throw new Error(`Upload failed: ${res.status}`);
      }
      const etag = res.headers.get("etag");
      if (!etag) {
        throw new Error("Multipart upload part did not return an ETag");
      }
      parts.push({ partNumber, etag });
    }

    await completeMultipartUpload(
      client,
      presigned.path,
      multipart.uploadId,
      parts,
    );
  } catch (err: unknown) {
    try {
      await abortMultipartUpload(client, presigned.path, multipart.uploadId);
    } catch (abortErr: unknown) {
      console.warn(
        "[sync-client] Failed to abort multipart upload after upload failure:",
        abortErr instanceof Error ? abortErr.message : String(abortErr),
      );
    }
    throw err;
  }
}

export async function uploadFile(
  presignedUrl: string | PresignedUrl,
  localPath: string,
  client?: GatewayClient,
): Promise<void> {
  if (typeof presignedUrl !== "string" && presignedUrl.multipart) {
    if (!client) {
      throw new Error("Gateway client is required for multipart uploads");
    }
    await uploadMultipartFile(
      client,
      presignedUrl as PresignedUrl & { multipart: MultipartInfo },
      localPath,
    );
    return;
  }
  const uploadUrl = typeof presignedUrl === "string" ? presignedUrl : presignedUrl.url;
  if (!uploadUrl) {
    throw new Error("Presigned upload URL is empty");
  }
  const fileContent = await readFile(localPath);
  const fileStat = await stat(localPath);

  const res = await fetch(uploadUrl, {
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
    const err = new Error(`Downloaded content exceeded ${options.maxBytes} bytes`);
    await res.body?.cancel(err);
    throw err;
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
      let streamFinished = false;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            streamFinished = true;
            break;
          }
          if (value) {
            await writeChunk(value);
          }
        }
      } catch (err: unknown) {
        if (!streamFinished) {
          await reader.cancel(err);
        }
        throw err;
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
