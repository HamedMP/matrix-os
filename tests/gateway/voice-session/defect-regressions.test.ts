/**
 * Regression tests for the production defects found in the voice-session
 * seam review (chat authority / delivery ledger / transport epochs / turn
 * ordering / tracking caps). Each `it` names the invariant it restores.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { VoiceServerFrame } from "@matrix-os/contracts/voice-session";
import {
  CHAT_ID,
  PRINCIPAL,
  clientFrame,
  framesOfType,
  lastFrame,
  listeningSession,
  makeRig,
  makeSink,
  flush,
  resetFrameSeq,
  type VoiceTestRig,
} from "./fakes.js";

type Attached = Awaited<ReturnType<typeof listeningSession>>;

/** Admit one spoken turn through the adapter event port. */
async function admitTurn(rig: VoiceTestRig, attached: Attached, turnId: string, text: string) {
  const { handle, sessionId, epoch } = attached;
  await handle.receive(clientFrame(sessionId, epoch, {
    type: "capture.start", turnId, mode: "hands_free",
  }));
  rig.adapter.emit({ type: "transcript.final", turnId, finalityId: `vfinal_${turnId}`, text });
  await flush(rig, sessionId);
}

/** Drive a session to an open response ledger with one synthesized segment. */
async function speaking(rig: VoiceTestRig) {
  const s = await listeningSession(rig);
  await admitTurn(rig, s, "vturn_1", "speak");
  const runId = rig.admission.results[0]?.runId ?? "run_1";
  rig.events.emit({ type: "assistant.text", runId, text: "first clause. ", textStart: 0, textEnd: 14 });
  await flush(rig, s.sessionId);
  const started = lastFrame(s.sink, "response.started") as Extract<VoiceServerFrame, { type: "response.started" }>;
  return { s, runId, responseId: started.responseId };
}

/** Reconnect through the real ticket path and attach a fresh sink. */
async function reconnect(rig: VoiceTestRig, s: Attached) {
  const result = rig.engine.reconnectSession({ principal: PRINCIPAL, chatId: CHAT_ID, sessionId: s.sessionId });
  const consumed = rig.tickets.consume(result.lease.ticket, {
    path: result.lease.path, sessionId: s.sessionId, chatId: CHAT_ID,
  });
  const sink = makeSink();
  const handle = rig.engine.attachTransport({
    sessionId: s.sessionId, chatId: CHAT_ID, principalId: PRINCIPAL.userId,
    generation: consumed.binding.generation,
  }, sink);
  return { sink, handle, epoch: result.lease.epoch };
}

describe("canonical revision truth", () => {
  let rig: VoiceTestRig;
  beforeEach(() => {
    resetFrameSeq();
    rig = makeRig();
  });

  it("hydrates the real chat revision before the first admission (chat with history admits)", async () => {
    rig.admission.chatRevision = 7;
    rig.admission.requireExactRevision = true;
    const s = await listeningSession(rig);
    await admitTurn(rig, s, "vturn_1", "hello");
    expect(rig.admission.revisionLoads).toHaveLength(1);
    expect(rig.admission.calls).toHaveLength(1);
    expect(rig.admission.calls[0]?.baseRevision).toBe(7);
    expect(lastFrame(s.sink, "transcript.final")).toMatchObject({ canonicalTurnId: "cturn_1" });
  });

  it("loads the revision lazily and at most once per session", async () => {
    rig.admission.chatRevision = 3;
    const s = await listeningSession(rig);
    expect(rig.admission.revisionLoads).toHaveLength(0);
    await admitTurn(rig, s, "vturn_1", "one");
    rig.events.emit({ type: "run.terminal", runId: "run_1", state: "succeeded" });
    await flush(rig, s.sessionId);
    await admitTurn(rig, s, "vturn_2", "two");
    expect(rig.admission.revisionLoads).toHaveLength(1);
  });
});

