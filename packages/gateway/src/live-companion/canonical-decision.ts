import { VoiceCapabilitySchema } from "@matrix-os/contracts/voice-session";
import type { CanonicalChatModelSelection, CanonicalProviderCatalog } from "@matrix-os/contracts";
import type { VoiceCanonicalDecision } from "../voice-session/ports.js";

/** Native media owns conversation; the selected harness owns separately
 * admitted child tasks. Native media never executes a source-Chat provider run.
 * Task readiness never authorizes or blocks native media. Owner eligibility and
 * fresh platform speech readiness remain authoritative at registration/routes.
 * Its frozen policy grants no tools. Only the server's registered native
 * adapter may select this decision.
 */
export function nativeCompanionCanonicalDecision(input: {
  selection: CanonicalChatModelSelection | undefined;
  catalog?: CanonicalProviderCatalog;
  surface?: string;
}): VoiceCanonicalDecision | undefined {
  const executionPolicy = {
    revision: "native_live_conversation_only_v1",
    actionMode: "conversation_only" as const,
    workspaceScope: "apps" as const,
    tools: [],
    delegation: false,
  };
  return {
    selection: input.selection,
    interactionMode: "default",
    permissionMode: "supervised",
    executionPolicy,
    capability: VoiceCapabilitySchema.parse({
      contractVersion: 1,
      status: "available",
      surface: input.surface ?? "web_desktop",
      transportModes: ["relayed_websocket"],
      // Native media controls never cancel or resume the task harness.
      // Match the registered Gemini adapter; projection intersects both.
      turnModes: ["hands_free"],
      supportsInterruption: true,
      resume: "rebuild_only",
      sessionOnly: "unsupported",
      actionMode: "conversation_only",
      actionCancellation: "none",
      supportsInputSelection: true,
      supportsOutputSelection: true,
    }),
  };
}
