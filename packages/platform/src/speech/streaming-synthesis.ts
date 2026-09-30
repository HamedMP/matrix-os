import { createHmac } from "node:crypto";
import { SPEECH_MAX_SYNTHESIS_AUDIO_BYTES, SpeechSynthesisRequestSchema } from "@matrix-os/contracts";
import { SpeechAdapterError, type SpeechSynthesisAdapter } from "./adapters/openai.js";
import { SpeechFundingError } from "./funding.js";
import { SpeechOperationConflictError, SpeechOperationRateLimitError, type SpeechOperationIdentity, type SpeechOperationRecord, type SpeechOperationsRepository } from "./operations.js";
import { SpeechServiceError, type PlatformSpeechPolicy, type SpeechFundingPort } from "./service.js";

export interface SynthesisInput { identity: SpeechOperationIdentity; requestId: string; text: string; signal: AbortSignal }
export interface SynthesisScope { controller: AbortController; signal: AbortSignal; stop(): void; release(): void }
function cost(durationMs: number, price: number): number {
  const result = Math.ceil(durationMs * price / 60_000);
  if (!Number.isSafeInteger(result)) throw new SpeechServiceError("unavailable");
  return result;
}

/** One lifecycle for both APIs. Repository callbacks own the existing wallet transactions.
 * Yield suspension is not completion: return/disconnect after a claim settles conservatively.
 */
