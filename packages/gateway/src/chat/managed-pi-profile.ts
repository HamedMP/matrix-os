import { SCOPE_RUNTIME_MANAGED_PI_PROFILE_ID } from "@matrix-os/scope-runtime/bot-profile";
import type { ScopeRuntimeProfileCatalog } from "../collaboration/scope-runtime-client.js";
import { LEGACY_SCOPE_RUNTIME_PROFILE_POLICY } from "../collaboration/scope-runtime-profile-policy.js";

export const MANAGED_PI_SCOPE_RUNTIME_PROFILE_CATALOG: ScopeRuntimeProfileCatalog = {
  [SCOPE_RUNTIME_MANAGED_PI_PROFILE_ID]: LEGACY_SCOPE_RUNTIME_PROFILE_POLICY.catalog[SCOPE_RUNTIME_MANAGED_PI_PROFILE_ID]!,
};
