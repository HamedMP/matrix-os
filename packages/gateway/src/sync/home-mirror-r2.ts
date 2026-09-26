import { R2_READ_TIMEOUT_MS, R2_WRITE_TIMEOUT_MS, type R2Client } from "./r2-client.js";
import { boundMirrorBody } from "./home-mirror-r2-body.js";
import { awaitMirrorOperation } from "./home-mirror-abort.js";

export function createMirrorR2(client: R2Client, getSignal: () => AbortSignal): R2Client {
  const operationSignal = (defaultTimeout: number, signal?: AbortSignal) =>
    AbortSignal.any([AbortSignal.timeout(defaultTimeout), getSignal(), ...(signal ? [signal] : [])]);
  return {
    ...client,
    getObject: async (key, options) => {
      const signal = operationSignal(R2_READ_TIMEOUT_MS, options?.signal);
      signal.throwIfAborted();
      const result = await awaitMirrorOperation(client.getObject(key, { signal }), signal);
      const body = result.body;
      if (body) return { ...result, body: boundMirrorBody(body, signal) };
      return result;
    },
    putObject: (key, body, options) => {
      const signal = operationSignal(R2_WRITE_TIMEOUT_MS, options?.signal);
      signal.throwIfAborted();
      return awaitMirrorOperation(client.putObject(key, body, {
        signal,
        ...(options?.contentLength !== undefined ? { contentLength: options.contentLength } : {}),
      }), signal);
    },
  };
}