export async function* executeSpeechSynthesis(options: {
  operations: SpeechOperationsRepository; funding: SpeechFundingPort;
  adapter: SpeechSynthesisAdapter | undefined; policy: PlatformSpeechPolicy; fingerprintSecret: string;
  enter(input: SynthesisInput): SynthesisScope;
}, input: SynthesisInput, streaming: boolean): AsyncGenerator<Uint8Array, number> {
  const synthesis = options.policy.synthesis;
  const adapter = options.adapter;
  if (!options.policy.enabled || !synthesis?.enabled || !adapter || (streaming && !adapter.stream)) throw new SpeechServiceError("unavailable");
  const parsed = SpeechSynthesisRequestSchema.safeParse({ requestId: input.requestId, text: input.text });
  if (!parsed.success || [...parsed.data.text].length > synthesis.maxInputChars) throw new SpeechServiceError("invalid_request");
  const request = parsed.data;
  const scope = options.enter(input);
  const { controller, signal } = scope;
  const maximumCostMicrousd = cost(synthesis.maxDurationMs, synthesis.microusdPerMinute);
  let admitted: SpeechOperationRecord | undefined;
  let ownsDispatch = false;
  let finalized = false;
  let failed = false;
  let failure: unknown;
  try {
    try {
      admitted = await options.operations.admitSynthesis({
        identity: input.identity, requestId: request.requestId,
        contentFingerprint: createHmac("sha256", options.fingerprintSecret).update(`synthesis\0${options.policy.revision}\0${request.text}`, "utf8").digest("hex"),
        policyRevision: options.policy.revision, adapterId: adapter.id, modelId: synthesis.modelId, maximumCostMicrousd,
      }, (trx) => options.funding.reserve(trx, { identity: input.identity, requestId: request.requestId, policyRevision: options.policy.revision, modelId: synthesis.modelId, maximumCostMicrousd, capability: "synthesis" }));
    } catch (error: unknown) {
      if (error instanceof SpeechOperationRateLimitError) throw new SpeechServiceError("rate_limited");
      if (error instanceof SpeechOperationConflictError) throw new SpeechServiceError("request_conflict");
      if (error instanceof SpeechFundingError) throw new SpeechServiceError(error.code);
      throw error;
    }
    if (admitted.cancellationRequested) throw new SpeechServiceError("cancelled");
    if (signal.aborted) {
      await options.operations.cancel(input.identity, request.requestId, (trx, id) => options.funding.release(trx, id));
      throw new SpeechServiceError("cancelled");
    }
    const claim = await options.operations.claimDispatch(input.identity, request.requestId, (trx, id) => options.funding.start(trx, id));
    if (!claim.claimed) throw new SpeechServiceError(claim.operation.cancellationRequested ? "cancelled" : "result_not_replayable");
    ownsDispatch = true;
    const beforeDispatch = await options.operations.get(input.identity, request.requestId);
    if (!beforeDispatch || beforeDispatch.cancellationRequested || signal.aborted) throw new SpeechServiceError("cancelled");
    async function* completed() { yield await adapter!.synthesize({ text: request.text, signal }); }
    const provider = streaming ? adapter.stream!({ text: request.text, signal }) : completed();
    let total = 0;
    for await (const chunk of provider) {
      if (signal.aborted) throw new SpeechServiceError("cancelled");
      total += chunk.byteLength;
      if (chunk.byteLength < 2 || chunk.byteLength % 2 !== 0 || total > SPEECH_MAX_SYNTHESIS_AUDIO_BYTES || Math.ceil(total / 48) > synthesis.maxDurationMs) throw new SpeechAdapterError("invalid_response", "Synthesis response was invalid");
      // A completed-only adapter is never used for the stream endpoint.
      for (let offset = 0; offset < chunk.byteLength; offset += 65_536) {
        if (signal.aborted) throw new SpeechServiceError("cancelled");
        yield chunk.slice(offset, Math.min(chunk.byteLength, offset + 65_536));
      }
    }
    if (total < 2) throw new SpeechAdapterError("invalid_response", "Synthesis response was invalid");
    const durationMs = Math.ceil(total / 48);
    const beforeCompletion = await options.operations.get(input.identity, request.requestId);
    if (!beforeCompletion || beforeCompletion.cancellationRequested || signal.aborted) throw new SpeechServiceError("cancelled");
    const actualCostMicrousd = cost(durationMs, synthesis.microusdPerMinute);
    const outcome = await options.operations.complete(input.identity, request.requestId, { executionState: "succeeded", outcomeCode: "transcript", actualCostMicrousd }, (trx, id) => options.funding.settle(trx, id, { mode: "exact", actualCostMicrousd }));
    if (outcome.executionState !== "succeeded" || outcome.cancellationRequested) throw new SpeechServiceError("cancelled");
    finalized = true;
    return durationMs;
  } catch (error: unknown) {
    failed = true;
    failure = error;
    if (signal.aborted || admitted?.cancellationRequested || (error instanceof SpeechAdapterError && error.code === "cancelled")) throw new SpeechServiceError("cancelled");
    if (error instanceof SpeechAdapterError && error.code === "timeout") throw new SpeechServiceError("timeout");
    if (error instanceof SpeechServiceError) throw error;
    throw new SpeechServiceError("synthesis_failed");
  } finally {
    // A consumer return never enters catch. Treat it exactly like interrupted dispatch.
    const cancelled = signal.aborted || !failed || (failure instanceof SpeechServiceError && failure.code === "cancelled") || (failure instanceof SpeechAdapterError && failure.code === "cancelled");
    scope.stop();
    controller.abort();
    try {
      if (ownsDispatch && !finalized) {
        let current: SpeechOperationRecord | undefined;
        try { current = await options.operations.get(input.identity, request.requestId); }
        catch (error: unknown) { console.warn("[platform-speech] synthesis reconciliation read failed", error instanceof Error ? error.name : "UnknownError"); }
        // A failed read is not not-found. Attempt authoritative, transactional settlement;
        // if DB remains unavailable the claimed row/hold stays unresolved, never redispatched.
        if (!current || current.executionState === "dispatching") {
          const cancelIntent = cancelled || current?.cancellationRequested === true;
          if (cancelIntent && !current?.cancellationRequested) await options.operations.cancel(input.identity, request.requestId, (trx, id) => options.funding.release(trx, id));
          await options.operations.complete(input.identity, request.requestId, {
            executionState: "uncertain", outcomeCode: cancelIntent ? "cancelled" : failure instanceof SpeechAdapterError && failure.code === "timeout" ? "timeout" : "provider_failure", actualCostMicrousd: current?.reservedMicrousd ?? maximumCostMicrousd,
          }, (trx, id) => options.funding.settle(trx, id, { mode: "conservative" }));
        }
      }
    } catch (error: unknown) {
      console.warn("[platform-speech] synthesis settlement unresolved", error instanceof Error ? error.name : "UnknownError");
      throw new SpeechServiceError("synthesis_failed");
    } finally { scope.release(); }
  }
}
