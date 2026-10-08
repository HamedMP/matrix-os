import {
  SCOPE_RUNTIME_BOT_ADAPTER_ID,
  SCOPE_RUNTIME_BOT_HARNESS_VERSION,
  SCOPE_RUNTIME_BOT_PROFILE_DIGEST,
  SCOPE_RUNTIME_BOT_PROFILE_ID,
  SCOPE_RUNTIME_BOT_PROFILE_VERSION,
} from "@matrix-os/scope-runtime/bot-profile";
import {
  SCOPE_RUNTIME_SANDBOX_POLICY_DIGEST,
  SCOPE_RUNTIME_SANDBOX_POLICY_VERSION,
} from "@matrix-os/scope-runtime/sandbox";
import type { ScopeRuntimeProfileCatalog } from "../collaboration/scope-runtime-client.js";

/**
 * The bot workload profile this gateway build accepts. A supervisor that
 * advertises any other digest, sandbox policy, or harness version for it
 * leaves bots unavailable while shared Chat keeps working.
 */
export const BOT_SCOPE_RUNTIME_PROFILE_CATALOG: ScopeRuntimeProfileCatalog = {
  [SCOPE_RUNTIME_BOT_PROFILE_ID]: {
    profileVersion: SCOPE_RUNTIME_BOT_PROFILE_VERSION,
    profileDigest: SCOPE_RUNTIME_BOT_PROFILE_DIGEST,
    identity: { mode: "dynamic", uidMin: 61_184, uidMax: 65_519 },
    sandbox: {
      policyVersion: SCOPE_RUNTIME_SANDBOX_POLICY_VERSION,
      policyDigest: SCOPE_RUNTIME_SANDBOX_POLICY_DIGEST,
    },
    supportedAdapters: {
      [SCOPE_RUNTIME_BOT_ADAPTER_ID]: {
        harnessVersions: [SCOPE_RUNTIME_BOT_HARNESS_VERSION],
        workloads: ["bot_agent"],
      },
    },
  },
};
