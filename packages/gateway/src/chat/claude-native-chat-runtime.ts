import { createClaudeChatProviderAdapter } from "./claude-provider-adapter.js";
import { createClaudeNativeSessionPool } from "./claude-native-session.js";
import type { NativeScheduledPhaseRequest } from "./native-scheduled-admission.js";

type NativeScheduledAdmitter = { admitNativeScheduledPhase(request: NativeScheduledPhaseRequest): Promise<void> };

/** Private gateway composition; no public native scheduling or authority endpoint. */
export function createGatewayClaudeChatRuntime(options: Omit<Parameters<typeof createClaudeChatProviderAdapter>[0], "nativeSessions">) {
  // Qualified for exact 2.1.317 by the pool's native version and initial-hook ACK gate.
  // The host-local phase registrar never repeats native initialize on a held prompt.
  const sessions = createClaudeNativeSessionPool({ protocolQualified: true });
  const adapter = createClaudeChatProviderAdapter({ ...options, nativeSessions: sessions });
  return {
    adapter,
    bind(current: () => NativeScheduledAdmitter | null) {
      adapter.bindNativeScheduledHandler(async request => {
        const orchestrator = current();
        if (!orchestrator) throw new Error("Native scheduled Chat unavailable");
        await orchestrator.admitNativeScheduledPhase(request);
      });
    },
    close: () => adapter.closeNativeSessions(),
  };
}
