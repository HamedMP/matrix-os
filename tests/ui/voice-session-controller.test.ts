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
  it("keeps an explicit local pause while pre-pause activity frames arrive", () => {
    const controller = new VoiceSessionController({ initialEpoch: 4, sessionId: SESSION_ID });
    controller.receive(frame(1, { type: "session.state", state: "using_tool" }));
    controller.pause();
    for (const [index, state] of ["using_tool", "speaking", "listening"].entries()) {
      controller.receive(frame(index + 2, { type: "session.state", state }));
      expect(controller.getState()).toMatchObject({ state: "paused", muted: true });
    }
    controller.receive(frame(1, { type: "session.resumed", state: "thinking", reason: "restored" }, 5));
    expect(controller.getState()).toMatchObject({ state: "paused", muted: true, epoch: 5 });
    controller.resume();
    controller.receive(frame(2, { type: "session.state", state: "listening" }, 5));
    expect(controller.getState()).toMatchObject({ state: "listening", muted: false });
  });

  it("fences stale epochs and duplicate or non-monotonic sequences", () => {
    const controller = new VoiceSessionController({ initialEpoch: 4, sessionId: SESSION_ID });

    expect(controller.receive(frame(1, { type: "session.state", state: "listening" }))).toBe(true);
    expect(controller.receive(frame(1, { type: "session.state", state: "failed" }))).toBe(false);
    expect(controller.receive(frame(0, { type: "session.state", state: "failed" }))).toBe(false);
    expect(controller.receive(frame(20, { type: "session.state", state: "failed" }, 3))).toBe(false);
    expect(controller.getState().state).toBe("listening");

    expect(controller.receive(frame(99, { type: "session.state", state: "speaking" }, 3))).toBe(false);
  });

  it("advances the epoch only through an explicit session.resumed transition", () => {
    const controller = new VoiceSessionController({ initialEpoch: 4, sessionId: SESSION_ID });
    controller.receive(frame(1, { type: "session.state", state: "listening" }));
    controller.receive(frame(2, {
      type: "transcript.provisional",
      turnId: "vturn_1",
      revision: 1,
      text: "draft",
    }));
    controller.receive(frame(3, { type: "response.started", responseId: "vresp_1", runId: "run_1" }));

    // A future-epoch frame without the resume transition is fenced and the
    // current epoch keeps accepting legitimate frames.
    expect(controller.receive(frame(1, { type: "session.state", state: "failed" }, 9))).toBe(false);
    expect(controller.receive(frame(2, {
      type: "transcript.provisional",
      turnId: "vturn_1",
      revision: 2,
      text: "attacker draft",
    }, 9))).toBe(false);
    expect(controller.getState()).toMatchObject({ epoch: 4, state: "listening" });
    expect(controller.getState().provisionalTranscript).toMatchObject({ revision: 1, text: "draft" });
    expect(controller.receive(frame(4, { type: "session.state", state: "thinking" }))).toBe(true);

    // The designated resume transition advances the epoch, restarts the
    // sequence, changes lifecycle state, and clears ephemeral projections.
    expect(controller.receive(frame(1, { type: "session.resumed", state: "listening", reason: "restored" }, 5))).toBe(true);
    expect(controller.getState()).toMatchObject({
      epoch: 5,
      sequence: 1,
      state: "listening",
      provisionalTranscript: null,
      toolLabel: null,
    });
    expect(controller.receive(frame(2, { type: "session.state", state: "thinking" }, 5))).toBe(true);
    expect(controller.receive(frame(1, { type: "session.resumed", state: "listening" }, 5))).toBe(false);
    expect(controller.receive(frame(3, { type: "session.state", state: "failed" }, 4))).toBe(false);
    expect(controller.getState()).toMatchObject({ epoch: 5, state: "thinking" });
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
    controller.receive(frame(3, {
      type: "response.audio",
      responseId: "vresp_1",
      segmentId: "vseg_1",
      startMs: 0,
      data: Buffer.from("segment-1").toString("base64"),
    }));

    controller.beginPushToTalk();
    expect(controller.getState().pushToTalkActive).toBe(true);
    controller.endPushToTalk();
    controller.pause();
    controller.resume();
    controller.acknowledgePlayback({
      responseId: "vresp_1",
      segmentId: "vseg_1",
      deliveryRevision: 1,
      playedThroughMs: 120,
    });
    controller.stopSpeaking();
    controller.end();

    expect(commands).toEqual([
      { type: "capture.start", mode: "push_to_talk" },
      { type: "capture.stop" },
      { type: "session.pause" },
      { type: "session.resume" },
      {
        type: "playback.segment_played",
        responseId: "vresp_1",
        segmentId: "vseg_1",
        deliveryRevision: 1,
        playedThroughMs: 120,
      },
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

  it("reports the acknowledged playback boundary when speech is stopped", () => {
    const commands: VoiceSessionCommand[] = [];
    const controller = new VoiceSessionController({
      initialEpoch: 4,
      sessionId: SESSION_ID,
      onCommand: (command) => commands.push(command),
    });
    controller.receive(frame(1, { type: "response.started", responseId: "vresp_1", runId: "run_1" }));
    controller.receive(frame(2, {
      type: "response.audio",
      responseId: "vresp_1",
      segmentId: "vseg_1",
      startMs: 0,
      data: Buffer.from("segment-1").toString("base64"),
    }));
    controller.receive(frame(3, {
      type: "response.audio",
      responseId: "vresp_1",
      segmentId: "vseg_2",
      startMs: 240,
      data: Buffer.from("segment-2").toString("base64"),
    }));

    // No acknowledgement yet: nothing has been heard, and invalid or
    // foreign-response acknowledgements do not move the boundary. A segment
    // that was never buffered for this response cannot inflate it either.
    expect(controller.acknowledgePlayback({
      responseId: "vresp_other",
      segmentId: "vseg_1",
      deliveryRevision: 1,
      playedThroughMs: 240,
    })).toBe(false);
    expect(controller.acknowledgePlayback({
      responseId: "vresp_1",
      segmentId: "vseg_1",
      deliveryRevision: 1,
      playedThroughMs: -1,
    })).toBe(false);
    expect(controller.acknowledgePlayback({
      responseId: "vresp_1",
      segmentId: "vseg_9",
      deliveryRevision: 1,
      playedThroughMs: 999_999,
    })).toBe(false);
    controller.stopSpeaking();
    expect(commands).toEqual([
      { type: "response.interrupt", responseId: "vresp_1", playedThroughMs: 0 },
    ]);

    controller.receive(frame(4, { type: "response.started", responseId: "vresp_2", runId: "run_1" }));
    controller.receive(frame(5, {
      type: "response.audio",
      responseId: "vresp_2",
      segmentId: "vseg_3",
      startMs: 0,
      data: Buffer.from("segment-3").toString("base64"),
    }));
    expect(controller.acknowledgePlayback({
      responseId: "vresp_2",
      segmentId: "vseg_3",
      deliveryRevision: 1,
      playedThroughMs: 640,
    })).toBe(true);
    // A replayed acknowledgement for the same segment cannot re-apply.
    expect(controller.acknowledgePlayback({
      responseId: "vresp_2",
      segmentId: "vseg_3",
      deliveryRevision: 2,
      playedThroughMs: 999_999,
    })).toBe(false);
    controller.stopSpeaking();
    expect(commands).toEqual([
      { type: "response.interrupt", responseId: "vresp_1", playedThroughMs: 0 },
      {
        type: "playback.segment_played",
        responseId: "vresp_2",
        segmentId: "vseg_3",
        deliveryRevision: 1,
        playedThroughMs: 640,
      },
      { type: "response.interrupt", responseId: "vresp_2", playedThroughMs: 640 },
    ]);
  });

  it("keeps response identity until buffered playback drains after audio_end", () => {
    const commands: VoiceSessionCommand[] = [];
    const controller = new VoiceSessionController({
      initialEpoch: 4,
      sessionId: SESSION_ID,
      onCommand: (command) => commands.push(command),
    });
    controller.receive(frame(1, { type: "response.started", responseId: "vresp_1", runId: "run_1" }));
    controller.receive(frame(2, {
      type: "response.audio",
      responseId: "vresp_1",
      segmentId: "vseg_1",
      startMs: 0,
      data: Buffer.from("segment-1").toString("base64"),
    }));
    controller.receive(frame(3, {
      type: "response.audio",
      responseId: "vresp_1",
      segmentId: "vseg_2",
      startMs: 480,
      data: Buffer.from("segment-2").toString("base64"),
    }));
    controller.receive(frame(4, {
      type: "response.audio_end",
      responseId: "vresp_1",
      generatedDurationMs: 720,
    }));

    // Generation ended but a buffered segment is still audible: identity is
    // retained, acknowledgement lands, and interruption reports the true
    // heard boundary instead of zero.
    expect(controller.acknowledgePlayback({
      responseId: "vresp_1",
      segmentId: "vseg_1",
      deliveryRevision: 1,
      playedThroughMs: 480,
    })).toBe(true);
    controller.stopSpeaking();
    expect(commands).toEqual([
      {
        type: "playback.segment_played",
        responseId: "vresp_1",
        segmentId: "vseg_1",
        deliveryRevision: 1,
        playedThroughMs: 480,
      },
      { type: "response.interrupt", responseId: "vresp_1", playedThroughMs: 480 },
    ]);
  });

  it("keeps the newer provisional revision when a replayed draft arrives", () => {
    const controller = new VoiceSessionController({ initialEpoch: 4, sessionId: SESSION_ID });
    controller.receive(frame(1, {
      type: "transcript.provisional",
      turnId: "vturn_1",
      revision: 3,
      text: "newer draft",
    }));
    controller.receive(frame(2, {
      type: "transcript.provisional",
      turnId: "vturn_1",
      revision: 1,
      text: "stale replay",
    }));
    controller.receive(frame(3, {
      type: "transcript.provisional",
      turnId: "vturn_1",
      revision: 3,
      text: "same revision replay",
    }));
    controller.receive(frame(4, {
      type: "transcript.provisional",
      turnId: "vturn_2",
      revision: 0,
      text: "next turn draft",
    }));
    expect(controller.getState().provisionalTranscript).toEqual({
      turnId: "vturn_2",
      revision: 0,
      text: "next turn draft",
    });
  });

  it("emits capture.stop when end or dispose follows an active hold", () => {
    const commands: VoiceSessionCommand[] = [];
    const controller = new VoiceSessionController({
      initialEpoch: 4,
      sessionId: SESSION_ID,
      initialTurnMode: "push_to_talk",
      onCommand: (command) => commands.push(command),
    });
    controller.receive(frame(1, { type: "session.state", state: "listening" }));
    controller.beginPushToTalk();
    controller.end();
    expect(commands).toEqual([
      { type: "capture.start", mode: "push_to_talk" },
      { type: "capture.stop" },
      { type: "session.end" },
    ]);

    const disposeCommands: VoiceSessionCommand[] = [];
    const second = new VoiceSessionController({
      initialEpoch: 4,
      sessionId: SESSION_ID,
      initialTurnMode: "push_to_talk",
      onCommand: (command) => disposeCommands.push(command),
    });
    second.receive(frame(1, { type: "session.state", state: "listening" }));
    second.beginPushToTalk();
    second.dispose();
    expect(disposeCommands).toEqual([
      { type: "capture.start", mode: "push_to_talk" },
      { type: "capture.stop" },
    ]);
  });
});
