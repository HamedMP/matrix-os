import { JEV_MODEL_ID } from "@matrix-os/contracts";
import { AiFundedPolicyError } from "./ai-funded-policy-errors.js";

export interface JevNoDispatchAttestation {
  expectedRequestId: string;
  jevPricingVersion: string;
}

/** Invoked only under the reservation row lock, through trusted relay finalization. */
export function assertJevNoDispatchSettlement(input: {
  attestation: JevNoDispatchAttestation;
  modelId: string;
  usageLimit: number | null;
  storedPricingVersion: string | undefined;
  requestId: string;
  actualCostMicrousd: number | null;
  finalizationMode: "exact" | "conservative";
  hasProviderProvenance: boolean;
}): void {
  if (input.modelId !== JEV_MODEL_ID || input.usageLimit === null
    || input.attestation.expectedRequestId !== input.requestId
    || input.storedPricingVersion === undefined
    || input.attestation.jevPricingVersion !== input.storedPricingVersion
    || input.actualCostMicrousd !== 0 || input.finalizationMode !== "exact"
    || input.hasProviderProvenance) {
    throw new AiFundedPolicyError("idempotency_conflict");
  }
}
