import { R2_READ_TIMEOUT_MS, R2_WRITE_TIMEOUT_MS, type R2Client } from "./r2-client.js";
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
      if (body) {
        const wrapped = new Proxy(body, {
          get(target, property) {
            const value: unknown = Reflect.get(target, property, target);
            if (typeof value !== "function") return value;
            if (["transformToByteArray", "transformToString", "text"].includes(String(property))) {
              return async (...args: unknown[]) => {
                signal.throwIfAborted();
                const destroy: unknown = Reflect.get(target, "destroy", target);
                const cancel = () => { if (typeof destroy === "function") Reflect.apply(destroy, target, []); };
                signal.addEventListener("abort", cancel, { once: true });
                try { return await awaitMirrorOperation(Promise.resolve(Reflect.apply(value, target, args)), signal); }
                finally { signal.removeEventListener("abort", cancel); }
              };
            }
            // Native streams require their real receiver, including prototype methods.
            return value.bind(target);
          },
        });
        return { ...result, body: wrapped };
      }
      return result;
    },
    putObject: (key, body, options) => {
      const signal = operationSignal(R2_WRITE_TIMEOUT_MS, options?.signal);
      signal.throwIfAborted();
      return awaitMirrorOperation(client.putObject(key, body, { signal }), signal);
    },
  };
}
