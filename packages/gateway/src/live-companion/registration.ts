import { createGeminiCompanionAdapter, GEMINI_COMPANION_MODEL } from "./gemini-adapter.js";
import type { VoiceMediaAdapterRegistry } from "../voice-session/adapter.js";
import { hasGeminiLiveConnection, type GeminiLiveConnection } from "../onboarding/gemini-live.js";

/** Legacy keys are not funded readiness. Production requires a platform Live
 * entitlement/residency/budget contract, which does not ship yet. Explicit
 * development opt-in can use an operator-owned connection for real spikes.
 * A requested native path never silently falls back to STT/agent/TTS.
 */
export function registerNativeCompanion(options: { registry: VoiceMediaAdapterRegistry; connection: GeminiLiveConnection; env: NodeJS.ProcessEnv }) {
  const requested = options.env.MATRIX_AOEDE_NATIVE_LIVE === "1";
  if (!requested) return { requested: false, available: false, reason: "not_selected" } as const;
  if (options.env.NODE_ENV === "production") return { requested: true, available: false, reason: "live_policy_unavailable" } as const;
  if (!hasGeminiLiveConnection(options.connection)) return { requested: true, available: false, reason: "not_configured" } as const;
  options.registry.register(createGeminiCompanionAdapter({ connection: options.connection, model: GEMINI_COMPANION_MODEL }));
  return { requested: true, available: true, reason: "native_live_dev" } as const;
}
