import { z } from "zod/v4";
import type { HermesGatewayEvent } from "./hermes-stdio-client.js";

const Route = z.object({
  provider: z.string().min(1).max(80),
  model: z.string().min(1).max(160),
  lazy: z.boolean().optional(),
}).passthrough();

/** session.info reports the built native route; session.create only acknowledges the requested route. */
export function createHermesSelectedRouteGate(selected: { provider: string; model: string }) {
  let sessionId: string | undefined;
  let latest: { sessionId: string; provider: string; model: string } | undefined;
  let watching = false;
  let failed = false;
  let changed: (() => void) | undefined;
  const mismatch = () => latest !== undefined && latest.sessionId === sessionId
    && (latest.provider !== selected.provider || latest.model !== selected.model);
  const failure = () => new Error("The selected native route was not confirmed");
  return {
    fail() {
      failed = true;
      changed?.();
    },
    setSession(id: string, reset: boolean) {
      sessionId = id;
      if (reset) latest = undefined;
    },
    observe(event: HermesGatewayEvent) {
      if (event.type !== "session.info" || !event.session_id || (sessionId && event.session_id !== sessionId)) return;
      const parsed = Route.safeParse(event.payload);
      if (!parsed.success || parsed.data.lazy === true) return;
      latest = { sessionId: event.session_id, provider: parsed.data.provider, model: parsed.data.model };
      changed?.();
      if (watching && mismatch()) throw failure();
    },
    async ready(signal: AbortSignal, timeoutMs: number) {
      signal.throwIfAborted();
      if (failed) throw failure();
      watching = true;
      if (mismatch()) throw failure();
      if (latest?.sessionId === sessionId) return;
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const cleanup = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          changed = undefined;
        };
        const abort = () => { cleanup(); reject(failure()); };
        changed = () => {
          cleanup();
          if (failed || mismatch()) reject(failure());
          else resolve();
        };
        timer = setTimeout(abort, timeoutMs);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    },
  };
}
