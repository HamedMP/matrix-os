import { z } from "zod/v4";
import type { FundedFinalization } from "./funded-relay-usage.js";

const MAX_REJECTION_BYTES = 16 * 1024;
const REJECTION_TIMEOUT_MS = 1_000;
const AnthropicRateLimitSchema = z.strictObject({
  type: z.literal("error"),
  error: z.strictObject({ type: z.literal("rate_limit_error"), message: z.string().max(MAX_REJECTION_BYTES) }),
  request_id: z.string().max(256).optional(),
});

/** Only a complete pre-stream Anthropic admission rejection establishes zero
 * generation usage. HTTP 200 SSE errors and ambiguous provider failures remain
 * conservative. The model/path come from the Relay's validated fixed route,
 * never from a client error claim. See https://platform.claude.com/docs/en/api/errors.
 * This discards the private error body without forwarding or logging it.
 */
export async function classifyFundedUpstreamRejection(input: {
  upstream: Response;
  canonicalModelId: string;
  requestPath: string;
  signal: AbortSignal;
}): Promise<FundedFinalization> {
  const { upstream } = input;
  const reader = upstream.body?.getReader();
  if (!reader) return { mode: "conservative" };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let signal: AbortSignal | undefined;
  try {
    if (input.requestPath !== "/v1/messages"
      || input.canonicalModelId !== "anthropic/claude-sonnet-5"
      || upstream.status !== 429
      || upstream.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
      || input.signal.aborted) return { mode: "conservative" };
    const declaredLength = upstream.headers.get("content-length");
    if (declaredLength !== null && (!/^\d+$/.test(declaredLength)
      || Number(declaredLength) > MAX_REJECTION_BYTES)) return { mode: "conservative" };
    const deadline = new AbortController();
    timeout = setTimeout(() => deadline.abort(new DOMException("Rejection body timed out", "TimeoutError")), REJECTION_TIMEOUT_MS);
    const readSignal = AbortSignal.any([input.signal, deadline.signal]);
    signal = readSignal;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(readSignal.reason);
      if (readSignal.aborted) onAbort();
      else readSignal.addEventListener("abort", onAbort, { once: true });
    });
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    let text = "";
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_REJECTION_BYTES) return { mode: "conservative" };
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    if (signal.aborted) return { mode: "conservative" };
    // Unknown envelope fields may contain usage or partial output evidence.
    // Retain conservative accounting until that response shape is reviewed.
    const parsed = AnthropicRateLimitSchema.safeParse(JSON.parse(text) as unknown);
    return parsed.success ? { mode: "exact", actualCostMicrousd: 0 } : { mode: "conservative" };
  } catch (error) {
    // Parse, transport, abort and deadline failures are all unknown usage; no
    // upstream text or provider details are retained in diagnostic output.
    console.warn("[proxy] Funded AI rejection evidence unavailable", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return { mode: "conservative" };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    // A broken provider stream's cancel promise may never resolve. Discard it
    // best-effort without allowing rejection classification to hold admission.
    void reader.cancel("upstream rejected request").catch((error: unknown) => {
      console.warn("[proxy] Funded AI rejection body cancellation failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    });
    reader.releaseLock();
  }
}
