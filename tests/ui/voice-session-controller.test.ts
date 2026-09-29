import { describe, expect, it, vi } from "vitest";
import {
  VoiceSessionController,
  type VoiceSessionCommand,
} from "../../packages/ui/src/voice-session/controller";

const SESSION_ID = "vs_ui";

function frame(
  sequence: number,
  body: Record<string, unknown>,
  epoch = 4,
  sessionId = SESSION_ID,
): Record<string, unknown> {
  return { contractVersion: 1, sessionId, epoch, sequence, ...body };
}

describe("VoiceSessionController", () => {
  it("fences stale epochs and duplicate or non-monotonic sequences", () => {
    const controller = new VoiceSessionController({ initialEpoch: 4, sessionId: SESSION_ID });

    expect(controller.receive(frame(1, { type: "session.state", state: "listening" }))).toBe(true);
    expect(controller.receive(frame(1, { type: "session.state", state: "failed" }))).toBe(false);
    expect(controller.receive(frame(0, { type: "session.state", state: "failed" }))).toBe(false);
    expect(controller.receive(frame(20, { type: "session.state", state: "failed" }, 3))).toBe(false);
    expect(controller.getState().state).toBe("listening");

    expect(controller.receive(frame(1, { type: "session.state", state: "reconnecting" }, 5))).toBe(true);
    expect(controller.getState()).toMatchObject({ epoch: 5, sequence: 1, state: "reconnecting" });
    expect(controller.receive(frame(99, { type: "session.state", state: "speaking" }, 4))).toBe(false);
  });

  it("projects bounded provisional transcript, tool, response, and session state", () => {
    const controller = new VoiceSessionController({ initialEpoch: 4, sessionId: SESSION_ID });
    controller.receive(frame(1, {
      type: "transcript.provisional",
      turnId: "vturn_1",
      revision: 2,
      text: "a".repeat(2_000),
    }));
    controller.receive(frame(2, {
      type: "operation.status",
      label: "Searching workspace",
      state: "running",
      runId: "run_1",
    }));
    controller.receive(frame(3, {
      type: "response.started",
      responseId: "vresp_1",
      runId: "run_1",
    }));
    controller.receive(frame(4, { type: "session.state", state: "using_tool" }));

    expect(controller.getState().provisionalTranscript).toMatchObject({ turnId: "vturn_1", revision: 2 });
    expect(controller.getState().provisionalTranscript?.text.length).toBeLessThanOrEqual(500);
    expect(controller.getState()).toMatchObject({ state: "using_tool", toolLabel: "Searching workspace" });

    expect(controller.receive(frame(5, {
      type: "operation.status",
      label: "x".repeat(121),
      state: "running",
      runId: "run_1",
    }))).toBe(false);
    expect(controller.getState().toolLabel).toBe("Searching workspace");
  });

  it("accepts only typed safe errors and rejects raw or mutated error frames", () => {
    const controller = new VoiceSessionController({ initialEpoch: 4, sessionId: SESSION_ID });

    expect(controller.receive(frame(1, {
      type: "session.error",
      code: "permission_denied",
      recovery: "request_permission",
      retryable: true,
      message: "Provider secret at /Users/private",
    }))).toBe(false);
    expect(controller.getState().error).toBeNull();
    expect(controller.getState().state).toBe("connecting");

    expect(controller.receive(frame(2, {
      type: "session.error",
      code: "permission_denied",
      recovery: "request_permission",
      retryable: true,
    }))).toBe(true);
    expect(controller.getState().error).toEqual({
      code: "permission_denied",
      recovery: "request_permission",
      retryable: true,
    });

    expect(controller.receive(frame(3, {
      type: "session.error",
      code: "postgres exploded /var/db",
      recovery: "dump_raw_error",
      retryable: true,
    }))).toBe(false);
    expect(controller.getState().error).toEqual({
      code: "permission_denied",
      recovery: "request_permission",
      retryable: true,
    });
    expect(JSON.stringify(controller.getState())).not.toMatch(/Provider|\/Users\/private|postgres/);
  });

  it("rejects wrong-session frames, unknown keys, and raw messages without mutation", () => {
    const controller = new VoiceSessionController({ initialEpoch: 4, sessionId: SESSION_ID });
    const before = controller.getState();

    expect(controller.receive(frame(1, { type: "session.state", state: "listening" }, 4, "vs_other"))).toBe(false);
    expect(controller.receive(frame(1, { type: "session.state", state: "listening", turnMode: "push_to_talk" }))).toBe(false);
    expect(controller.receive(frame(1, { type: "session.state", state: "listening", muted: true }))).toBe(false);
    expect(controller.receive(frame(1, { type: "session.state", state: "listening", provider: "openai" }))).toBe(false);
    expect(controller.receive({ type: "session.state", state: "listening", epoch: 4, sequence: 1 })).toBe(false);
    expect(controller.receive("session.state")).toBe(false);
    expect(controller.receive(null)).toBe(false);
    expect(controller.getState()).toBe(before);
  });

  it("validates constructor options and defaults the session identifier", () => {
    expect(() => new VoiceSessionController({ initialEpoch: 0 })).toThrow(TypeError);
    expect(() => new VoiceSessionController({ initialEpoch: -1 })).toThrow(TypeError);
    expect(() => new VoiceSessionController({ initialEpoch: 1.5 })).toThrow(TypeError);
    expect(() => new VoiceSessionController({ initialEpoch: 1, sessionId: "not-prefixed" })).toThrow(TypeError);
    expect(() => new VoiceSessionController({ initialEpoch: 1, initialTurnMode: "always_on" as never })).toThrow(TypeError);

    const controller = new VoiceSessionController({ initialEpoch: 1 });
    expect(controller.receive(frame(1, { type: "session.state", state: "listening" }, 1, "vs_client"))).toBe(true);
    expect(controller.receive(frame(2, { type: "session.state", state: "listening" }, 1, SESSION_ID))).toBe(false);
    expect(controller.getState()).toMatchObject({ turnMode: "hands_free", state: "listening" });
  });

  it("orders push-to-talk commands and keeps pause, interruption, and end distinct", () => {
    const commands: VoiceSessionCommand[] = [];
    const controller = new VoiceSessionController({
      initialEpoch: 4,
      sessionId: SESSION_ID,
      initialTurnMode: "push_to_talk",
      onCommand: (command) => commands.push(command),
    });
    expect(controller.getState().turnMode).toBe("push_to_talk");
    controller.receive(frame(1, { type: "session.state", state: "listening" }));
    controller.receive(frame(2, { type: "response.started", responseId: "vresp_1", runId: "run_1" }));

    controller.beginPushToTalk();
    expect(controller.getState().pushToTalkActive).toBe(true);
    controller.endPushToTalk();
    controller.pause();
    controller.resume();
    controller.stopSpeaking(120);
    controller.end();

    expect(commands).toEqual([
      { type: "capture.start", mode: "push_to_talk" },
      { type: "capture.stop" },
      { type: "session.pause" },
      { type: "session.resume" },
      { type: "response.interrupt", responseId: "vresp_1", playedThroughMs: 120 },
      { type: "session.end" },
    ]);
    expect(controller.getState()).toMatchObject({
      state: "ended",
      muted: true,
      pushToTalkActive: false,
      provisionalTranscript: null,
      toolLabel: null,
    });
  });

  it("emits retry only from failed and always allows continue-in-chat", () => {
    const onCommand = vi.fn();
    const controller = new VoiceSessionController({ initialEpoch: 4, sessionId: SESSION_ID, onCommand });
    controller.retry();
    controller.receive(frame(1, { type: "session.state", state: "listening" }));
    controller.retry();
    expect(onCommand).not.toHaveBeenCalled();

    controller.receive(frame(2, {
      type: "session.error",
      code: "connection_lost",
      recovery: "retry_connection",
      retryable: true,
    }));
    controller.retry();
    controller.continueInChat();
    expect(onCommand.mock.calls.map(([command]) => command)).toEqual([
      { type: "session.retry" },
      { type: "continue_in_chat" },
    ]);
  });

  it("caps listeners at 32 and clears all listeners on dispose", () => {
    const controller = new VoiceSessionController({ initialEpoch: 4, sessionId: SESSION_ID });
    const listeners = Array.from({ length: 32 }, () => vi.fn());
    listeners.forEach((listener) => controller.subscribe(listener));
    expect(() => controller.subscribe(vi.fn())).toThrow(/32/);

    controller.receive(frame(1, { type: "session.state", state: "listening" }));
    expect(listeners.every((listener) => listener.mock.calls.length === 1)).toBe(true);
    controller.dispose();
    expect(controller.getState()).toMatchObject({ state: "ended", pushToTalkActive: false });
    expect(controller.receive(frame(2, { type: "session.state", state: "failed" }))).toBe(false);
    expect(() => controller.subscribe(vi.fn())).not.toThrow();
  });

  it("rejects every valid frame after the session ends", () => {
    const controller = new VoiceSessionController({ initialEpoch: 4, sessionId: SESSION_ID });
    controller.receive(frame(1, { type: "session.state", state: "ended" }));
    const ended = controller.getState();

    expect(controller.receive(frame(2, { type: "session.state", state: "listening" }))).toBe(false);
    expect(controller.receive(frame(1, { type: "session.state", state: "listening" }, 5))).toBe(false);
    expect(controller.receive(frame(3, {
      type: "session.error",
      code: "internal_failure",
      recovery: "none",
      retryable: false,
    }, 9))).toBe(false);
    expect(controller.getState()).toBe(ended);
  });

  it("applies newer corrections to a matching draft and ignores stale or other turns", () => {
    const controller = new VoiceSessionController({ initialEpoch: 4, sessionId: SESSION_ID });
    controller.receive(frame(1, {
      type: "transcript.provisional",
      turnId: "vturn_1",
      revision: 2,
      text: "first draft",
    }));
    controller.receive(frame(2, {
      type: "transcript.correction",
      turnId: "vturn_1",
      finalityId: "vfinal_1",
      revision: 4,
      text: "corrected draft",
    }));
    expect(controller.getState().provisionalTranscript).toEqual({
      turnId: "vturn_1",
      revision: 4,
      text: "corrected draft",
    });

    controller.receive(frame(3, {
      type: "transcript.correction",
      turnId: "vturn_1",
      finalityId: "vfinal_1",
      revision: 3,
      text: "stale correction",
    }));
    controller.receive(frame(4, {
      type: "transcript.correction",
      turnId: "vturn_other",
      finalityId: "vfinal_other",
      revision: 9,
      text: "other turn",
    }));
    expect(controller.getState().provisionalTranscript).toEqual({
      turnId: "vturn_1",
      revision: 4,
      text: "corrected draft",
    });
  });

  it("truncates presentation text by code points without lone surrogates", () => {
    const controller = new VoiceSessionController({ initialEpoch: 4, sessionId: SESSION_ID });
    controller.receive(frame(1, {
      type: "transcript.provisional",
      turnId: "vturn_1",
      revision: 1,
      text: "a".repeat(499) + "😀".repeat(100),
    }));
    const text = controller.getState().provisionalTranscript?.text ?? "";
    expect([...text].length).toBe(500);
    expect(text.endsWith("😀")).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)).toBe(false);
  });

  it("emits played-through position with stop and nothing for invalid values", () => {
    const commands: VoiceSessionCommand[] = [];
    const controller = new VoiceSessionController({
      initialEpoch: 4,
      sessionId: SESSION_ID,
      onCommand: (command) => commands.push(command),
    });
    controller.receive(frame(1, { type: "response.started", responseId: "vresp_1", runId: "run_1" }));

    controller.stopSpeaking(-1);
    controller.stopSpeaking(1.5);
    controller.stopSpeaking(Number.NaN);
    expect(commands).toEqual([]);

    controller.stopSpeaking(640);
    expect(commands).toEqual([
      { type: "response.interrupt", responseId: "vresp_1", playedThroughMs: 640 },
    ]);
  });
});
