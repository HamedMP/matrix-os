import { z } from "zod/v4";
import { BrowserDecisionProofSchema, BrowserDecisionTupleSchema, BrowserGrantRevokeTupleSchema, BrowserRevokeProofSchema,
  type BrowserDecisionTuple, type BrowserGrantRevokeTuple } from "@matrix-os/contracts";
/** Fixed configured Platform, bounded I/O; no host signing key or model endpoint. */
export function createBrowserApprovalPlatformClient(options: { platformUrl: string; handle: string; token: string; fetcher?: typeof fetch }) {
  const base = new URL(options.platformUrl);
  if (!/^https?:$/.test(base.protocol) || base.username || base.password || base.search || base.hash
    || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(options.handle) || !options.token) throw new Error("Browser approval unavailable");
  const endpoint = new URL(`/internal/containers/${options.handle}/browser-approvals/verify`, base).toString();
  async function verify<T extends z.ZodType>(kind: "decision" | "revoke", tuple: { handle: string }, proof: string, schema: T, callerSignal?: AbortSignal): Promise<z.infer<T>> {
    if (tuple.handle !== options.handle || proof.length > 4000) throw new Error("Browser approval unavailable");
    const signal = AbortSignal.any([AbortSignal.timeout(10_000), ...(callerSignal ? [callerSignal] : [])]);
    const response = await (options.fetcher ?? fetch)(endpoint, { method: "POST", redirect: "error", signal,
      headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json", "x-matrix-browser-approval-proof": proof }, body: JSON.stringify({ kind, tuple }) });
    if (!response.ok || !response.body || Number(response.headers.get("content-length")) > 4096) {
      await response.body?.cancel(); throw new Error("Browser approval unavailable");
    }
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    const abort = () => { void reader.cancel().catch(error => console.warn("[browser-approval] Response cancellation unavailable", error instanceof Error ? error.name : "UnknownError")); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      for (;;) { signal.throwIfAborted(); const next = await reader.read(); signal.throwIfAborted(); if (next.done) break;
        bytes += next.value.byteLength; if (bytes > 4096) { await reader.cancel(); throw new Error("Browser approval unavailable"); } chunks.push(next.value); }
      const envelope = z.strictObject({ verified: z.unknown() }).parse(JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")));
      const result = schema.parse(envelope.verified);
      // A network/fixture response must also match the requested tuple, not just its schema.
      if (!Object.entries(tuple).every(([key, field]) => (result as Record<string, unknown>)[key] === field)) throw new Error("Browser approval unavailable");
      return result;
    } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
  }
  return {
    verifyDecision: (tuple: BrowserDecisionTuple, proof: string, signal?: AbortSignal) => verify("decision", BrowserDecisionTupleSchema.parse(tuple), proof, BrowserDecisionProofSchema, signal),
    verifyRevoke: (tuple: BrowserGrantRevokeTuple, proof: string, signal?: AbortSignal) => verify("revoke", BrowserGrantRevokeTupleSchema.parse(tuple), proof, BrowserRevokeProofSchema, signal),
  };
}
