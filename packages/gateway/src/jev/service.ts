import { createHash } from "node:crypto";
import {
  JEV_EMAIL_TRIAGE_INSTRUCTIONS,
  JEV_MODEL_ID,
  JevEmailTriageResultSchema,
  JevEvaluateRequestSchema,
  type JevEmailTriageResult,
  type JevEvaluateRequest,
} from "@matrix-os/contracts";
import type { MatrixFundedCredentialProvider } from "../funded-ai-credential-manager.js";
import type { JevEvaluationStore } from "./repository.js";

const RESPONSE_LIMIT_BYTES = 64 * 1024;
const EVALUATION_TIMEOUT_MS = 30_000;

export type JevServiceErrorCode = "conflict" | "denied" | "in_progress" | "unknown" | "unavailable";

export class JevServiceError extends Error {
  constructor(readonly code: JevServiceErrorCode, options?: ErrorOptions) {
    super("Jev evaluation failed", options);
    this.name = "JevServiceError";
  }
}

export interface JevService {
  evaluate(ownerId: string, input: JevEvaluateRequest, signal?: AbortSignal): Promise<JevEmailTriageResult>;
}

function payloadHash(input: JevEvaluateRequest): string {
  return createHash("sha256").update(input.recipe).update("\0").update(input.state).digest("hex");
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > RESPONSE_LIMIT_BYTES) {
    await response.body?.cancel("response too large");
    throw new Error("Jev response exceeded its limit");
  }
  if (!response.body) throw new Error("Jev response was empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > RESPONSE_LIMIT_BYTES) {
        await reader.cancel("response too large");
        throw new Error("Jev response exceeded its limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export function createJevService(options: {
  store: JevEvaluationStore;
  credentialProvider: MatrixFundedCredentialProvider;
  fetchFn?: typeof fetch;
}): JevService {
  const fetchFn = options.fetchFn ?? fetch;
  return {
    async evaluate(ownerId, rawInput, callerSignal) {
      const input = JevEvaluateRequestSchema.parse(rawInput);
      const key = { ownerId, idempotencyKey: input.idempotencyKey, payloadHash: payloadHash(input) };
      const claim = await options.store.claim(key);
      if (claim.kind === "completed") return claim.result;
      if (claim.kind === "conflict") throw new JevServiceError("conflict");
      if (claim.kind === "unknown") throw new JevServiceError("unknown");
      if (claim.kind === "pending") throw new JevServiceError("in_progress");

      let dispatched = false;
      try {
        const lease = await options.credentialProvider.getCredential({
          minValidityMs: EVALUATION_TIMEOUT_MS + 5_000,
          signal: callerSignal,
        });
        const signal = callerSignal
          ? AbortSignal.any([callerSignal, AbortSignal.timeout(EVALUATION_TIMEOUT_MS)])
          : AbortSignal.timeout(EVALUATION_TIMEOUT_MS);
        dispatched = true;
        const response = await fetchFn(`${lease.relayBaseUrl.replace(/\/$/, "")}/v1/evaluate`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": lease.token,
          },
          body: JSON.stringify({
            model: JEV_MODEL_ID,
            state: input.state,
            questions: Object.fromEntries(Object.entries(JEV_EMAIL_TRIAGE_INSTRUCTIONS).map(([id, instructions]) => [
              id,
              { type: "boolean", instructions },
            ])),
          }),
          redirect: "error",
          signal,
        });
        if (!response.ok) {
          const neverStarted = response.headers.get("x-matrix-jev-dispatch") === "not-started";
          await response.body?.cancel("relay rejected request");
          if (neverStarted) {
            await options.store.release(key);
            if (response.status === 401) options.credentialProvider.invalidate(lease.tokenId);
            throw new JevServiceError(response.status === 403 ? "denied" : "unavailable");
          }
          await options.store.markUnknown(key);
          throw new JevServiceError("unknown");
        }
        const result = JevEmailTriageResultSchema.parse(await readBoundedJson(response));
        await options.store.complete({ ...key, result });
        return result;
      } catch (error) {
        if (error instanceof JevServiceError) throw error;
        try {
          if (dispatched) await options.store.markUnknown(key);
          else await options.store.release(key);
        } catch (storeError) {
          console.error("[jev] Failed to reconcile evaluation state", {
            errorName: storeError instanceof Error ? storeError.name : "UnknownError",
          });
        }
        throw new JevServiceError(dispatched ? "unknown" : "unavailable", { cause: error });
      }
    },
  };
}
