import {
  SCOPE_RUNTIME_MANAGED_PI_PROFILE_ID,
  SCOPE_RUNTIME_MANAGED_PI_PROFILE_VERSION,
  SCOPE_RUNTIME_MANAGED_PI_PROFILE_DIGEST,
  SCOPE_RUNTIME_BOT_PROFILE_ID,
} from "@matrix-os/scope-runtime/bot-profile";
import { BOT_SCOPE_RUNTIME_PROFILE_CATALOG } from "../bots/scope-runtime-profile.js";
import type { ScopeRuntimeProfileCatalog } from "../collaboration/scope-runtime-client.js";

/** Independently pinned profile: an older Bot-only supervisor cannot admit ordinary Chat. */
export const MANAGED_PI_SCOPE_RUNTIME_PROFILE_CATALOG: ScopeRuntimeProfileCatalog = {
  [SCOPE_RUNTIME_MANAGED_PI_PROFILE_ID]: {
    ...BOT_SCOPE_RUNTIME_PROFILE_CATALOG[SCOPE_RUNTIME_BOT_PROFILE_ID]!,
    profileVersion: SCOPE_RUNTIME_MANAGED_PI_PROFILE_VERSION,
    profileDigest: SCOPE_RUNTIME_MANAGED_PI_PROFILE_DIGEST,
  },
};