describe("non-admitted capture terminalization", () => {
  beforeEach(() => resetFrameSeq());

  it("emits exactly one failed completion for a canonical rejection", async () => {
    const rig = makeRig();
    rig.admission.push({
      outcome: "rejected",
      revision: 1,
      error: { code: "chat_unavailable", retryable: true, recovery: "continue_in_chat" },
    });
    const s = await listeningSession(rig);
    await admitTurn(rig, s, "vturn_rejected", "reject this");

    expect(framesOfType(s.sink, "capture.completed")).toEqual([
      expect.objectContaining({ turnId: "vturn_rejected", outcome: "failed" }),
    ]);
  });

  it("emits exactly one failed completion when canonical admission throws", async () => {
    const rig = makeRig();
    rig.admission.failWith = new Error("canonical unavailable");
    const s = await listeningSession(rig);
    await admitTurn(rig, s, "vturn_exception", "try this");

    expect(framesOfType(s.sink, "capture.completed")).toEqual([
      expect.objectContaining({ turnId: "vturn_exception", outcome: "failed" }),
    ]);
  });

  it("does not duplicate completion when the adapter already terminalized the capture", async () => {
    const rig = makeRig();
    const s = await listeningSession(rig);
    await s.handle.receive(clientFrame(s.sessionId, s.epoch, {
      type: "capture.start", turnId: "vturn_terminal", mode: "hands_free",
    }));
    rig.adapter.emit({ type: "capture.completed", turnId: "vturn_terminal", outcome: "failed" });
    rig.adapter.emit({
      type: "transcript.final",
      turnId: "vturn_terminal",
      finalityId: "vfinal_terminal",
      text: "late final",
    });
    await flush(rig, s.sessionId);

    expect(framesOfType(s.sink, "capture.completed")).toEqual([
      expect.objectContaining({ turnId: "vturn_terminal", outcome: "failed" }),
    ]);
    expect(rig.admission.calls).toHaveLength(0);
  });
});

