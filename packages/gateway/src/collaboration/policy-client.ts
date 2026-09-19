import {
  CollaborationRuntimeIdSchema,
  type CollaborationPolicy,
} from "@matrix-os/contracts";
import type { CollaborationActorProofVerifier } from "./actor-proof.js";
import { requireSecureCollaborationPlatformBaseUrl } from "./platform-base-url.js";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 16 * 1024;
const POLICY_CACHE_TTL_MS = 5_000;
export class CollaborationPolicyClientError extends Error {
  constructor() {
    super("Collaboration rollout policy is unavailable");
    this.name = "CollaborationPolicyClientError";
  }
}
export class CollaborationPolicyClient {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private cachedPolicy?: { policy: CollaborationPolicy; validUntil: number };
  private inFlight?: Promise<CollaborationPolicy>;
  constructor(private readonly options: {
    platformBaseUrl: string;
    runtimeId: string;
    serviceToken: string;
    verifier: Pick<CollaborationActorProofVerifier, "verifyPolicy">;
    fetchImpl?: typeof fetch;
    now?: () => Date;
  }) {
    const baseUrl = requireSecureCollaborationPlatformBaseUrl(options.platformBaseUrl);
    CollaborationRuntimeIdSchema.parse(options.runtimeId);
    if (Buffer.byteLength(options.serviceToken) < 32) {
      throw new Error("Collaboration policy service token is unavailable");
    }
    this.endpoint = `${baseUrl.origin}/internal/collaboration/policy?milestone=m2`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }
  async getM2(): Promise<CollaborationPolicy> {
    const now = this.now().getTime();
    if (this.cachedPolicy && now < this.cachedPolicy.validUntil) {
      return this.cachedPolicy.policy;
    }
    this.cachedPolicy = undefined;
    if (this.inFlight) return this.inFlight;

    const request = this.fetchM2();
    this.inFlight = request;
    try {
      const policy = await request;
      const expiresAt = new Date(policy.expiresAt).getTime();
      const validUntil = Math.min(now + POLICY_CACHE_TTL_MS, expiresAt);
      if (Number.isFinite(validUntil) && validUntil > now) {
        this.cachedPolicy = { policy, validUntil };
      }
      return policy;
    } finally {
      if (this.inFlight === request) this.inFlight = undefined;
    }
  }

  private async fetchM2(): Promise<CollaborationPolicy> {
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.options.serviceToken}`,
          "x-matrix-runtime-id": this.options.runtimeId,
        },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new CollaborationPolicyClientError();
      }
      const value = JSON.parse(await readBoundedText(response)) as unknown;
      const policy = this.options.verifier.verifyPolicy(value);
      if (policy.milestone !== "m2") throw new CollaborationPolicyClientError();
      return policy;
    } catch (error: unknown) {
      console.warn("[collaboration-policy] policy lookup failed",
        error instanceof Error ? error.name : "UnknownError");
      if (error instanceof CollaborationPolicyClientError) throw error;
      throw new CollaborationPolicyClientError();
    }
  }
}
async function readBoundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new CollaborationPolicyClientError();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new CollaborationPolicyClientError();
      }
      chunks.push(next.value);
    }
    return Buffer.concat(chunks, size).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}
