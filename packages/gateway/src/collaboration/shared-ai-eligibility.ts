import type { CanonicalProviderDriverKind } from "@matrix-os/contracts";
import {
  SCOPE_RUNTIME_HARNESS_VERSION,
  SCOPE_RUNTIME_PROFILE_DIGEST,
  SCOPE_RUNTIME_PROFILE_ID,
  SCOPE_RUNTIME_PROFILE_VERSION,
} from "@matrix-os/scope-runtime/profile";
import { z } from "zod/v4";

export const CollaborationAiExecutionEligibilitySchema = z.object({
  profileId: z.literal(SCOPE_RUNTIME_PROFILE_ID),
  profileVersion: z.literal(SCOPE_RUNTIME_PROFILE_VERSION),
  profileDigest: z.literal(SCOPE_RUNTIME_PROFILE_DIGEST),
  adapterId: z.literal("claude-code"),
  harnessVersion: z.literal(SCOPE_RUNTIME_HARNESS_VERSION),
}).strict();

export type CollaborationAiExecutionEligibility = z.infer<
  typeof CollaborationAiExecutionEligibilitySchema
>;

export function parseCollaborationAiEligibility(
  value: unknown,
): CollaborationAiExecutionEligibility {
  return CollaborationAiExecutionEligibilitySchema.parse(value);
}

export function sharedAiEligibilitySupportsDriver(
  value: unknown,
  driverKind: CanonicalProviderDriverKind,
): boolean {
  return driverKind === "claude_code"
    && CollaborationAiExecutionEligibilitySchema.safeParse(value).success;
}
