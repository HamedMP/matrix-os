/** Bounded JSON reads for responses from the platform and the bridge homeserver. */
export class BridgeResponseTooLargeError extends Error {
  constructor() {
    super("Bridge response too large");
    this.name = "BridgeResponseTooLargeError";
  }
}

export async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await cancelBody(response);
    throw new BridgeResponseTooLargeError();
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new BridgeResponseTooLargeError();
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (length === 0) return null;
  return JSON.parse(Buffer.concat(chunks, length).toString("utf8")) as unknown;
}

export async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch (err: unknown) {
    console.warn("[messages/bridge] response cleanup failed", err instanceof Error ? err.name : "UnknownError");
  }
}

export function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}
