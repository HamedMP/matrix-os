import { createHmac } from "node:crypto";

const SAFE_ACTOR_ID = /^[A-Za-z0-9_-]{1,256}$/;

/** Re-sign a gateway-authenticated actor for the Platform's internal route. */
export function delegatedIntegrationHeaders(actorId: string, machineToken: string): Record<string, string> {
  if (!SAFE_ACTOR_ID.test(actorId) || !machineToken) {
    throw new Error("Invalid delegated integration identity");
  }
  return {
    "x-platform-user-id": actorId,
    "x-platform-verified": createHmac("sha256", machineToken).update(actorId).digest("hex"),
  };
}
