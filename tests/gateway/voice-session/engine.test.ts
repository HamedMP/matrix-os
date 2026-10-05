import { beforeEach, describe, expect, it } from "vitest";
import type { VoiceClientFrame, VoiceServerFrame } from "@matrix-os/contracts/voice-session";
import { VoiceSessionEngine, VoiceSessionError } from "../../../packages/gateway/src/voice-session/engine.js";
import { VoiceMediaAdapterRegistry } from "../../../packages/gateway/src/voice-session/adapter.js";
import type { VoiceAdapterSessionContext, VoiceMediaSession } from "../../../packages/gateway/src/voice-session/adapter.js";
import {
  CHAT_ID,
  FakeAdapter,
  PRINCIPAL,
  clientFrame,
  createAttached,
  framesOfType,
  lastFrame,
  listeningSession,
  makeCreateRequest,
  makeRig,
  makeSink,
  flush,
  resetFrameSeq,
  type VoiceTestRig,
} from "./fakes.js";

function frame(
  sessionId: string,
  epoch: number,
  sequence: number,
  fields: { type: string } & Record<string, unknown>,
): VoiceClientFrame {
  return { contractVersion: 1, sessionId, epoch, sequence, ...fields } as VoiceClientFrame;
}

class DeferredStartAdapter extends FakeAdapter {
  private releaseStart: (() => void) | null = null;

  override async start(context: VoiceAdapterSessionContext): Promise<VoiceMediaSession> {
    await new Promise<void>((resolve) => { this.releaseStart = resolve; });
    return super.start(context);
  }

  release(): void {
    this.releaseStart?.();
  }
}

function makeDeferredRig(options: { maxPendingMutationTasks?: number; maxPendingMutationBytes?: number } = {}) {
  const adapter = new DeferredStartAdapter("deferred");
  const registry = new VoiceMediaAdapterRegistry();
  registry.register(adapter);
  return { rig: makeRig({ engine: { adapters: registry, ...options } }), adapter };
}

/** Run one full admission through the adapter event port. */
async function admitTurn(rig: VoiceTestRig, attached: Awaited<ReturnType<typeof listeningSession>>, text: string) {
  const { handle, sessionId, epoch } = attached;
  await handle.receive(clientFrame(sessionId, epoch, {
    type: "capture.start", turnId: `vturn_${text}`, mode: "hands_free",
  }));
  rig.adapter.emit({ type: "transcript.final", turnId: `vturn_${text}`, finalityId: `vfinal_${text}`, text });
  await flush(rig, sessionId);
}

describe("VoiceSessionEngine lifecycle", () => {
  let rig: VoiceTestRig;
  beforeEach(() => {
    resetFrameSeq();
    rig = makeRig();
  });
  it("requires a task selection for managed speech but allows native conversation without one", () => {
    const request = { ...makeCreateRequest(), selection: undefined };
    expect(() => rig.engine.createSession({ principal: PRINCIPAL, chatId: CHAT_ID, request })).toThrowError(expect.objectContaining({ code: "provider_unavailable" }));
    Object.assign(rig.adapter.capabilities, { conversationMode: "native_live" });
    expect(rig.engine.createSession({ principal: PRINCIPAL, chatId: CHAT_ID, request }).outcome).toBe("created");
    expect(rig.admission.calls).toHaveLength(0);
  });
  it("allows only one active native voice session per owner across Chats", () => {
    Object.assign(rig.adapter.capabilities, { conversationMode: "native_live" });
    rig.engine.createSession({ principal: PRINCIPAL, chatId: CHAT_ID, request: makeCreateRequest() });
    expect(() => rig.engine.createSession({ principal: PRINCIPAL, chatId: "chat_other", request: makeCreateRequest() })).toThrowError(VoiceSessionError);
  });

  it("creates a connecting session with a one-time lease", () => {
    const created = rig.engine.createSession({
      principal: PRINCIPAL,
      chatId: CHAT_ID,
      request: makeCreateRequest(),
    });
    expect(created.outcome).toBe("created");
    if (created.outcome === "existing_consumed") throw new Error("unexpected");
    expect(created.session.status).toBe("connecting");
    expect(created.lease.ticket).toMatch(/^vt_/);
    expect(created.lease.epoch).toBe(1);
    expect(created.session.limits.maxSessionSeconds).toBeGreaterThan(0);
  });

  it("transitions connecting -> listening on client.ready and starts the adapter", async () => {
    const attached = createAttached(rig);
    // Attach emits the current state immediately.
    expect(lastFrame(attached.sink, "session.state")).toMatchObject({ type: "session.state", state: "connecting" });
    await attached.handle.receive(clientFrame(attached.sessionId, attached.epoch, {
      type: "client.ready",
      audio: { codec: "pcm_s16le", sampleRateHz: 16_000, channels: 1, frameDurationMs: 20 },
      capabilities: { formats: [{ codec: "pcm_s16le", sampleRateHz: 16_000, channels: 1, frameDurationMs: 20 }], binaryAudio: false, maxAudioFrameBytes: 65_536, deviceChangeEvents: false },
    }));
    expect(rig.adapter.sessions).toHaveLength(1);
    expect(rig.adapter.startCalls[0]?.principalId).toBe("user_1");
    expect(lastFrame(attached.sink, "session.state")).toMatchObject({ type: "session.state", state: "listening" });
  });

  it("rejects attach with a stale epoch generation", () => {
    const attached = createAttached(rig);
    expect(() => rig.engine.attachTransport({
      sessionId: attached.sessionId,
      chatId: CHAT_ID,
      principalId: "user_1",
      generation: attached.epoch + 5,
    }, makeSink())).toThrowError(VoiceSessionError);
  });

  it("rejects attach with a foreign principal", () => {
    const attached = createAttached(rig);
    expect(() => rig.engine.attachTransport({
      sessionId: attached.sessionId,
      chatId: CHAT_ID,
      principalId: "user_other",
      generation: attached.epoch,
    }, makeSink())).toThrowError(VoiceSessionError);
  });

  it("ends idempotently via endSession", async () => {
    const attached = await listeningSession(rig);
    const first = await rig.engine.endSession({ principal: PRINCIPAL, chatId: CHAT_ID, sessionId: attached.sessionId, kind: "user" });
    const second = await rig.engine.endSession({ principal: PRINCIPAL, chatId: CHAT_ID, sessionId: attached.sessionId, kind: "user" });
    expect(first.alreadyTerminal).toBe(false);
    expect(first.session.status).toBe("ended");
    expect(second.alreadyTerminal).toBe(true);
    expect(framesOfType(attached.sink, "session.state").at(-1)?.state).toBe("ended");
    expect(lastFrame(attached.sink, "transport.going_away")).toBeTruthy();
    expect(attached.sink.closes.length).toBeGreaterThan(0);
  });

  it("enforces one active session per chat", () => {
    rig.engine.createSession({ principal: PRINCIPAL, chatId: CHAT_ID, request: makeCreateRequest() });
    expect(() => rig.engine.createSession({
      principal: PRINCIPAL,
      chatId: CHAT_ID,
      request: makeCreateRequest({ clientRequestId: "other-req" }),
    })).toThrowError(VoiceSessionError);
  });

  it("caps the registry and evicts terminal sessions first", async () => {
    const capped = makeRig({ maxSessions: 1 });
    const first = capped.engine.createSession({ principal: PRINCIPAL, chatId: CHAT_ID, request: makeCreateRequest() });
    if (first.outcome === "existing_consumed") throw new Error("unexpected");
    expect(() => capped.engine.createSession({
      principal: PRINCIPAL,
      chatId: "chat_two",
      request: makeCreateRequest({ clientRequestId: "r2" }),
    })).toThrowError(VoiceSessionError);
    // Terminal eviction frees capacity for the next create.
    await capped.engine.endSession({ principal: PRINCIPAL, chatId: CHAT_ID, sessionId: first.session.sessionId, kind: "user" });
    const third = capped.engine.createSession({
      principal: PRINCIPAL,
      chatId: "chat_two",
      request: makeCreateRequest({ clientRequestId: "r2" }),
    });
    expect(third.outcome).toBe("created");
  });
});

