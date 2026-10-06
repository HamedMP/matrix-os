import { createHash } from "node:crypto";
export class MemoryEngineError extends Error {
  constructor() {
    super("Memory engine unavailable");
  }
}
export const ownerNamespace = (owner: string) =>
  createHash("sha256").update(owner).digest("hex").slice(0, 32);
export type EngineFetch = typeof fetch;
/** Operator-only numeric loopback URLs avoid DNS and redirect based SSRF entirely. */
export function localEngineUrl(value: string): URL {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new MemoryEngineError();
  return url;
}
export function createEngineHttp(
  base: string,
  key: string | undefined,
  fetcher: EngineFetch = fetch,
) {
  const origin = localEngineUrl(base);
  return async function request(
    path: string,
    init: RequestInit,
    signal: AbortSignal,
    allowMissing = false,
  ): Promise<unknown> {
    const response = await fetcher(new URL(path, origin), {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(100000)]),
      headers: {
        ...(key ? { Authorization: `Bearer ${key}`, "X-API-Key": key } : {}),
        ...init.headers,
      },
    });
    if (allowMissing && response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new MemoryEngineError();
    }
    const reader = response.body?.getReader();
    if (!reader) throw new MemoryEngineError();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const r = await reader.read();
        if (r.done) break;
        bytes += r.value.length;
        if (bytes > 2000000) {
          await reader.cancel();
          throw new MemoryEngineError();
        }
        chunks.push(r.value);
      }
    } finally {
      reader.releaseLock();
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) throw new MemoryEngineError();
      throw error;
    }
  };
}
