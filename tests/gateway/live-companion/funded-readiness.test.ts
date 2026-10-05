import { describe, expect, it, vi } from "vitest";
import { createFundedNativeLiveAccess } from "../../../packages/gateway/src/live-companion/funded-readiness.js";
import { VoiceMediaAdapterRegistry } from "../../../packages/gateway/src/voice-session/adapter.js";
import { registerNativeCompanion } from "../../../packages/gateway/src/live-companion/registration.js";

const env = { NODE_ENV: "production", MATRIX_AOEDE_NATIVE_LIVE: "1", MATRIX_HANDLE: "alice",
  MATRIX_CLERK_USER_ID: "user_alice", MATRIX_MACHINE_ID: "machine_alice", MATRIX_RUNTIME_SLOT: "alice-test",
  MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN: "a".repeat(64), PLATFORM_INTERNAL_URL: "https://platform.example.com" };
describe("funded native gateway readiness", () => {
  it("uses only the machine-bound platform path and fresh owner eligibility", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ available: true, ownerId: "user_alice", maximumSessionMs: 1_800_000 })));
    const access = createFundedNativeLiveAccess(env, fetch)!;
    expect(access.connection).toMatchObject({ proxy: { endpoint: "native-live", token: "a".repeat(64), runtimeSlot: "alice-test" } });
    expect(await access.allowed("user_alice")).toBe(true);
    expect(await access.allowed("user_bob")).toBe(false);
    expect(fetch.mock.calls[0]?.[0]).toContain("/internal/containers/alice/native-live/capabilities?runtimeSlot=alice-test");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", signal: expect.any(AbortSignal) });
  });
  it("fails closed for disabled, malformed, mismatched, redirect or failed platform responses", async () => {
    for (const response of [{ available: false }, { available: true, ownerId: "user_bob", maximumSessionMs: 1_800_000 }, { available: true, ownerId: "user_alice", maximumSessionMs: 99_999_999 }]) {
      const access = createFundedNativeLiveAccess(env, async () => new Response(JSON.stringify(response)))!;
      expect(await access.allowed("user_alice")).toBe(false);
    }
    const failed = createFundedNativeLiveAccess(env, async () => { throw new TypeError("network"); })!;
    expect(await failed.allowed("user_alice")).toBe(false);
    expect(createFundedNativeLiveAccess({ ...env, MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN: "" })).toBeUndefined();
  });
  it("registers production Live only with funded access, and checks again before media opens", async () => {
    const registry = new VoiceMediaAdapterRegistry();
    const allowed = vi.fn(async () => false);
    const result = registerNativeCompanion({ registry, connection: "legacy-key", env, funded: {
      connection: { proxy: { platformUrl: env.PLATFORM_INTERNAL_URL, handle: "alice", token: "a".repeat(64), endpoint: "native-live", runtimeSlot: "alice-test" } }, allowed,
    } });
    expect(result).toMatchObject({ available: true, reason: "native_live_platform" });
    await expect(registry.default()!.start({ sessionId: "vs_test", principalId: "user_bob", chatId: "chat_test", memoryMode: "ordinary", turnMode: "hands_free", emit: vi.fn() })).rejects.toThrow();
    expect(allowed).toHaveBeenCalledWith("user_bob");
  });
});
