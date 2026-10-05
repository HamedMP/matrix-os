import { describe, expect, it } from "vitest";
import {
  buildGeminiLiveWebSocketTarget,
  hasGeminiLiveConnection,
  parseGeminiMessage,
} from "../../../packages/gateway/src/onboarding/gemini-live.js";

describe("Gemini Live connection target", () => {
  it("uses a provider header for direct platform-owned calls", () => {
    const target = buildGeminiLiveWebSocketTarget("gemini-key");

    expect(target.url).toBe("wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent");
    expect(target.headers).toEqual({ "x-goog-api-key": "gemini-key" });
  });

  it("uses the platform internal proxy without exposing the provider key to customer gateways", () => {
    const target = buildGeminiLiveWebSocketTarget({
      proxy: {
        platformUrl: "https://platform.internal/base?debug=true",
        handle: "alice",
        token: "container-token",
      },
    });

    expect(target.url).toBe("wss://platform.internal/base/internal/containers/alice/gemini-live");
    expect(target.headers).toEqual({ authorization: "Bearer container-token" });
    expect(Object.keys(target.headers)).not.toContain("x-goog-api-key");
  });

  it("treats complete proxy config as a voice connection", () => {
    expect(hasGeminiLiveConnection({ proxy: { platformUrl: "http://platform", handle: "alice", token: "tok" } })).toBe(true);
    expect(hasGeminiLiveConnection({ proxy: { platformUrl: "http://platform", handle: "alice", token: "" } })).toBe(false);
  });
});

describe("Gemini Live input boundary", () => {
  it("preserves explicit completion even when its final frame has no text", () => {
    expect(parseGeminiMessage({ serverContent: { inputTranscription: { finished: true } } })).toEqual([{ type: "input_transcript", text: "", finished: true }]);
    expect(() => parseGeminiMessage({ serverContent: { inputTranscription: { text: "Hi", finished: "yes" } } })).toThrow();
  });
  it("emits source speech before a tool call in the same frame", () => {
    const events = parseGeminiMessage({ serverContent: { inputTranscription: { text: "Build a tracker" } }, toolCall: { functionCalls: [{ id: "call_a", name: "delegate_task", args: { kind: "build_app", prompt: "ignored" } }] } });
    expect(events[0]?.type).toBe("input_transcript");
    expect(events[1]?.type).toBe("tool_call");
  });
  it("rejects malformed and oversized provider transcripts", () => {
    expect(() => parseGeminiMessage({ serverContent: { inputTranscription: { text: 42 } } })).toThrow();
    expect(() => parseGeminiMessage({ serverContent: { inputTranscription: { text: "x".repeat(8001) } } })).toThrow();
  });
});
