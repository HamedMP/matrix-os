import type { CanonicalChatModelSelection, CanonicalProviderDriverKind } from "@matrix-os/contracts";
import { MATRIX_PI_CHATGPT_PLAN_INSTANCE_ID } from "@matrix-os/contracts";
import { MANAGED_PI_INSTANCE_ID } from "../bots/route-resolver.js";

export const CHAT_SYSTEM_DRIVERS = ["hermes", "openclaw"] as const;
export const CHAT_CODING_DRIVERS = ["codex", "claude_code", "opencode", "pi"] as const;

/** Only registered canonical instance IDs may choose an admission discovery scope. */
export function chatCatalogDiscoveryScope(selection?: CanonicalChatModelSelection) {
  const managedMatrix = selection?.instanceId === MANAGED_PI_INSTANCE_ID;
  const systems = CHAT_SYSTEM_DRIVERS.filter(kind => !selection || selection.instanceId === `${kind}_default`);
  const coding = CHAT_CODING_DRIVERS.filter(kind => !selection || selection.instanceId === `${kind}_default`);
  const personalPlan = selection?.instanceId === MATRIX_PI_CHATGPT_PLAN_INSTANCE_ID;
  const known = managedMatrix || personalPlan || systems.length > 0 || coding.length > 0;
  return {
    systems, coding, managedMatrix,
    readAi: !selection || (known && !personalPlan),
    readRuntime: systems.length > 0,
    acceptsInstance: (id: string) => !selection || id === selection.instanceId,
    acceptsDriver: (kind: CanonicalProviderDriverKind) => !selection ||
      ((managedMatrix || personalPlan) && kind === "matrix_pi") || systems.some(system => system === kind) || coding.some(driver => driver === kind),
    // This is a trusted internal read hint, not authority to run a selected model.
    snapshotOptions: { refresh: false, ...(managedMatrix ? { admissionScope: "managed_matrix" as const } : {}) },
  };
}