describe("lost create response", () => {
  let rig: VoiceTestRig;
  beforeEach(() => {
    resetFrameSeq();
    rig = makeRig();
  });

  it("rotates the unconsumed credential on identical retry", () => {
    const input = { principal: PRINCIPAL, chatId: CHAT_ID, request: makeCreateRequest() };
    const first = rig.engine.createSession(input);
    const second = rig.engine.createSession(input);
    expect(second.outcome).toBe("rotated_unconsumed");
    if (first.outcome === "existing_consumed" || second.outcome === "existing_consumed") throw new Error("unexpected");
    expect(second.lease.ticket).not.toBe(first.lease.ticket);
    expect(second.lease.epoch).toBe(2);
    // The first ticket is superseded inside the ticket store.
    expect(() => rig.tickets.consume(first.lease.ticket, {
      path: first.lease.path, sessionId: first.session.sessionId, chatId: CHAT_ID,
    })).toThrowError();
  });

  it("returns status-only (no credentials) once the lease is consumed", () => {
    const input = { principal: PRINCIPAL, chatId: CHAT_ID, request: makeCreateRequest() };
    const first = rig.engine.createSession(input);
    if (first.outcome === "existing_consumed") throw new Error("unexpected");
    rig.tickets.consume(first.lease.ticket, {
      path: first.lease.path, sessionId: first.session.sessionId, chatId: CHAT_ID,
    });
    const retry = rig.engine.createSession(input);
    expect(retry.outcome).toBe("existing_consumed");
    expect("lease" in retry).toBe(false);
  });

  it("rejects same clientRequestId with diverging semantics", () => {
    rig.engine.createSession({ principal: PRINCIPAL, chatId: CHAT_ID, request: makeCreateRequest() });
    expect(() => rig.engine.createSession({
      principal: PRINCIPAL,
      chatId: CHAT_ID,
      request: makeCreateRequest({ turnMode: "push_to_talk" }),
    })).toThrowError(VoiceSessionError);
  });
});

