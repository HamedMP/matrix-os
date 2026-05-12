import { describe, expect, it } from "vitest";
import {
  buildGeminiLiveWebSocketTarget,
  hasGeminiLiveConnection,
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
