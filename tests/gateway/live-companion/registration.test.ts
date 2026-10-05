import { describe, expect, it } from "vitest";
import { VoiceMediaAdapterRegistry } from "../../../packages/gateway/src/voice-session/adapter.js";
import { registerNativeCompanion } from "../../../packages/gateway/src/live-companion/registration.js";
describe("native Live readiness", () => {
  it("does not turn a legacy key into funded production eligibility", () => {
    const registry = new VoiceMediaAdapterRegistry();
    expect(registerNativeCompanion({ registry, connection: "legacy-key", env: { NODE_ENV: "production", MATRIX_AOEDE_NATIVE_LIVE: "1" } })).toMatchObject({ available: false, reason: "live_policy_unavailable" });
    expect(registry.size).toBe(0);
  });
  it("requires explicit development opt-in and registers native Gemini without a fallback", () => {
    const registry = new VoiceMediaAdapterRegistry();
    expect(registerNativeCompanion({ registry, connection: "test-key", env: {} }).available).toBe(false);
    expect(registerNativeCompanion({ registry, connection: "test-key", env: { NODE_ENV: "development", MATRIX_AOEDE_NATIVE_LIVE: "1" } }).available).toBe(true);
    expect(registry.default()?.capabilities.conversationMode).toBe("native_live");
  });
  it("fails closed for a requested native session without a configured credential", () => {
    const registry = new VoiceMediaAdapterRegistry();
    expect(registerNativeCompanion({ registry, connection: "", env: { MATRIX_AOEDE_NATIVE_LIVE: "1", NODE_ENV: "development" } })).toMatchObject({ requested: true, available: false, reason: "not_configured" });
    expect(registry.size).toBe(0);
  });
});
