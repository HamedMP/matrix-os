import { describe, expect, it } from "vitest";
import { loadNativeLivePolicy, constrainNativeLiveSetup, usageUpperBound } from "../../packages/platform/src/native-live/policy.js";
describe("platform-owned Live policy", () => {
  const env = { MATRIX_PLATFORM_LIVE_ENABLED: "true", MATRIX_PLATFORM_LIVE_ALLOWED_HANDLES: "pr-2172", MATRIX_PLATFORM_LIVE_POLICY_REVISION: "live-1" };
  it("requires explicit rollout and bounded eligibility", () => {
    expect(loadNativeLivePolicy({})).toBeUndefined();
    expect(loadNativeLivePolicy({ MATRIX_PLATFORM_LIVE_ENABLED: "true" })).toBeUndefined();
    expect(loadNativeLivePolicy(env)).toMatchObject({ allowedHandles: ["pr-2172"], maximumSessionMs: 1_800_000 });
    expect(loadNativeLivePolicy({ ...env, MATRIX_PLATFORM_LIVE_SESSION_BUDGET_MICROUSD: "Infinity" })).toBeUndefined();
  });
  it("pins the model, voice, context and output limits without admitting paid built-in tools", () => {
    const setup = constrainNativeLiveSetup({ model: "models/expensive", generationConfig: { maxOutputTokens: 65000 },
      systemInstruction: { parts: [{ text: "Be helpful" }] }, tools: [{ functionDeclarations: [{ name: "find_chats", behavior: "BLOCKING", parameters: { type: "OBJECT" } }] }] });
    expect(setup).toMatchObject({ model: "models/gemini-3.8-live", generationConfig: { maxOutputTokens: 1024, speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } } }, contextWindowCompression: { triggerTokens: 8192, slidingWindow: { targetTokens: 4096 } } });
    expect(setup.tools[0].functionDeclarations[0].behavior).toBe("NON_BLOCKING");
    expect(() => constrainNativeLiveSetup({ tools: [{ googleSearch: {} }] })).toThrow();
    expect(() => constrainNativeLiveSetup({ tools: [{ functionDeclarations: [{ name: "arbitrary_shell" }] }] })).toThrow();
  });
  it("accounts conservatively for transcription, thinking and rebilled context", () => {
    expect(usageUpperBound({ promptTokenCount: 100, responseTokenCount: 10, thoughtsTokenCount: 5 })).toBe(480);
    expect(() => usageUpperBound({ promptTokenCount: -1, responseTokenCount: 1 })).toThrow();
  });
});