describe("frames, turns, and admission", () => {
  let rig: VoiceTestRig;
  beforeEach(() => {
    resetFrameSeq();
    rig = makeRig();
  });

  it("relays provisional transcripts and admits finals exactly once", async () => {
    const s = await listeningSession(rig);
    await s.handle.receive(clientFrame(s.sessionId, s.epoch, { type: "capture.start", turnId: "vturn_1", mode: "hands_free" }));
    expect(rig.adapter.sessions[0]?.captures.at(-1)).toEqual({ turnId: "vturn_1", mode: "hands_free" });
    await s.handle.receive(clientFrame(s.sessionId, s.epoch, { type: "capture.audio", turnId: "vturn_1", timestampMs: 1, data: "AAAA" }));
    expect(rig.adapter.sessions[0]?.audios).toHaveLength(1);
    rig.adapter.emit({ type: "transcript.provisional", turnId: "vturn_1", revision: 1, text: "hel" });
    rig.adapter.emit({ type: "transcript.final", turnId: "vturn_1", finalityId: "vfinal_1", text: "hello there" });
    await flush(rig, s.sessionId);
    expect(rig.admission.calls).toHaveLength(1);
    expect(rig.admission.calls[0]?.clientRequestId).toMatch(/^req_/);
    expect(rig.admission.calls[0]?.localOrder).toBe(1);
    expect(rig.admission.calls[0]?.finalityId).toBe("vfinal_1");
    expect(lastFrame(s.sink, "transcript.provisional")).toMatchObject({ text: "hel", revision: 1 });
    expect(lastFrame(s.sink, "transcript.final")).toMatchObject({ canonicalTurnId: "cturn_1", localOrder: 1 });
    expect(lastFrame(s.sink, "session.state")).toMatchObject({ state: "thinking" });
  });

  it("dedupes a re-emitted provider final by finalityId", async () => {
    const s = await listeningSession(rig);
    await admitTurn(rig, s, "dup");
    rig.adapter.emit({ type: "transcript.final", turnId: "vturn_dup", finalityId: "vfinal_dup", text: "dup" });
    await flush(rig, s.sessionId);
    expect(rig.admission.calls).toHaveLength(1);
    expect(framesOfType(s.sink, "transcript.final")).toHaveLength(1);
  });

  it("keeps turn request ids stable and local order monotonic", async () => {
    const s = await listeningSession(rig);
    await admitTurn(rig, s, "first");
    // Let the run terminate so capture opens again for the next turn.
    rig.events.emit({ type: "run.terminal", runId: "run_1", state: "succeeded" });
    await flush(rig, s.sessionId);
    await admitTurn(rig, s, "second");
    expect(rig.admission.calls).toHaveLength(2);
    const [a, b] = rig.admission.calls;
    expect(a?.clientRequestId).toMatch(/^req_/);
    expect(b?.clientRequestId).toMatch(/^req_/);
    expect(a?.clientRequestId).not.toBe(b?.clientRequestId);
    expect(a?.localOrder).toBe(1);
    expect(b?.localOrder).toBe(2);
  });

  it("links queued admissions to their later canonical run", async () => {
    rig.admission.push({ outcome: "queued", canonicalQueuedTurnId: "qturn_q", revision: 2 });
    const s = await listeningSession(rig);
    await s.handle.receive(clientFrame(s.sessionId, s.epoch, { type: "capture.start", turnId: "vturn_1", mode: "hands_free" }));
    rig.adapter.emit({ type: "transcript.final", turnId: "vturn_1", finalityId: "vfinal_1", text: "queued turn" });
    await flush(rig, s.sessionId);
    expect(lastFrame(s.sink, "transcript.final")).toMatchObject({ canonicalQueuedTurnId: "qturn_q" });
    // queue.claimed projects both identities: the promoted `cturn_` and the
    // `qturn_` the voice turn recorded at admission.
    rig.events.emit({ type: "run.started", runId: "run_q", canonicalTurnId: "cturn_q", canonicalQueuedTurnId: "qturn_q" });
    await flush(rig, s.sessionId);
    rig.events.emit({ type: "assistant.text", runId: "run_q", text: "hi.", textStart: 0, textEnd: 3 });
    await flush(rig, s.sessionId);
    expect(rig.delivery.pendings).toHaveLength(1);
    expect(rig.delivery.pendings[0]?.runId).toBe("run_q");
  });

  it("emits chat_unavailable when canonical admission fails", async () => {
    rig.admission.failWith = new Error("canonical down");
    const s = await listeningSession(rig);
    await s.handle.receive(clientFrame(s.sessionId, s.epoch, { type: "capture.start", turnId: "vturn_1", mode: "hands_free" }));
    rig.adapter.emit({ type: "transcript.final", turnId: "vturn_1", finalityId: "vfinal_1", text: "hi" });
    await flush(rig, s.sessionId);
    expect(lastFrame(s.sink, "session.error")).toMatchObject({ code: "chat_unavailable" });
  });

  it("ends media when canonical admission proves backing Chat deletion/access loss", async () => {
    const rig = makeRig();
    const s = await listeningSession(rig);
    rig.admission.push({ outcome: "rejected", revision: 0,
      error: { code: "chat_unavailable", retryable: false, recovery: "start_new_session" } });
    await admitTurn(rig, s, "deleted");
    await flush(rig, s.sessionId);
    expect(rig.engine.describeSession({ principal: PRINCIPAL, chatId: CHAT_ID, sessionId: s.sessionId })?.status).toBe("ended");
    expect(rig.adapter.sessions[0]?.closed).toBe(true);
    expect(rig.runControl.cancelledRuns).toEqual([]);
  });

  it("treats admitted outcomes without canonical identity as internal_failure", async () => {
    rig.admission.push({ outcome: "sent", runId: "run_x", revision: 1 });
    const s = await listeningSession(rig);
    await s.handle.receive(clientFrame(s.sessionId, s.epoch, { type: "capture.start", turnId: "vturn_1", mode: "hands_free" }));
    rig.adapter.emit({ type: "transcript.final", turnId: "vturn_1", finalityId: "vfinal_1", text: "hi" });
    await flush(rig, s.sessionId);
    expect(lastFrame(s.sink, "session.error")).toMatchObject({ code: "internal_failure" });
  });

  it("fences stale epochs, wrong session ids, and non-monotonic sequences", async () => {
    const s = await listeningSession(rig);
    await s.handle.receive(frame(s.sessionId, s.epoch + 7, 1, { type: "heartbeat", timestampMs: 1 }));
    await s.handle.receive(frame("vs_other", s.epoch, 2, { type: "heartbeat", timestampMs: 2 }));
    await s.handle.receive(frame(s.sessionId, s.epoch, 10, { type: "heartbeat", timestampMs: 3 }));
    await s.handle.receive(frame(s.sessionId, s.epoch, 4, { type: "heartbeat", timestampMs: 4 }));
    expect(framesOfType(s.sink, "heartbeat.ack")).toHaveLength(1);
    // Frames arrived but only the monotonic one dispatched.
    const ignored = rig.logs.filter((entry) => entry.event === "voice.session.frame_ignored").map((entry) => entry.fields.kind);
    expect(ignored).toEqual(expect.arrayContaining(["stale_epoch", "wrong_session", "non_monotonic_sequence"]));
  });
});

