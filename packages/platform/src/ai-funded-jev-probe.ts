import { FundedAiIdentitySchema, FundedAiRuntimeCredentialIssueResponseSchema, JEV_MODEL_ID } from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { AiFundedPolicyRepository } from "./ai-funded-policy-repository.js";

export const JevProbeRuntimeSchema = z.object({ identity: FundedAiIdentitySchema,
  globalRevision: z.number().int().min(0), runtimeRevision: z.number().int().min(0) }).strict();
export type JevProbeRuntime = z.infer<typeof JevProbeRuntimeSchema>;
export type JevProbeCredentials = Pick<AiFundedPolicyRepository, "issueJevProbeCredential" | "revokeRuntimeCredential">;
const MAX_PENDING = 8;
const pending = new Set<Promise<string | undefined>>();
export async function probeWithSignal<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }),
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error("Funded probe cancelled"));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      })]);
  } finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
}
export function cancelProbeBody(body: ReadableStream | ReadableStreamDefaultReader | null): void {
  void body?.cancel().catch((error: unknown) => {
    console.warn("[funded-ai] Probe body cancellation failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
  });
}

/** Same owner-funded credential repository and relay settlement path; no owner content or alternate billing. */
export async function probeOwnerFundedJev(input: {
  runtime: JevProbeRuntime; credentials: JevProbeCredentials; relayBase: URL; relayControlToken: string;
  signal: AbortSignal; fetchFn: typeof fetch; readReady: (response: Response) => Promise<string | undefined>;
}): Promise<string | undefined> {
  input.signal.throwIfAborted();
  if (pending.size >= MAX_PENDING) return undefined;
  const operation = (async () => {
    const lease = FundedAiRuntimeCredentialIssueResponseSchema.parse(await input.credentials.issueJevProbeCredential(input.runtime.identity));
    try {
      input.signal.throwIfAborted();
      if (JSON.stringify(lease.identity) !== JSON.stringify(input.runtime.identity)
        || lease.policy.globalRevision !== input.runtime.globalRevision || lease.policy.runtimeRevision !== input.runtime.runtimeRevision
        || !lease.policy.enabled || !lease.policy.allowedModelIds.includes(JEV_MODEL_ID)
        || Date.parse(lease.policy.staleAfter) <= Date.now() || Date.parse(lease.credential.expiresAt) <= Date.now() + 5_000) return undefined;
      const response = await probeWithSignal(() => input.fetchFn(new URL("/v1/jev-readiness", input.relayBase).href, {
        method: "POST", redirect: "error", signal: input.signal,
        headers: { authorization: `Bearer ${input.relayControlToken}`, "x-api-key": lease.credential.token, "content-type": "application/json" },
        body: "{}",
      }).then(response => {
        if (input.signal.aborted) { cancelProbeBody(response.body); input.signal.throwIfAborted(); }
        return response;
      }), input.signal);
      const ready = await input.readReady(response);
      input.signal.throwIfAborted();
      return ready;
    } finally {
      // This temporary token is distinct from the VPS's persistent credential.
      if (!await input.credentials.revokeRuntimeCredential({ tokenId: lease.credential.tokenId, identity: lease.identity })) {
        const error = new Error("Jev probe credential revocation failed");
        error.name = "JevProbeCredentialRevocationError";
        throw error;
      }
    }
  })();
  pending.add(operation);
  void operation.then(() => pending.delete(operation), () => pending.delete(operation));
  return operation;
}
