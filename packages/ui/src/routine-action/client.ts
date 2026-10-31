import { z } from "zod/v4";
import { ROUTINE_ACTION_PATH, RoutineActionIdSchema, RoutineActionViewSchema, RoutineActionSubmitSchema,
  type RoutineActionSubmit } from "@matrix-os/contracts";
export type RoutineActionRequest = (input: { path: string; method: "GET" | "POST"; body?: RoutineActionSubmit; signal: AbortSignal }) => Promise<unknown>;
export function createRoutineActionClient(request: RoutineActionRequest) {
  if (typeof request !== "function") throw new Error("Routine confirmation unavailable");
  return {
    read: async (id: string, signal: AbortSignal) => RoutineActionViewSchema.parse(await request({ path: `${ROUTINE_ACTION_PATH}/${RoutineActionIdSchema.parse(id)}`, method: "GET", signal })),
    list: async (signal: AbortSignal) => z.strictObject({ challenges: z.array(RoutineActionViewSchema).max(128) }).parse(await request({ path: ROUTINE_ACTION_PATH, method: "GET", signal })).challenges,
    submit: async (id: string, body: RoutineActionSubmit, signal: AbortSignal) => z.strictObject({ submission: z.enum(["accepted", "already_submitted"]) }).parse(await request({
      path: `${ROUTINE_ACTION_PATH}/${RoutineActionIdSchema.parse(id)}/decision`, method: "POST", body: RoutineActionSubmitSchema.parse(body), signal,
    })),
  };
}
export type RoutineActionClient = ReturnType<typeof createRoutineActionClient>;
/** Browser adapter with bounded body/timeout. Credentials are normal owner routing only; Platform supplies the stronger proof. */
export function createRoutineActionBrowserClient(gatewayUrl: string, getToken: () => Promise<string | null>, fetcher: typeof fetch = fetch) {
  const gateway = new URL(gatewayUrl);
  if (!/^https?:$/.test(gateway.protocol) || gateway.username || gateway.password || gateway.search || gateway.hash) throw new Error("Routine confirmation unavailable");
  const base = gateway.toString().replace(/\/$/, "");
  return createRoutineActionClient(async input => {
    // RN's AbortSignal does not implement throwIfAborted. Own one portable scope,
    // including the token wait, and drain its timer/listeners on every exit.
    if (input.signal.aborted) throw new Error("Routine confirmation unavailable");
    const controller = new AbortController(), signal = controller.signal;
    const cancel = () => controller.abort();
    input.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, 10_000);
    let rejectAbort!: (error: Error) => void;
    const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(new Error("Routine confirmation unavailable"));
    signal.addEventListener("abort", onAbort, { once: true });
    const requireLive = () => { if (signal.aborted) throw new Error("Routine confirmation unavailable"); };
    try {
      const token = await Promise.race([getToken(), cancelled]); requireLive();
      const response = await Promise.race([fetcher(base + input.path, { method: input.method, credentials: "same-origin", redirect: "error", signal,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(input.body ? { "content-type": "application/json" } : {}) },
        ...(input.body ? { body: JSON.stringify(input.body) } : {}) }), cancelled]);
      requireLive();
      if (!response.ok || !response.body || Number(response.headers.get("content-length")) > 128 * 1024) {
        await response.body?.cancel(); throw new Error("Routine confirmation unavailable");
      }
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
      const abortRead = () => { void reader.cancel().catch(error => console.warn("[routine-action] Read cancelled", error instanceof Error ? error.name : "UnknownError")); };
      signal.addEventListener("abort", abortRead, { once: true });
      try {
        for (;;) { requireLive(); const chunk = await Promise.race([reader.read(), cancelled]); requireLive(); if (chunk.done) break;
          bytes += chunk.value.byteLength; if (bytes > 128 * 1024) { await reader.cancel(); throw new Error("Routine confirmation unavailable"); } chunks.push(chunk.value); }
        const data = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
        return JSON.parse(new TextDecoder().decode(data));
      } finally { signal.removeEventListener("abort", abortRead); reader.releaseLock(); }
    } finally {
      clearTimeout(timer); input.signal.removeEventListener("abort", cancel); signal.removeEventListener("abort", onAbort);
    }
  });
}
