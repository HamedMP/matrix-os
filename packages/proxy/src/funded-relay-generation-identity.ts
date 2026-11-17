import { createHmac } from "node:crypto";
import type { FundedAiPolicyCheckResponse } from "@matrix-os/contracts";
import type { FundedPlatformClient } from "./funded-relay-platform-client.js";

const IDENTITY_TTL_MS = 30_000;
const MAX_CACHED_IDENTITIES = 512;
type VerifiedIdentity = FundedAiPolicyCheckResponse["identity"];
type GenerationIdentity = { identity: VerifiedIdentity; discardCachedIdentity?: () => void };

export function identitiesMatch(left: VerifiedIdentity, right: VerifiedIdentity): boolean {
  return left.tokenId === right.tokenId && left.ownerId === right.ownerId
    && left.machineId === right.machineId && left.runtimeSlot === right.runtimeSlot
    && left.audience === right.audience && left.scope === right.scope && left.expiresAt === right.expiresAt;
}

/**
 * The remembered identity is for the local limiter and model metadata only.
 * Its caller must still authorize the current request with Platform and match
 * the exact returned identity before starting or dispatching any work.
 */
export function createGenerationIdentityReader(options: {
  platform: Pick<FundedPlatformClient, "check">;
  secret: string;
  now: () => Date;
}) {
  const cache = new Map<string, { identity: VerifiedIdentity; readAt: number; validUntil: number }>();
  return async function readIdentity(
    input: Parameters<FundedPlatformClient["check"]>[0],
    signal: AbortSignal,
    allowReuse: boolean,
  ): Promise<GenerationIdentity> {
    if (!allowReuse) return { identity: (await options.platform.check(input, signal)).identity };
    signal.throwIfAborted();
    const key = createHmac("sha256", options.secret)
      .update(JSON.stringify(["funded-generation-identity", input.credential, input.modelId])).digest("base64url");
    const at = options.now().getTime();
    const previous = cache.get(key);
    if (previous && at >= previous.readAt && at < previous.validUntil) {
      return { identity: previous.identity, discardCachedIdentity: () => {
        if (cache.get(key) === previous) cache.delete(key);
      } };
    }
    cache.delete(key);
    const { identity } = await options.platform.check(input, signal);
    const validUntil = Math.min(at + IDENTITY_TTL_MS, Date.parse(identity.expiresAt));
    if (validUntil > options.now().getTime()) {
      if (cache.size >= MAX_CACHED_IDENTITIES) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      cache.set(key, { identity, readAt: at, validUntil });
    }
    return { identity };
  };
}
