import { awaitMirrorOperation } from "./home-mirror-abort.js";

/** Keep the request deadline alive through consumption, with native receivers intact. */
export function boundMirrorBody<T extends object>(body: T, signal: AbortSignal): T {
  const cleanupFailure = (error: unknown) => console.warn("[home-mirror] body cleanup failed", error instanceof Error ? "error" : "non-error");
  const observeCleanup = (operation: unknown) => { void Promise.resolve(operation).catch(cleanupFailure); };
  const destroy = () => {
    const method: unknown = Reflect.get(body, "destroy", body);
    if (typeof method === "function") Reflect.apply(method, body, []);
  };
  function consumer<TConsumer extends object>(target: TConsumer, read: string, cancel: string): TConsumer {
    let cleaned = false;
    const detach = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      if (cleaned) return;
      cleaned = true; detach();
      try {
        const method: unknown = Reflect.get(target, cancel, target);
        if (typeof method === "function") observeCleanup(Reflect.apply(method, target, []));
        destroy();
      } catch (error: unknown) { cleanupFailure(error); }
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    return new Proxy(target, {
      get(receiver, property) {
        const method: unknown = Reflect.get(receiver, property, receiver);
        if (typeof method !== "function") return method;
        if (property === read) return async (...args: unknown[]) => {
          signal.throwIfAborted();
          try {
            const result = await awaitMirrorOperation(Promise.resolve(Reflect.apply(method, receiver, args)), signal);
            signal.throwIfAborted();
            if (result && typeof result === "object" && "done" in result && result.done) { cleaned = true; detach(); }
            return result;
          } catch (error: unknown) { abort(); throw error; }
        };
        if (property === cancel || property === "releaseLock" || property === "throw") return (...args: unknown[]) => {
          cleaned = true; detach(); return Reflect.apply(method, receiver, args);
        };
        return method.bind(receiver);
      },
    });
  }
  return new Proxy(body, {
    get(target, property) {
      const method: unknown = Reflect.get(target, property, target);
      if (typeof method !== "function") return method;
      if (property === Symbol.asyncIterator) return (...args: unknown[]) => consumer(Reflect.apply(method, target, args) as object, "next", "return");
      if (property === "getReader") return (...args: unknown[]) => consumer(Reflect.apply(method, target, args) as object, "read", "cancel");
      if (property === "stream") return (...args: unknown[]) => boundMirrorBody(Reflect.apply(method, target, args) as object, signal);
      if (["transformToByteArray", "transformToString", "text"].includes(String(property))) return async (...args: unknown[]) => {
        signal.throwIfAborted();
        signal.addEventListener("abort", destroy, { once: true });
        try { return await awaitMirrorOperation(Promise.resolve(Reflect.apply(method, target, args)), signal); }
        finally { signal.removeEventListener("abort", destroy); }
      };
      return method.bind(target);
    },
  });
}
