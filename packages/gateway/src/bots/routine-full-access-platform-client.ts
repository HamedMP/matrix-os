import { RoutineFullAccessProofSchema, RoutineFullAccessTupleSchema, ROUTINE_FULL_ACCESS_PROOF_HEADER,
  type RoutineFullAccessTuple } from "@matrix-os/contracts";
/** A separate verifier purpose; the Computer bearer is transport, never a consent signing key. */
export function createRoutineFullAccessPlatformClient(options: { platformUrl: string; handle: string; token: string; fetcher?: typeof fetch }) {
  const base = new URL(options.platformUrl);
  if (!/^https?:$/.test(base.protocol) || base.username || base.password || base.search || base.hash
    || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(options.handle) || !options.token) throw new Error("Routine origin unavailable");
  const endpoint = new URL(`/internal/containers/${options.handle}/routine-full-access/verify`, base).toString();
  return { async verify(raw: RoutineFullAccessTuple, proof: string) {
    const tuple = RoutineFullAccessTupleSchema.parse(raw);
    if (tuple.handle !== options.handle || !proof || proof.length > 4000) throw new Error("Routine origin unavailable");
    const signal = AbortSignal.timeout(10_000);
    const response = await (options.fetcher ?? fetch)(endpoint, { method: "POST", redirect: "error", signal,
      headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json", [ROUTINE_FULL_ACCESS_PROOF_HEADER]: proof }, body: JSON.stringify(tuple) });
    if (!response.ok || !response.body || Number(response.headers.get("content-length")) > 4096) {
      await response.body?.cancel(); throw new Error("Routine origin unavailable");
    }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
    const abort = () => { void reader.cancel().catch(error => console.warn("[routine-origin] Response cancellation unavailable", error instanceof Error ? error.name : "UnknownError")); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      for (;;) {
        signal.throwIfAborted(); const next = await reader.read(); signal.throwIfAborted(); if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 4096) { await reader.cancel(); throw new Error("Routine origin unavailable"); }
        chunks.push(next.value);
      }
      const raw: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
      if (!raw || typeof raw !== "object" || Object.keys(raw).length !== 1 || !("verified" in raw)) throw new Error("Routine origin unavailable");
      const verified = RoutineFullAccessProofSchema.parse(raw.verified);
      if (!Object.entries(tuple).every(([key, value]) => verified[key as keyof typeof verified] === value)
        || verified.expiresAt <= Date.now() || verified.expiresAt > Date.now() + 60_000) throw new Error("Routine origin unavailable");
      return verified;
    } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
  } };
}