describe("delivery manifest durability", () => {
  let rig: VoiceTestRig;
  beforeEach(() => {
    resetFrameSeq();
    rig = makeRig();
  });

  it("persists pending WITH the first segment and extends the manifest per later clause", async () => {
    const { s, runId, responseId } = await speaking(rig);
    // The pending row was written with exactly the first segment — never an
    // empty manifest that violates the repository minimum.
    expect(rig.delivery.pendings).toHaveLength(1);
    expect(rig.delivery.pendings[0]?.segments).toHaveLength(1);
    expect(rig.delivery.pendings[0]?.segments[0]?.textEnd).toBe(14);

    rig.events.emit({ type: "assistant.text", runId, text: "second clause.", textStart: 14, textEnd: 28 });
    await flush(rig, s.sessionId);
    expect(rig.delivery.extensions).toHaveLength(1);
    expect(rig.delivery.extensions[0]?.appendSegments).toHaveLength(1);
    expect(rig.delivery.extensions[0]?.appendSegments[0]?.textStart).toBe(14);
    expect(rig.delivery.row(responseId)?.segments).toHaveLength(2);
    expect(rig.adapter.sessions[0]?.synths).toHaveLength(2);
  });

  it("assembles model deltas into one natural synthesis phrase", async () => {
    const s = await listeningSession(rig);
    await admitTurn(rig, s, "vturn_1", "speak");
    const runId = rig.admission.results[0]?.runId ?? "run_1";
    rig.events.emit({ type: "assistant.text", runId, text: "Hello ", textStart: 0, textEnd: 6 });
    rig.events.emit({ type: "assistant.text", runId, text: "from the model.", textStart: 6, textEnd: 21 });
    await flush(rig, s.sessionId);
    expect(rig.adapter.sessions[0]?.synths).toHaveLength(1);
    expect(rig.adapter.sessions[0]?.synths[0]?.text).toBe("Hello from the model.");
  });

  it("splits an oversized model delta into bounded synthesis phrases", async () => {
    const s = await listeningSession(rig);
    await admitTurn(rig, s, "vturn_1", "speak");
    const runId = rig.admission.results[0]?.runId ?? "run_1";
    const text = `${"word ".repeat(70)}done.`;
    rig.events.emit({ type: "assistant.text", runId, text, textStart: 0, textEnd: text.length });
    await flush(rig, s.sessionId);

    const synths = rig.adapter.sessions[0]?.synths ?? [];
    expect(synths.length).toBeGreaterThan(1);
    expect(synths.every((command) => [...command.text].length <= 240)).toBe(true);
    expect(synths.map((command) => command.text).join("")).toBe(text);
  });

  it("orders every durable manifest write before the matching synthesize call", async () => {
    const s = await listeningSession(rig);
    const order: string[] = [];
    const session = rig.adapter.sessions[0]!;
    const originalSynthesize = session.synthesize;
    session.synthesize = (command) => {
      order.push(`synthesize:${command.segment.segmentId}`);
      originalSynthesize(command);
    };
    const recordPending = rig.delivery.recordPending.bind(rig.delivery);
    rig.delivery.recordPending = async (input) => {
      order.push("recordPending");
      return recordPending(input);
    };
    const extendManifest = rig.delivery.extendManifest.bind(rig.delivery);
    rig.delivery.extendManifest = async (input) => {
      order.push(`extendManifest:${input.appendSegments[0]?.segmentId}`);
      return extendManifest(input);
    };

    await admitTurn(rig, s, "vturn_1", "speak");
    const runId = rig.admission.results[0]?.runId ?? "run_1";
    rig.events.emit({ type: "assistant.text", runId, text: "one. ", textStart: 0, textEnd: 5 });
    rig.events.emit({ type: "assistant.text", runId, text: "two.", textStart: 5, textEnd: 9 });
    await flush(rig, s.sessionId);

    expect(order[0]).toBe("recordPending");
    expect(order[1]).toMatch(/^synthesize:vseg_/);
    expect(order[2]).toMatch(/^extendManifest:vseg_/);
    expect(order[3]).toBe(order[2].replace("extendManifest:", "synthesize:"));
  });

  it("fails the response instead of tracking playback when the pending write fails", async () => {
    const s = await listeningSession(rig);
    rig.delivery.pendingError = new Error("delivery store down");
    await admitTurn(rig, s, "vturn_1", "speak");
    const runId = rig.admission.results[0]?.runId ?? "run_1";
    rig.events.emit({ type: "assistant.text", runId, text: "one.", textStart: 0, textEnd: 4 });
    await flush(rig, s.sessionId);

    expect(framesOfType(s.sink, "response.started")).toHaveLength(0);
    expect(rig.adapter.sessions[0]?.synths).toHaveLength(0);
    expect(lastFrame(s.sink, "session.error")).toMatchObject({ code: "chat_unavailable" });
    // Best-effort terminal classification — the row backfills as unknown.
    expect(rig.delivery.terminals.at(-1)?.reason).toBe("unknown");
  });

  it("stops synthesis and reports when a later manifest extension fails", async () => {
    const { s, runId, responseId } = await speaking(rig);
    rig.delivery.extendError = new Error("manifest write lost");
    rig.events.emit({ type: "assistant.text", runId, text: "two.", textStart: 14, textEnd: 18 });
    await flush(rig, s.sessionId);

    // The segment is NOT synthesized; the client sees the response end.
    expect(rig.adapter.sessions[0]?.synths).toHaveLength(1);
    expect(lastFrame(s.sink, "session.error")).toMatchObject({ code: "chat_unavailable" });
    expect(lastFrame(s.sink, "response.interrupted")).toMatchObject({ responseId });
    expect(rig.delivery.terminals.at(-1)?.reason).toBe("unknown");
    expect(rig.delivery.row(responseId)?.state).toBe("unknown");
  });

  it("does not relay audio when the delivered boundary cannot persist", async () => {
    const { s, responseId } = await speaking(rig);
    const segmentId = rig.adapter.sessions[0]!.synths[0]!.segmentId;
    rig.delivery.deliveredError = new Error("delivered write lost");
    rig.adapter.emit({ type: "synthesis.audio", responseId, segmentId, startMs: 0, durationMs: 100, data: "AAAA" });
    await flush(rig, s.sessionId);

    expect(framesOfType(s.sink, "response.audio")).toHaveLength(0);
    expect(lastFrame(s.sink, "session.error")).toMatchObject({ code: "chat_unavailable" });
    expect(lastFrame(s.sink, "response.interrupted")).toMatchObject({ responseId });
  });
});

