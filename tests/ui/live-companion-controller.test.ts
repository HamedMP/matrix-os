import { describe, expect, it } from "vitest";
import { VoiceSessionController } from "../../packages/ui/src/voice-session/controller.js";
const common = { contractVersion: 1, sessionId: "vs_live", epoch: 1 };
describe("shared native live captions", () => {
  it("shows provisional user and assistant lanes at chunk receipt", () => {
    const controller = new VoiceSessionController({ sessionId: "vs_live", initialEpoch: 1 });
    expect(controller.receive({ ...common, sequence: 0, type: "companion.caption", turnId: "vturn_one", speaker: "user", text: "Hello", final: false, interrupted: false })).toBe(true);
    expect(controller.receive({ ...common, sequence: 1, type: "companion.caption", turnId: "vresp_one", speaker: "assistant", text: "Hi there", final: false, interrupted: false })).toBe(true);
    expect(controller.getState().companion?.captions).toMatchObject({ utterance: "Hello", response: "Hi there" });
  });
  it("marks interrupted speech and rejects cross-session or oversized captions", () => {
    const controller = new VoiceSessionController({ sessionId: "vs_live", initialEpoch: 1 });
    controller.receive({ ...common, sequence: 0, type: "companion.caption", turnId: "vresp_one", speaker: "assistant", text: "Hi there", final: true, interrupted: true });
    expect(controller.getState().companion?.captions.interrupted).toBe(true);
    expect(controller.receive({ ...common, sessionId: "vs_other", sequence: 1, type: "companion.caption", turnId: "vresp_one", speaker: "assistant", text: "No", final: false, interrupted: false })).toBe(false);
  });
});