describe("synthesis, delivery, and interruption", () => {
  let rig: VoiceTestRig;
  beforeEach(() => {
    resetFrameSeq();
    rig = makeRig();
  });

  async function speaking(rig: VoiceTestRig) {
    const s = await listeningSession(rig);
    await admitTurn(rig, s, "speak");
    const runId = rig.admission.results[0]?.runId ?? "run_1";
    rig.events.emit({ type: "assistant.text", runId, text: "spoken text.", textStart: 0, textEnd: 12 });
    await flush(rig, s.sessionId);
    return s;
  }

  it("records pending delivery before first audio and synthesizes canonical text", async () => {
    const s = await speaking(rig);
    expect(rig.delivery.pendings).toHaveLength(1);
    expect(rig.delivery.pendings[0]?.runId).toBe("run_1");
    const started = lastFrame(s.sink, "response.started") as Extract<VoiceServerFrame, { type: "response.started" }> | undefined;
    expect(started?.runId).toBe("run_1");
    expect(rig.adapter.sessions[0]?.synths).toHaveLength(1);
    expect(rig.adapter.sessions[0]?.synths[0]?.text).toBe("spoken text.");
  });

  it("relays synthesis audio and completes delivery on full playback", async () => {
    const s = await speaking(rig);
    const started = lastFrame(s.sink, "response.started") as Extract<VoiceServerFrame, { type: "response.started" }>;
    const segmentId = rig.adapter.sessions[0]!.synths[0]!.segmentId;
    rig.adapter.emit({ type: "synthesis.audio", responseId: started.responseId, segmentId, startMs: 0, durationMs: 100, data: "AAAA" });
    rig.adapter.emit({ type: "synthesis.end", responseId: started.responseId, segmentId, generatedDurationMs: 100 });
    rig.events.emit({ type: "run.terminal", runId: "run_1", state: "succeeded" });
    await flush(rig, s.sessionId);
    expect(lastFrame(s.sink, "response.audio")).toMatchObject({ segmentId, startMs: 0 });
    expect(lastFrame(s.sink, "response.audio_end")).toMatchObject({ generatedDurationMs: 100 });
    expect(lastFrame(s.sink, "session.state")).toMatchObject({ state: "speaking" });
    await s.handle.receive(clientFrame(s.sessionId, s.epoch, {
      type: "playback.segment_played", responseId: started.responseId, segmentId, deliveryRevision: 1, playedThroughMs: 100,
    }));
    await flush(rig, s.sessionId);
    expect(rig.delivery.acks).toHaveLength(1);
    expect(rig.delivery.terminals).toHaveLength(1);
    expect(rig.delivery.terminals[0]?.reason).toBe("complete");
    expect(lastFrame(s.sink, "session.state")).toMatchObject({ state: "listening" });
  });

  it("books interruption: adapter interrupt + terminal delivery + frame", async () => {
    const s = await speaking(rig);
    const started = lastFrame(s.sink, "response.started") as Extract<VoiceServerFrame, { type: "response.started" }>;
    const segmentId = rig.adapter.sessions[0]!.synths[0]!.segmentId;
    rig.adapter.emit({ type: "synthesis.audio", responseId: started.responseId, segmentId, startMs: 0, durationMs: 100, data: "AAAA" });
    await flush(rig, s.sessionId);
    await s.handle.receive(clientFrame(s.sessionId, s.epoch, {
      type: "response.interrupt", responseId: started.responseId, playedThroughMs: 40,
    }));
    await flush(rig, s.sessionId);
    expect(rig.adapter.sessions[0]?.interrupts).toEqual([{ responseId: started.responseId, playedThroughMs: 40 }]);
    expect(rig.runControl.cancelledRuns).toEqual([]);
    expect(rig.delivery.terminals[0]?.reason).toBe("interrupted");
    expect(rig.delivery.terminals[0]?.effectiveThroughMs).toBe(40);
    expect(lastFrame(s.sink, "response.interrupted")).toMatchObject({ effectiveThroughMs: 40 });
    expect(lastFrame(s.sink, "session.state")).toMatchObject({ state: "listening" });
    // Stop speaking must not make the distinct generation control unusable.
    await s.handle.receive(clientFrame(s.sessionId, s.epoch, {
      type: "generation.cancel", responseId: started.responseId,
    }));
    await flush(rig, s.sessionId);
    expect(rig.runControl.cancelledRuns).toEqual([{ chatId: CHAT_ID, runId: "run_1", principalId: "user_1", reason: "user" }]);
  });

  it("generation.cancel cancels adapter response and canonical run", async () => {
    const s = await speaking(rig);
    const started = lastFrame(s.sink, "response.started") as Extract<VoiceServerFrame, { type: "response.started" }>;
    await s.handle.receive(clientFrame(s.sessionId, s.epoch, {
      type: "generation.cancel", responseId: started.responseId,
    }));
    await flush(rig, s.sessionId);
    expect(rig.adapter.sessions[0]?.cancels).toEqual([started.responseId]);
    expect(rig.runControl.cancelledRuns).toEqual([{ chatId: CHAT_ID, runId: "run_1", principalId: "user_1", reason: "user" }]);
  });

  it("relays operation.status and restores listening on run.terminal", async () => {
    const s = await speaking(rig);
    rig.events.emit({ type: "operation.status", runId: "run_1", label: "Searching", state: "running" });
    await flush(rig, s.sessionId);
    expect(lastFrame(s.sink, "operation.status")).toMatchObject({ runId: "run_1", label: "Searching", state: "running" });
    rig.events.emit({ type: "run.terminal", runId: "run_1", state: "succeeded" });
    await flush(rig, s.sessionId);
    expect(lastFrame(s.sink, "session.state")).toMatchObject({ state: "listening" });
  });

  it("ignores canonical events for foreign runs", async () => {
    const s = await listeningSession(rig);
    rig.events.emit({ type: "assistant.text", runId: "run_foreign", text: "nope", textStart: 0, textEnd: 4 });
    await flush(rig, s.sessionId);
    expect(rig.delivery.pendings).toHaveLength(0);
  });
});