describe("transport epoch adoption and absolute deadlines", () => {
  let rig: VoiceTestRig;
  beforeEach(() => {
    resetFrameSeq();
    rig = makeRig();
  });

  it("adopts the new epoch for open deliveries so post-reconnect acks succeed", async () => {
    const { s, responseId } = await speaking(rig);
    const segmentId = rig.adapter.sessions[0]!.synths[0]!.segmentId;
    rig.adapter.emit({ type: "synthesis.audio", responseId, segmentId, startMs: 0, durationMs: 50, data: "AAAA" });
    await flush(rig, s.sessionId);
    expect(rig.delivery.row(responseId)?.transportEpoch).toBe(1);

    const second = await reconnect(rig, s);
    await flush(rig, s.sessionId);
    expect(rig.delivery.adoptions.length).toBeGreaterThan(0);
    expect(rig.delivery.adoptions[0]?.transportEpoch).toBe(2);
    expect(rig.delivery.row(responseId)?.transportEpoch).toBe(2);

    await second.handle.receive(clientFrame(s.sessionId, second.epoch, {
      type: "playback.segment_played", responseId, segmentId, deliveryRevision: 99, playedThroughMs: 50,
    }));
    await flush(rig, s.sessionId);
    expect(rig.delivery.acks).toHaveLength(1);
    expect(rig.delivery.acks[0]?.transportEpoch).toBe(2);
    expect(rig.delivery.row(responseId)?.acknowledgedIndex).toBe(0);
  });

  it("failed->retry never extends the absolute duration deadline", async () => {
    const limited = makeRig({ limits: { maxSessionSeconds: 5, maxIdleSeconds: 3_600 } });
    const s = await listeningSession(limited);

    const failSession = async (attached: Attached) => {
      limited.adapter.emit({ type: "error", code: "internal_failure", retryable: false, fatal: true });
      await flush(limited, attached.sessionId);
      expect(limited.engine.describeSession({
        principal: PRINCIPAL, chatId: CHAT_ID, sessionId: attached.sessionId,
      })?.status).toBe("failed");
    };
    const retry = async (attached: Attached) => {
      const again = await reconnect(limited, attached);
      await again.handle.receive(clientFrame(attached.sessionId, again.epoch, {
        type: "client.ready",
        audio: { codec: "pcm_s16le", sampleRateHz: 16_000, channels: 1, frameDurationMs: 20 },
        capabilities: { formats: [{ codec: "pcm_s16le", sampleRateHz: 16_000, channels: 1, frameDurationMs: 20 }], binaryAudio: false, maxAudioFrameBytes: 65_536, deviceChangeEvents: false },
      }));
      await flush(limited, attached.sessionId);
      return { ...attached, sink: again.sink, handle: again.handle, epoch: again.epoch };
    };

    // t=2s: fail, retry, get back to listening.
    limited.clock.advance(2_000);
    await failSession(s);
    let live = await retry(s);
    // t=3s: fail again and retry once more.
    limited.clock.advance(1_000);
    await failSession(live);
    live = await retry(live);
    expect(limited.engine.describeSession({
      principal: PRINCIPAL, chatId: CHAT_ID, sessionId: s.sessionId,
    })?.status).toBe("listening");

    // The absolute deadline is createdAt+5s regardless of the two retries.
    limited.clock.advance(1_999);
    await flush(limited, s.sessionId);
    expect(limited.engine.describeSession({
      principal: PRINCIPAL, chatId: CHAT_ID, sessionId: s.sessionId,
    })?.status).toBe("listening");
    limited.clock.advance(1);
    await flush(limited, s.sessionId);
    expect(limited.engine.describeSession({
      principal: PRINCIPAL, chatId: CHAT_ID, sessionId: s.sessionId,
    })?.status).toBe("failed");
    expect(framesOfType(live.sink, "session.state").at(-1))
      .toMatchObject({ state: "failed", reason: "limit_reached" });
  });
});

