import { LEGACY_SCOPE_RUNTIME_PROFILE_POLICY } from "./scope-runtime-profile-policy.js";

export {
  CODEX_SHARED_INSTANCE_ID,
  CollaborationAiExecutionEligibilitySchema,
  sharedAiAdapterFor,
  type CollaborationAiAdapterId,
  type CollaborationAiExecutionEligibility,
} from "./scope-runtime-profile-policy.js";

/** Compatibility defaults for unconfigured deployments. */
export const SHARED_MATRIX_BOT_ELIGIBILITY = LEGACY_SCOPE_RUNTIME_PROFILE_POLICY.matrixBotEligibility;
export const parseCollaborationAiEligibility = LEGACY_SCOPE_RUNTIME_PROFILE_POLICY.parseEligibility;
export const sharedAiEligibilitySupportsDriver = LEGACY_SCOPE_RUNTIME_PROFILE_POLICY.supportsDriver;