describe("reconnect and epochs", () => {
  let rig: VoiceTestRig;
  beforeEach(() => {
    resetFrameSeq();
    rig = makeRig();
  });

  it("rotates epoch, fences the old transport, and resumes on attach", async () => {
    const s = await listeningSession(rig);
    const result = rig.engine.reconnectSession({ principal: PRINCIPAL, chatId: CHAT_ID, sessionId: s.sessionId });
    expect(result.lease.epoch).toBe(2);
    expect(lastFrame(s.sink, "transport.going_away")).toMatchObject({ reconnectAllowed: true });
    expect(s.sink.closes.length).toBeGreaterThan(0);
    const consumed = rig.tickets.consume(result.lease.ticket, {
      path: result.lease.path, sessionId: s.sessionId, chatId: CHAT_ID,
    });
    const sink2 = makeSink();
    const handle2 = rig.engine.attachTransport({
      sessionId: s.sessionId, chatId: CHAT_ID, principalId: "user_1", generation: consumed.binding.generation,
    }, sink2);
    expect(lastFrame(sink2, "session.resumed")).toMatchObject({ state: "listening", reason: "restored" });
    // Old-epoch frames are fenced.
    await s.handle.receive(frame(s.sessionId, s.epoch, 99, { type: "heartbeat", timestampMs: 1 }));
    expect(framesOfType(s.sink, "heartbeat.ack")).toHaveLength(0);
    await handle2.receive(frame(s.sessionId, 2, 1, { type: "heartbeat", timestampMs: 2 }));
    expect(framesOfType(sink2, "heartbeat.ack")).toHaveLength(1);
  });

  it("latest committed generation wins under concurrent reconnects", async () => {
    const s = await listeningSession(rig);
    const first = rig.engine.reconnectSession({ principal: PRINCIPAL, chatId: CHAT_ID, sessionId: s.sessionId });
    const second = rig.engine.reconnectSession({ principal: PRINCIPAL, chatId: CHAT_ID, sessionId: s.sessionId });
    expect(second.lease.epoch).toBe(3);
    expect(() => rig.tickets.consume(first.lease.ticket, {
      path: first.lease.path, sessionId: s.sessionId, chatId: CHAT_ID,
    })).toThrowError();
    const consumed = rig.tickets.consume(second.lease.ticket, {
      path: second.lease.path, sessionId: s.sessionId, chatId: CHAT_ID,
    });
    expect(consumed.binding.generation).toBe(3);
  });

  it("enforces the reconnect attempt limit", async () => {
    const limited = makeRig({ limits: { maxReconnectAttempts: 1 } });
    const s = await listeningSession(limited);
    limited.engine.reconnectSession({ principal: PRINCIPAL, chatId: CHAT_ID, sessionId: s.sessionId });
    expect(() => limited.engine.reconnectSession({ principal: PRINCIPAL, chatId: CHAT_ID, sessionId: s.sessionId }))
      .toThrowError(VoiceSessionError);
  });

  it("moves to reconnecting when the transport drops", async () => {
    const s = await listeningSession(rig);
    s.handle.transportClosed();
    const summary = rig.engine.describeSession({ principal: PRINCIPAL, chatId: CHAT_ID, sessionId: s.sessionId });
    expect(summary?.status).toBe("reconnecting");
  });

  it("revives a failed session with a resumed frame on the rotated epoch", async () => {
    const limited = makeRig({ limits: { maxIdleSeconds: 1 } });
    const s = await listeningSession(limited);
    limited.clock.advance(1_000);
    await flush(limited, s.sessionId);
    expect(limited.engine.describeSession({ principal: PRINCIPAL, chatId: CHAT_ID, sessionId: s.sessionId })?.status)
      .toBe("failed");

    const reconnect = limited.engine.reconnectSession({
      principal: PRINCIPAL,
      chatId: CHAT_ID,
      sessionId: s.sessionId,
    });
    const consumed = limited.tickets.consume(reconnect.lease.ticket, {
      path: reconnect.lease.path,
      sessionId: s.sessionId,
      chatId: CHAT_ID,
    });
    const replacementSink = makeSink();
    limited.engine.attachTransport({
      sessionId: s.sessionId,
      chatId: CHAT_ID,
      principalId: PRINCIPAL.userId,
      generation: consumed.binding.generation,
    }, replacementSink);

    expect(lastFrame(replacementSink, "session.resumed")).toMatchObject({
      epoch: reconnect.lease.epoch,
      state: "listening",
      reason: "restored",
    });
    expect(lastFrame(replacementSink, "session.state")).toBeUndefined();
  });

  it("keeps a failed session retriable when the chat-event restore throws", async () => {
    const limited = makeRig({ limits: { maxIdleSeconds: 1 } });
    const s = await listeningSession(limited);
    limited.clock.advance(1_000);
    await flush(limited, s.sessionId);
    expect(limited.engine.describeSession({ principal: PRINCIPAL, chatId: CHAT_ID, sessionId: s.sessionId })?.status)
      .toBe("failed");

    // A throwing subscribe must not strand the session as "reconnecting" with
    // no subscription/timers — it stays "failed" so a later retry restores.
    limited.events.subscribeError = new Error("shared sink full");
    expect(() => limited.engine.reconnectSession({
      principal: PRINCIPAL, chatId: CHAT_ID, sessionId: s.sessionId,
    })).toThrowError(expect.objectContaining({ code: "internal_failure" }));
    expect(limited.engine.describeSession({ principal: PRINCIPAL, chatId: CHAT_ID, sessionId: s.sessionId })?.status)
      .toBe("failed");

    limited.events.subscribeError = null;
    const reconnect = limited.engine.reconnectSession({
      principal: PRINCIPAL, chatId: CHAT_ID, sessionId: s.sessionId,
    });
    const consumed = limited.tickets.consume(reconnect.lease.ticket, {
      path: reconnect.lease.path, sessionId: s.sessionId, chatId: CHAT_ID,
    });
    const replacementSink = makeSink();
    limited.engine.attachTransport({
      sessionId: s.sessionId, chatId: CHAT_ID, principalId: PRINCIPAL.userId,
      generation: consumed.binding.generation,
    }, replacementSink);
    expect(lastFrame(replacementSink, "session.resumed")).toMatchObject({
      epoch: reconnect.lease.epoch, state: "listening", reason: "restored",
    });
    // The restored session really is live: the canonical subscription and
    // timers came back, so it cannot silently outlive its limits.
    expect(limited.events.listenerCount).toBe(1);
    limited.clock.advance(1_000);
    await flush(limited, s.sessionId);
    expect(limited.engine.describeSession({ principal: PRINCIPAL, chatId: CHAT_ID, sessionId: s.sessionId })?.status)
      .toBe("failed");
  });

  it("revalidates a queued frame against the captured binding before dispatch", async () => {
    const { rig, adapter } = makeDeferredRig();
    const first = createAttached(rig);
    const ready = first.handle.receive(clientFrame(first.sessionId, first.epoch, {
      type: "client.ready",
      audio: { codec: "pcm_s16le", sampleRateHz: 16_000, channels: 1, frameDurationMs: 20 },
      capabilities: { formats: [{ codec: "pcm_s16le", sampleRateHz: 16_000, channels: 1, frameDurationMs: 20 }], binaryAudio: false, maxAudioFrameBytes: 65_536, deviceChangeEvents: false },
    }));
    await Promise.resolve();
    const queued = first.handle.receive(clientFrame(first.sessionId, first.epoch, {
      type: "heartbeat", timestampMs: 42,
    }));
    const reconnect = rig.engine.reconnectSession({ principal: PRINCIPAL, chatId: CHAT_ID, sessionId: first.sessionId });
    const consumed = rig.tickets.consume(reconnect.lease.ticket, {
      path: reconnect.lease.path, sessionId: first.sessionId, chatId: CHAT_ID,
    });
    const replacementSink = makeSink();
    rig.engine.attachTransport({
      sessionId: first.sessionId, chatId: CHAT_ID, principalId: PRINCIPAL.userId,
      generation: consumed.binding.generation,
    }, replacementSink);
    adapter.release();
    await Promise.all([ready, queued]);

    expect(framesOfType(replacementSink, "heartbeat.ack")).toHaveLength(0);
    expect(rig.logs).toContainEqual(expect.objectContaining({
      event: "voice.session.frame_ignored",
      fields: expect.objectContaining({ kind: "binding_changed_before_dispatch" }),
    }));
  });
});