describe("contiguous acknowledgement", () => {
  let rig: VoiceTestRig;
  beforeEach(() => {
    resetFrameSeq();
    rig = makeRig();
  });

  it("rejects a skip-ack and still completes on contiguous acks", async () => {
    const { s, runId, responseId } = await speaking(rig);
    rig.events.emit({ type: "assistant.text", runId, text: "two.", textStart: 14, textEnd: 18 });
    await flush(rig, s.sessionId);
    const [seg0, seg1] = rig.delivery.row(responseId)!.segments;

    // Skip-ack segment 1 while segment 0 is unacknowledged.
    await s.handle.receive(clientFrame(s.sessionId, s.epoch, {
      type: "playback.segment_played", responseId, segmentId: seg1!.segmentId, deliveryRevision: 2, playedThroughMs: 10,
    }));
    await flush(rig, s.sessionId);
    expect(rig.delivery.row(responseId)?.acknowledgedIndex).toBe(-1);
    expect(rig.logs.map((entry) => entry.fields.kind)).toContain("ack_out_of_order");

    // Contiguous acks reach `complete`.
    rig.adapter.emit({ type: "synthesis.audio", responseId, segmentId: seg0!.segmentId, startMs: 0, durationMs: 50, data: "AAAA" });
    rig.adapter.emit({ type: "synthesis.audio", responseId, segmentId: seg1!.segmentId, startMs: 50, durationMs: 50, data: "AAAA" });
    rig.adapter.emit({ type: "synthesis.end", responseId, segmentId: seg0!.segmentId, generatedDurationMs: 50 });
    rig.adapter.emit({ type: "synthesis.end", responseId, segmentId: seg1!.segmentId, generatedDurationMs: 100 });
    rig.events.emit({ type: "run.terminal", runId, state: "succeeded" });
    await flush(rig, s.sessionId);
    for (const segmentId of [seg0!.segmentId, seg1!.segmentId]) {
      await s.handle.receive(clientFrame(s.sessionId, s.epoch, {
        type: "playback.segment_played", responseId, segmentId, deliveryRevision: 0, playedThroughMs: 100,
      }));
    }
    await flush(rig, s.sessionId);
    expect(rig.delivery.row(responseId)?.acknowledgedIndex).toBe(1);
    expect(rig.delivery.terminals.at(-1)?.reason).toBe("complete");
    expect(rig.delivery.row(responseId)?.state).toBe("complete");
  });

  it("keeps a response open when segment one plays before later canonical text arrives", async () => {
    const { s, runId, responseId } = await speaking(rig);
    const first = rig.delivery.row(responseId)!.segments[0]!;
    rig.adapter.emit({
      type: "synthesis.audio", responseId, segmentId: first.segmentId,
      startMs: 0, durationMs: 50, data: "AAAA",
    });
    rig.adapter.emit({
      type: "synthesis.end", responseId, segmentId: first.segmentId, generatedDurationMs: 50,
    });
    await flush(rig, s.sessionId);
    await s.handle.receive(clientFrame(s.sessionId, s.epoch, {
      type: "playback.segment_played", responseId, segmentId: first.segmentId,
      deliveryRevision: 0, playedThroughMs: 50,
    }));
    await flush(rig, s.sessionId);
    expect(rig.delivery.terminals).toHaveLength(0);
    expect(rig.delivery.row(responseId)?.segments[0]?.durationMs).toBe(50);

    rig.events.emit({ type: "assistant.text", runId, text: "second clause.", textStart: 14, textEnd: 28 });
    await flush(rig, s.sessionId);
    const second = rig.delivery.row(responseId)!.segments[1]!;
    rig.adapter.emit({
      type: "synthesis.audio", responseId, segmentId: second.segmentId,
      startMs: 50, durationMs: 50, data: "AAAA",
    });
    rig.adapter.emit({
      type: "synthesis.end", responseId, segmentId: second.segmentId, generatedDurationMs: 100,
    });
    rig.events.emit({ type: "run.terminal", runId, state: "succeeded" });
    await flush(rig, s.sessionId);
    await s.handle.receive(clientFrame(s.sessionId, s.epoch, {
      type: "playback.segment_played", responseId, segmentId: second.segmentId,
      deliveryRevision: 0, playedThroughMs: 100,
    }));
    await flush(rig, s.sessionId);
    expect(rig.delivery.terminals.at(-1)?.reason).toBe("complete");
  });
});

