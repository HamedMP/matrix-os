import { timingSafeEqual } from "node:crypto";
import { FundedAiFinalizationResponseSchema, JEV_MODEL_ID, JEV_EMAIL_TRIAGE_INSTRUCTIONS } from "@matrix-os/contracts";

export const JEV_READINESS_PATH = "/v1/jev-readiness";
export function jevProbeControlAuthorized(header: string | undefined, secret: string): boolean {
  if (secret.length < 32 || secret.trim() !== secret) return false;
  const bearer = /^Bearer (\S+)$/i.exec(header ?? "")?.[1];
  if (!bearer || bearer.length > 512) return false;
  const supplied = Buffer.from(bearer); const expected = Buffer.from(secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
export function fixedJevProbeRequest(): unknown {
  return { model: JEV_MODEL_ID, state: "Synthetic Jev readiness check. No email or owner data.",
    questions: Object.fromEntries(Object.entries(JEV_EMAIL_TRIAGE_INSTRUCTIONS).map(([id, instructions]) => [id, { type: "boolean", instructions }])) };
}
export function assertJevProbeSettlement(raw: unknown, expected: {
  reservationId: string; requestId: string; tokenId: string; actualCostMicrousd: number;
}): void {
  const result = FundedAiFinalizationResponseSchema.parse(raw);
  if (result.finalizationMode !== "exact" || result.reservationId !== expected.reservationId
    || result.requestId !== expected.requestId || result.tokenId !== expected.tokenId
    || result.actualCostMicrousd !== expected.actualCostMicrousd
    || result.chargedCostMicrousd !== expected.actualCostMicrousd || result.matrixAbsorbedMicrousd !== 0) {
    throw new Error("Jev probe settlement did not match");
  }
}