describe("timeouts and shutdown", () => {
  beforeEach(() => resetFrameSeq());

  it("ends the session at the idle limit", async () => {
    const rig = makeRig({ limits: { maxIdleSeconds: 5 } });
    const s = await listeningSession(rig);
    rig.clock.advance(5_000);
    await flush(rig, s.sessionId);
    expect(lastFrame(s.sink, "session.error")).toMatchObject({ code: "session_limit_reached" });
    // Limit-expiry is a failed terminal state with reconnect allowed.
    expect(rig.engine.describeSession({ principal: PRINCIPAL, chatId: CHAT_ID, sessionId: s.sessionId })?.status).toBe("failed");
    expect(rig.adapter.sessions[0]?.closed).toBe(true);
  });

  it("heartbeat activity defers the idle limit", async () => {
    const rig = makeRig({ limits: { maxIdleSeconds: 10 } });
    const s = await listeningSession(rig);
    rig.clock.advance(9_000);
    await s.handle.receive(frame(s.sessionId, s.epoch, 50, { type: "heartbeat", timestampMs: 9_000 }));
    rig.clock.advance(9_000);
    expect(rig.engine.describeSession({ principal: PRINCIPAL, chatId: CHAT_ID, sessionId: s.sessionId })?.status).toBe("listening");
    rig.clock.advance(11_000);
    await flush(rig, s.sessionId);
    expect(rig.engine.describeSession({ principal: PRINCIPAL, chatId: CHAT_ID, sessionId: s.sessionId })?.status).toBe("failed");
  });

  it("ends the session at the maximum duration limit", async () => {
    const rig = makeRig({ limits: { maxSessionSeconds: 5, maxIdleSeconds: 3_600 } });
    const s = await listeningSession(rig);
    rig.clock.advance(5_000);
    await flush(rig, s.sessionId);
    expect(rig.engine.describeSession({ principal: PRINCIPAL, chatId: CHAT_ID, sessionId: s.sessionId })?.status).toBe("failed");
  });

  it("fails safely when the adapter cannot start", async () => {
    const rig = makeRig();
    rig.adapter.startError = new Error("provider blew up");
    const s = createAttached(rig);
    await s.handle.receive(clientFrame(s.sessionId, s.epoch, {
      type: "client.ready",
      audio: { codec: "pcm_s16le", sampleRateHz: 16_000, channels: 1, frameDurationMs: 20 },
      capabilities: { formats: [{ codec: "pcm_s16le", sampleRateHz: 16_000, channels: 1, frameDurationMs: 20 }], binaryAudio: false, maxAudioFrameBytes: 65_536, deviceChangeEvents: false },
    }));
    await flush(rig, s.sessionId);
    expect(lastFrame(s.sink, "session.error")).toMatchObject({ code: "provider_unavailable" });
    expect(rig.engine.describeSession({ principal: PRINCIPAL, chatId: CHAT_ID, sessionId: s.sessionId })?.status).toBe("failed");
  });

  it("drains every session on close and clears tickets", async () => {
    const rig = makeRig();
    const s = await listeningSession(rig);
    await rig.engine.close();
    expect(lastFrame(s.sink, "transport.going_away")).toBeTruthy();
    expect(rig.engine.describeSession({ principal: PRINCIPAL, chatId: CHAT_ID, sessionId: s.sessionId })?.status).toBe("ended");
    expect(rig.adapter.sessions[0]?.closed).toBe(true);
    expect(rig.events.listenerCount).toBe(0);
    expect(rig.tickets.size).toBe(0);
    expect(rig.engine.isClosed()).toBe(true);
    expect(() => rig.engine.createSession({ principal: PRINCIPAL, chatId: CHAT_ID, request: makeCreateRequest({ clientRequestId: "post-close" }) }))
      .toThrowError(VoiceSessionError);
  });

  it("serializes an external end behind an in-flight mutation", async () => {
    const { rig, adapter } = makeDeferredRig();
    const s = createAttached(rig);
    const ready = s.handle.receive(clientFrame(s.sessionId, s.epoch, {
      type: "client.ready",
      audio: { codec: "pcm_s16le", sampleRateHz: 16_000, channels: 1, frameDurationMs: 20 },
      capabilities: { formats: [{ codec: "pcm_s16le", sampleRateHz: 16_000, channels: 1, frameDurationMs: 20 }], binaryAudio: false, maxAudioFrameBytes: 65_536, deviceChangeEvents: false },
    }));
    await Promise.resolve();
    const ending = rig.engine.endSession({
      principal: PRINCIPAL, chatId: CHAT_ID, sessionId: s.sessionId, kind: "user",
    });
    await Promise.resolve();
    expect(s.sink.closes).toHaveLength(0);
    expect(rig.engine.describeSession({ principal: PRINCIPAL, chatId: CHAT_ID, sessionId: s.sessionId })?.status)
      .toBe("connecting");

    adapter.release();
    await Promise.all([ready, ending]);
    expect(rig.engine.describeSession({ principal: PRINCIPAL, chatId: CHAT_ID, sessionId: s.sessionId })?.status)
      .toBe("ended");
  });

  it("retains terminal cleanup ownership when teardown fails and permits an explicit retry", async () => {
    const rig = makeRig();
    const created = rig.engine.createSession({
      principal: PRINCIPAL,
      chatId: CHAT_ID,
      request: makeCreateRequest(),
    });
    if (created.outcome === "existing_consumed") throw new Error("unexpected");
    const sessionId = created.session.sessionId;
    const record = (rig.engine as unknown as { sessions: Map<string, { runtime: { end(kind: string): Promise<void> } }> })
      .sessions.get(sessionId)!;
    const originalEnd = record.runtime.end.bind(record.runtime);
    const end = vi.spyOn(record.runtime, "end")
      .mockRejectedValueOnce(new Error("teardown unavailable"))
      .mockImplementation(originalEnd);

    await expect(rig.engine.endSession({
      principal: PRINCIPAL, chatId: CHAT_ID, sessionId, kind: "user",
    })).rejects.toThrow("teardown unavailable");
    expect(rig.tickets.describeSession(sessionId)?.state).toBe("minted");

    await expect(rig.engine.endSession({
      principal: PRINCIPAL, chatId: CHAT_ID, sessionId, kind: "user",
    })).resolves.toMatchObject({ session: { status: "ended" } });
    expect(end).toHaveBeenCalledTimes(2);
    expect(rig.tickets.describeSession(sessionId)?.state).toBe("revoked");
  });

  it("terminates a session when the mutation task backlog overflows", async () => {
    const { rig, adapter } = makeDeferredRig({ maxPendingMutationTasks: 2 });
    const s = createAttached(rig);
    const ready = s.handle.receive(clientFrame(s.sessionId, s.epoch, {
      type: "client.ready",
      audio: { codec: "pcm_s16le", sampleRateHz: 16_000, channels: 1, frameDurationMs: 20 },
      capabilities: { formats: [{ codec: "pcm_s16le", sampleRateHz: 16_000, channels: 1, frameDurationMs: 20 }], binaryAudio: false, maxAudioFrameBytes: 65_536, deviceChangeEvents: false },
    }));
    await Promise.resolve();
    const queued = s.handle.receive(clientFrame(s.sessionId, s.epoch, { type: "heartbeat", timestampMs: 1 }));
    const overflow = s.handle.receive(clientFrame(s.sessionId, s.epoch, { type: "heartbeat", timestampMs: 2 }));
    expect(s.sink.closes.at(-1)?.reason).toBe("Session backlog exceeded");
    expect(rig.logs.filter((entry) => entry.event === "voice.session.mutation_overflow")).toHaveLength(1);

    adapter.release();
    await Promise.all([ready, queued, overflow]);
    expect(rig.engine.describeSession({ principal: PRINCIPAL, chatId: CHAT_ID, sessionId: s.sessionId })?.status)
      .toBe("failed");
  });
});