describe("finals ordered by capture localOrder", () => {
  let rig: VoiceTestRig;
  beforeEach(() => {
    resetFrameSeq();
    rig = makeRig();
  });

  async function startThenStop(s: Attached, turnId: string) {
    await s.handle.receive(clientFrame(s.sessionId, s.epoch, {
      type: "capture.start", turnId, mode: "hands_free",
    }));
    await s.handle.receive(clientFrame(s.sessionId, s.epoch, { type: "capture.stop", turnId }));
  }

  it("admits in capture order when the provider finishes turn 2 first", async () => {
    const s = await listeningSession(rig);
    await startThenStop(s, "vturn_1");
    await s.handle.receive(clientFrame(s.sessionId, s.epoch, {
      type: "capture.start", turnId: "vturn_2", mode: "hands_free",
    }));
    // Provider completes turn 2 first: the final stages, no admission yet.
    rig.adapter.emit({ type: "transcript.final", turnId: "vturn_2", finalityId: "vfinal_2", text: "second" });
    await flush(rig, s.sessionId);
    expect(rig.admission.calls).toHaveLength(0);
    rig.adapter.emit({ type: "transcript.final", turnId: "vturn_1", finalityId: "vfinal_1", text: "first" });
    await flush(rig, s.sessionId);
    expect(rig.admission.calls.map((call) => call.transcript)).toEqual(["first", "second"]);
    expect(rig.admission.calls.map((call) => call.localOrder)).toEqual([1, 2]);
    expect(framesOfType(s.sink, "transcript.final").map((frame) => frame.localOrder)).toEqual([1, 2]);
  });

  it("releases staged finals when the blocking turn terminalizes empty", async () => {
    const s = await listeningSession(rig);
    await startThenStop(s, "vturn_1");
    await s.handle.receive(clientFrame(s.sessionId, s.epoch, {
      type: "capture.start", turnId: "vturn_2", mode: "hands_free",
    }));
    rig.adapter.emit({ type: "transcript.final", turnId: "vturn_2", finalityId: "vfinal_2", text: "second" });
    await flush(rig, s.sessionId);
    expect(rig.admission.calls).toHaveLength(0);
    // Turn 1 ends with an empty final — never executed, hole closes.
    rig.adapter.emit({ type: "transcript.final", turnId: "vturn_1", finalityId: "vfinal_1", text: "   " });
    await flush(rig, s.sessionId);
    expect(rig.admission.calls.map((call) => call.transcript)).toEqual(["second"]);
  });

  it("bounds an unresolved hole with the documented staging timeout", async () => {
    const s = await listeningSession(rig);
    await startThenStop(s, "vturn_1");
    await s.handle.receive(clientFrame(s.sessionId, s.epoch, {
      type: "capture.start", turnId: "vturn_2", mode: "hands_free",
    }));
    rig.adapter.emit({ type: "transcript.final", turnId: "vturn_2", finalityId: "vfinal_2", text: "second" });
    await flush(rig, s.sessionId);
    expect(rig.admission.calls).toHaveLength(0);
    // Turn 1 never produces a final; the hole bound releases the staged final.
    rig.clock.advance(60_000);
    await flush(rig, s.sessionId);
    expect(rig.admission.calls.map((call) => call.transcript)).toEqual(["second"]);
    expect(framesOfType(s.sink, "capture.completed")).toContainEqual(
      expect.objectContaining({ turnId: "vturn_1", outcome: "failed" }),
    );
    // Timeout terminalizes the missing turn. Its late provider final can never
    // execute after the later turn has already been admitted.
    rig.adapter.emit({ type: "transcript.final", turnId: "vturn_1", finalityId: "vfinal_late", text: "late first" });
    await flush(rig, s.sessionId);
    expect(rig.admission.calls.map((call) => call.transcript)).toEqual(["second"]);
  });
});

