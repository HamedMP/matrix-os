import { VoiceCapabilitySchema } from "@matrix-os/contracts/voice-session";
import type { CanonicalChatModelSelection, CanonicalProviderCatalog } from "@matrix-os/contracts";
import { validateChatProviderSelection } from "../chat/provider-catalog.js";
import type { VoiceCanonicalDecision } from "../voice-session/ports.js";

/** Native media owns conversation; the selected harness owns separately
 * admitted child tasks. Native media never executes a source-Chat provider run.
 * Its frozen policy grants no tools. Only the server's registered native
 * adapter may select this decision.
 */
export function nativeCompanionCanonicalDecision(input: {
  selection: CanonicalChatModelSelection | undefined;
  catalog: CanonicalProviderCatalog;
  surface?: string;
}): VoiceCanonicalDecision | undefined {
  if (!input.selection) return undefined;
  const eligible = validateChatProviderSelection({
    catalog: input.catalog,
    selection: input.selection,
    requirements: { interactionMode: "default", permissionMode: "full_access" },
  });
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
    permissionMode: "full_access",
    executionPolicy,
    capability: VoiceCapabilitySchema.parse({
      contractVersion: 1,
      status: eligible.ok ? "available" : "unavailable",
      surface: input.surface ?? "web_desktop",
      transportModes: eligible.ok ? ["relayed_websocket"] : [],
      turnModes: eligible.ok ? ["hands_free", "push_to_talk"] : [],
      supportsInterruption: eligible.ok && eligible.instance.supports.cancellation !== false
        && eligible.instance.supports.cancellation !== "none",
      resume: eligible.ok ? (eligible.instance.supports.resume ? "delivery_aware" : "rebuild_only") : "unsupported",
      sessionOnly: "unsupported",
      actionMode: "conversation_only",
      actionCancellation: "none",
      supportsInputSelection: true,
      supportsOutputSelection: true,
      ...(eligible.ok ? {} : { reason: "provider_unavailable" }),
    }),
  };
}