describe("capability gating", () => {
  beforeEach(() => resetFrameSeq());

  it("rejects session_only even when speech claims enforcement", () => {
    const rig = makeRig();
    expect(() => rig.engine.createSession({ principal: PRINCIPAL, chatId: CHAT_ID,
      request: makeCreateRequest({ memoryMode: "session_only" }) })).toThrowError(VoiceSessionError);
  });

  it("persists a server-owned immutable policy for typed lookup and spoken admission", async () => {
    const rig = makeRig();
    const executionPolicy = { revision: "policy_v1", actionMode: "safe_reads" as const,
      workspaceScope: "workspace", tools: ["workspace_read"], delegation: false };
    const created = rig.engine.createSession({ principal: PRINCIPAL, chatId: CHAT_ID,
      request: makeCreateRequest(), executionPolicy });
    executionPolicy.tools.push("unsafe_write");
    expect(rig.engine.sessionPolicyLookup.policyForChat(CHAT_ID)).toMatchObject({
      executionPolicy: { tools: ["workspace_read"], actionMode: "safe_reads" },
    });
    if (created.outcome === "existing_consumed") throw new Error("unexpected");
    const consumed = rig.tickets.consume(created.lease.ticket, {
      path: created.lease.path, sessionId: created.session.sessionId, chatId: CHAT_ID,
    });
    const handle = rig.engine.attachTransport({ sessionId: created.session.sessionId, chatId: CHAT_ID,
      principalId: PRINCIPAL.userId, generation: consumed.binding.generation }, makeSink());
    const s = { handle, sessionId: created.session.sessionId, epoch: created.lease.epoch };
    await handle.receive(clientFrame(s.sessionId, s.epoch, { type: "client.ready",
      audio: { codec: "pcm_s16le", sampleRateHz: 16_000, channels: 1, frameDurationMs: 20 },
      capabilities: { formats: [{ codec: "pcm_s16le", sampleRateHz: 16_000, channels: 1, frameDurationMs: 20 }], binaryAudio: false, maxAudioFrameBytes: 65_536, deviceChangeEvents: false },
    }));
    await handle.receive(clientFrame(s.sessionId, s.epoch, { type: "capture.start", turnId: "vturn_policy", mode: "hands_free" }));
    rig.adapter.emit({ type: "transcript.final", turnId: "vturn_policy", finalityId: "vfinal_policy", text: "Read workspace" });
    await flush(rig, s.sessionId);
    expect(rig.admission.calls[0]).toMatchObject({ executionPolicy: { tools: ["workspace_read"], revision: "policy_v1" } });
    await rig.engine.endSession({ principal: PRINCIPAL, chatId: CHAT_ID, sessionId: s.sessionId });
    expect(rig.runControl.cancelledRuns).toEqual([]);
  });

  it("rejects session_only when the adapter does not enforce it", () => {
    const rig = makeRig();
    const strict = new FakeAdapter("nostore", { sessionOnly: "unsupported" });
    const registry = new VoiceMediaAdapterRegistry();
    registry.register(strict);
    const engine = new VoiceSessionEngine({
      admission: rig.admission,
      delivery: rig.delivery,
      chatEvents: rig.events,
      adapters: registry,
      tickets: rig.tickets,
      clock: rig.clock,
    });
    expect(() => engine.createSession({
      principal: PRINCIPAL,
      chatId: CHAT_ID,
      request: makeCreateRequest({ memoryMode: "session_only" }),
    })).toThrowError(VoiceSessionError);
  });

  it("rejects unsupported turn modes", () => {
    const rig = makeRig();
    const pttOnly = new FakeAdapter("ptt", { turnModes: ["push_to_talk"] });
    const registry = new VoiceMediaAdapterRegistry();
    registry.register(pttOnly);
    const engine = new VoiceSessionEngine({
      admission: rig.admission,
      delivery: rig.delivery,
      chatEvents: rig.events,
      adapters: registry,
      tickets: rig.tickets,
      clock: rig.clock,
    });
    expect(() => engine.createSession({
      principal: PRINCIPAL,
      chatId: CHAT_ID,
      request: makeCreateRequest({ turnMode: "hands_free" }),
    })).toThrowError(VoiceSessionError);
  });
});