describe("interruption and action cancel truth", () => {
  let rig: VoiceTestRig;
  beforeEach(() => {
    resetFrameSeq();
    rig = makeRig();
  });

  it("requests canonical run cancellation with reason 'interruption' on barge-in", async () => {
    const { s, responseId } = await speaking(rig);
    // Capture barge-in: the client opens a new turn while the response is
    // still open and the adapter's VAD reports speech — that, not the
    // media-only `response.interrupt` frame, is the canonical interruption.
    await s.handle.receive(clientFrame(s.sessionId, s.epoch, {
      type: "capture.start", turnId: "vturn_barge", mode: "hands_free",
    }));
    rig.adapter.emit({ type: "vad", turnId: "vturn_barge", action: "speech_start" });
    await flush(rig, s.sessionId);
    expect(rig.runControl.cancelledRuns).toEqual([
      { chatId: CHAT_ID, runId: "run_1", principalId: PRINCIPAL.userId, reason: "interruption" },
    ]);
    expect(lastFrame(s.sink, "response.interrupted")).toMatchObject({ responseId });
  });

  it("still interrupts playback when the canonical cancel attempt fails", async () => {
    const { s, responseId } = await speaking(rig);
    rig.runControl.runError = new Error("run control down");
    await s.handle.receive(clientFrame(s.sessionId, s.epoch, {
      type: "capture.start", turnId: "vturn_barge", mode: "hands_free",
    }));
    rig.adapter.emit({ type: "vad", turnId: "vturn_barge", action: "speech_start" });
    await flush(rig, s.sessionId);
    expect(rig.runControl.cancelledRuns).toHaveLength(1);
    expect(lastFrame(s.sink, "response.interrupted")).toMatchObject({ responseId });
    expect(rig.delivery.terminals.at(-1)?.reason).toBe("interrupted");
  });

  it("surfaces an unavailable action cancellation instead of silently succeeding", async () => {
    const s = await listeningSession(rig);
    rig.runControl.actionResult = "unavailable";
    await s.handle.receive(clientFrame(s.sessionId, s.epoch, { type: "action.cancel", actionId: "action_1" }));
    await flush(rig, s.sessionId);
    expect(lastFrame(s.sink, "session.error")).toMatchObject({
      code: "unsupported_surface", retryable: false,
    });
  });
});

describe("bounded session tracking", () => {
  let rig: VoiceTestRig;
  beforeEach(() => {
    resetFrameSeq();
    rig = makeRig();
  });

  it("evicts completed admitted turns so a long session can keep capturing", async () => {
    const limited = makeRig({ engine: { maxTurns: 3 } });
    const s = await listeningSession(limited);
    for (const name of ["a", "b", "c"]) {
      await admitTurn(limited, s, `vturn_${name}`, name);
      const runId = limited.admission.results.at(-1)?.runId;
      limited.events.emit({ type: "run.terminal", runId: runId!, state: "succeeded" });
      await flush(limited, s.sessionId);
    }
    // Three admitted+completed turns filled the cap; completed tracking evicts.
    await s.handle.receive(clientFrame(s.sessionId, s.epoch, {
      type: "capture.start", turnId: "vturn_d", mode: "hands_free",
    }));
    limited.adapter.emit({ type: "transcript.final", turnId: "vturn_d", finalityId: "vfinal_d", text: "d" });
    await flush(limited, s.sessionId);
    expect(limited.admission.calls).toHaveLength(4);
    expect(framesOfType(s.sink, "session.error")
      .filter((frame) => frame.code === "session_limit_reached")).toHaveLength(0);
  });

  it("does not evict turns whose canonical run is still in flight", async () => {
    const limited = makeRig({ engine: { maxTurns: 2 } });
    const s = await listeningSession(limited);
    await admitTurn(limited, s, "vturn_a", "a");
    await admitTurn(limited, s, "vturn_b", "b");
    // Both admitted, runs still active — capture start hits the cap.
    await s.handle.receive(clientFrame(s.sessionId, s.epoch, {
      type: "capture.start", turnId: "vturn_c", mode: "hands_free",
    }));
    await flush(limited, s.sessionId);
    expect(lastFrame(s.sink, "session.error")).toMatchObject({ code: "session_limit_reached" });
  });

  it("evicts terminal run tracking while an in-flight run still correlates", async () => {
    const limited = makeRig({ engine: { maxRunIds: 2 } });
    const s = await listeningSession(limited);
    await admitTurn(limited, s, "vturn_a", "a");
    limited.events.emit({ type: "run.terminal", runId: "run_1", state: "succeeded" });
    await flush(limited, s.sessionId);
    await admitTurn(limited, s, "vturn_b", "b");
    limited.events.emit({ type: "run.terminal", runId: "run_2", state: "succeeded" });
    await flush(limited, s.sessionId);
    // Runs 1+2 terminalized and released; a third admission correlates again.
    await admitTurn(limited, s, "vturn_c", "c");
    limited.events.emit({ type: "assistant.text", runId: "run_3", text: "hi.", textStart: 0, textEnd: 3 });
    await flush(limited, s.sessionId);
    expect(limited.delivery.pendings.at(-1)?.runId).toBe("run_3");
  });
});
