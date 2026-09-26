import type { R2Client } from "./r2-client.js";
import { awaitMirrorOperation } from "./home-mirror-abort.js";

export function createMirrorR2(client: R2Client, getSignal: () => AbortSignal): R2Client {
  const operationSignal = (signal?: AbortSignal) => signal
    ? AbortSignal.any([signal, getSignal()]) : getSignal();
  return {
    ...client,
    getObject: async (key, options) => {
      const signal = operationSignal(options?.signal);
      signal.throwIfAborted();
      const result = await awaitMirrorOperation(client.getObject(key, { signal }), signal);
      const body = result.body as unknown as { transformToByteArray?: () => Promise<Uint8Array>; getReader?: unknown; [Symbol.asyncIterator]?: unknown } | null;
      if (body?.transformToByteArray && !body.getReader && !body[Symbol.asyncIterator]) {
        return { ...result, body: {
          ...body,
          transformToByteArray: () => awaitMirrorOperation(body.transformToByteArray!(), signal),
          text: async () => Buffer.from(await awaitMirrorOperation(body.transformToByteArray!(), signal)).toString("utf8"),
        } as unknown as ReadableStream };
      }
      return result;
    },
    putObject: (key, body, options) => {
      const signal = operationSignal(options?.signal);
      signal.throwIfAborted();
      return awaitMirrorOperation(client.putObject(key, body, { signal }), signal);
    },
  };
}
