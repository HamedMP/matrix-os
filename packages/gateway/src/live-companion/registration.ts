import { createGeminiCompanionAdapter, GEMINI_COMPANION_MODEL } from "./gemini-adapter.js";
import type { VoiceMediaAdapterRegistry } from "../voice-session/adapter.js";
import { hasGeminiLiveConnection, type GeminiLiveConnection } from "../onboarding/gemini-live.js";
import type { FundedNativeLiveAccess } from "./funded-readiness.js";

/** Legacy keys are not funded readiness. Production uses the platform-paid
 * Live boundary with fresh owner eligibility and bounded expense admission.
 * Explicit development opt-in can use an operator connection for real spikes.
 * A requested native path never silently falls back to STT/agent/TTS.
 */
export function registerNativeCompanion(options: { registry: VoiceMediaAdapterRegistry; connection: GeminiLiveConnection; env: NodeJS.ProcessEnv; funded?: FundedNativeLiveAccess }) {
  const requested = options.env.MATRIX_AOEDE_NATIVE_LIVE === "1";
  if (!requested) return { requested: false, available: false, reason: "not_selected" } as const;
  if (options.env.NODE_ENV === "production") {
    if (!options.funded) return { requested: true, available: false, reason: "live_policy_unavailable" } as const;
    const access = options.funded;
    const adapter = createGeminiCompanionAdapter({ connection: access.connection, model: GEMINI_COMPANION_MODEL });
    options.registry.register({ ...adapter, async start(context) {
      if (!await access.allowed(context.principalId)) throw new Error("Live is unavailable");
      return adapter.start(context);
    } });
    return { requested: true, available: true, reason: "native_live_platform", allowed: access.allowed } as const;
  }
  if (!hasGeminiLiveConnection(options.connection)) return { requested: true, available: false, reason: "not_configured" } as const;
  options.registry.register(createGeminiCompanionAdapter({ connection: options.connection, model: GEMINI_COMPANION_MODEL }));
  return { requested: true, available: true, reason: "native_live_dev" } as const;
}
