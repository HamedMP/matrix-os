import type { R2Client } from "./r2-client.js";

const INTERNAL_SYNC_READ_TIMEOUT_MS = 10_000;
const INTERNAL_SYNC_WRITE_TIMEOUT_MS = 30_000;

function noSuchKey(): Error {
  const err = new Error("NoSuchKey");
  err.name = "NoSuchKey";
  return err;
}

export function createPlatformR2Client(config: {
  baseUrl: string;
  handle: string;
  token: string;
}): R2Client {
  const routeBase = `${config.baseUrl}/internal/containers/${config.handle}/sync`;

  async function request(
    path: string,
    init?: RequestInit,
    timeoutMs = INTERNAL_SYNC_READ_TIMEOUT_MS,
  ): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${config.token}`);
    const res = await fetch(`${routeBase}${path}`, {
      ...init,
      headers,
      signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
    });
    return res;
  }

  async function expectJson<T>(res: Response): Promise<T> {
    if (!res.ok) {
      if (res.status === 404) throw noSuchKey();
      throw new Error(`Internal sync request failed: ${res.status}`);
    }
    return (await res.json()) as T;
  }

  return {
    async getPresignedGetUrl(key: string, expiresIn?: number): Promise<string> {
      const res = await request("/presign/get", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, expiresIn }),
      });
      return (await expectJson<{ url: string }>(res)).url;
    },

    async getPresignedPutUrl(key: string, size: number, expiresIn?: number): Promise<string> {
      const res = await request("/presign/put", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, size, expiresIn }),
      });
      return (await expectJson<{ url: string }>(res)).url;
    },

    async createMultipartUpload(key: string): Promise<string> {
      const res = await request("/multipart/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key }),
      });
      return (await expectJson<{ uploadId: string }>(res)).uploadId;
    },

    async getPresignedPartUrl(
      key: string,
      uploadId: string,
      partNumber: number,
      expiresIn?: number,
    ): Promise<string> {
      const res = await request("/multipart/part", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, uploadId, partNumber, expiresIn }),
      });
      return (await expectJson<{ url: string }>(res)).url;
    },

    async getObject(
      key: string,
      options?: { signal?: AbortSignal },
    ): Promise<{ body: ReadableStream | null; etag?: string; contentLength?: number }> {
      const res = await request(`/object?key=${encodeURIComponent(key)}`, { signal: options?.signal });
      if (res.status === 404) {
        throw noSuchKey();
      }
      if (!res.ok) {
        throw new Error(`Internal sync request failed: ${res.status}`);
      }
      return {
        body: (res.body as ReadableStream | null) ?? null,
        etag: res.headers.get("etag") ?? undefined,
        contentLength: Number(res.headers.get("content-length") ?? "") || undefined,
      };
    },

    async putObject(
      key: string,
      body: string | Uint8Array | ReadableStream<Uint8Array>,
      options?: { signal?: AbortSignal },
    ): Promise<{ etag?: string }> {
      const res = await request(`/object?key=${encodeURIComponent(key)}`, {
        method: "PUT",
        body: body instanceof Uint8Array ? Buffer.from(body) : body,
        signal: options?.signal,
      }, INTERNAL_SYNC_WRITE_TIMEOUT_MS);
      const data = await expectJson<{ etag: string | null }>(res);
      return { etag: data.etag ?? undefined };
    },

    async deleteObject(key: string): Promise<void> {
      const res = await request(`/object?key=${encodeURIComponent(key)}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`Internal sync request failed: ${res.status}`);
      }
    },

    destroy(): void {
      // no-op: uses global fetch
    },
  };
}
