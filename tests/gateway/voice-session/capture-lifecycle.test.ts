import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VoiceSessionController } from "../../../packages/ui/src/voice-session/controller.js";
import { clientFrame, flush, listeningSession, makeRig, makeSink, PRINCIPAL, resetFrameSeq, type VoiceTestRig } from "./fakes.js";

let rig: VoiceTestRig;
beforeEach(() => { resetFrameSeq(); rig = makeRig(); });
afterEach(async () => { await rig.engine.close(); });

it.each(["thinking", "using_tool"])("keeps user pause through %s progress, output and terminal events", async state => {
  const s = await listeningSession(rig);
  await s.handle.receive(clientFrame(s.sessionId, s.epoch, { type: "capture.start", turnId: "vturn_pause", mode: "hands_free" }));
  rig.adapter.emit({ type: "transcript.final", turnId: "vturn_pause", finalityId: "vfinal_pause", text: "List apps" });
  await flush(rig, s.sessionId);
  if (state === "using_tool") {
    rig.events.emit({ type: "operation.status", runId: "run_1", label: "Listing", state: "running" });
    await flush(rig, s.sessionId);
  }
  const client = new VoiceSessionController({ sessionId: s.sessionId, initialEpoch: s.epoch });
  for (const frame of s.sink.frames) client.receive(frame);
  client.pause();
  const boundary = s.sink.frames.length;
  await s.handle.receive(clientFrame(s.sessionId, s.epoch, { type: "session.pause" }));
  rig.events.emit({ type: "operation.status", runId: "run_1", label: "Listing", state: "running" });
  rig.events.emit({ type: "assistant.text", runId: "run_1", text: "Listed apps.", textStart: 0, textEnd: 12 });
  rig.events.emit({ type: "run.terminal", runId: "run_1", state: "succeeded" });
  await flush(rig, s.sessionId);
  const emitted = s.sink.frames.slice(boundary);
  expect(emitted.filter(frame => frame.type === "session.state").map(frame => frame.state)).toEqual(["paused"]);
  for (const frame of emitted) client.receive(frame);
  expect(client.getState()).toMatchObject({ state: "paused", muted: true });
  await s.handle.receive(clientFrame(s.sessionId, s.epoch, { type: "capture.start", turnId: "vturn_blocked", mode: "hands_free" }));
  expect(rig.adapter.sessions[0].captures).not.toContainEqual(expect.objectContaining({ turnId: "vturn_blocked" }));
  client.resume();
  await s.handle.receive(clientFrame(s.sessionId, s.epoch, { type: "session.resume" }));
  client.receive(s.sink.frames.at(-1));
  expect(client.getState()).toMatchObject({ state: "listening", muted: false });
});

it.each([false, true])("preserves paused reconnect and admits the replacement epoch (progress=%s)", async progress => {
  const s = await listeningSession(rig);
  await s.handle.receive(clientFrame(s.sessionId, s.epoch, { type: "capture.start", turnId: "vturn_reconnect", mode: "hands_free" }));
  rig.adapter.emit({ type: "transcript.final", turnId: "vturn_reconnect", finalityId: "vfinal_reconnect", text: "List apps" });
  await flush(rig, s.sessionId);
  const client = new VoiceSessionController({ sessionId: s.sessionId, initialEpoch: s.epoch });
  for (const frame of s.sink.frames) client.receive(frame);
  client.pause();
  await s.handle.receive(clientFrame(s.sessionId, s.epoch, { type: "session.pause" }));
  s.handle.transportClosed();
  const reconnect = rig.engine.reconnectSession({ principal: PRINCIPAL, chatId: s.chatId, sessionId: s.sessionId });
  if (progress) {
    rig.events.emit({ type: "operation.status", runId: "run_1", label: "Listing", state: "running" });
    await flush(rig, s.sessionId);
  }
  const consumed = rig.tickets.consume(reconnect.lease.ticket, { path: reconnect.lease.path, sessionId: s.sessionId, chatId: s.chatId });
  const sink = makeSink();
  const handle = rig.engine.attachTransport({ sessionId: s.sessionId, chatId: s.chatId,
    principalId: PRINCIPAL.userId, generation: consumed.binding.generation }, sink);
  expect(sink.frames[0]).toMatchObject({ type: "session.resumed", epoch: 2, state: "paused" });
  expect(client.receive(sink.frames[0])).toBe(true);
  expect(client.getState()).toMatchObject({ state: "paused", muted: true, epoch: 2 });
  client.resume();
  await handle.receive(clientFrame(s.sessionId, 2, { type: "session.resume" }));
  expect(client.receive(sink.frames.at(-1))).toBe(true);
  expect(client.getState()).toMatchObject({ state: "listening", muted: false });
});

it("restores listening when an unpaused run finishes before replacement attach", async () => {
  const s = await listeningSession(rig);
  await s.handle.receive(clientFrame(s.sessionId, s.epoch, { type: "capture.start", turnId: "vturn_terminal", mode: "hands_free" }));
  rig.adapter.emit({ type: "transcript.final", turnId: "vturn_terminal", finalityId: "vfinal_terminal", text: "List apps" });
  await flush(rig, s.sessionId);
  s.handle.transportClosed();
  const reconnect = rig.engine.reconnectSession({ principal: PRINCIPAL, chatId: s.chatId, sessionId: s.sessionId });
  rig.events.emit({ type: "run.terminal", runId: "run_1", state: "succeeded" });
  await flush(rig, s.sessionId);
  const consumed = rig.tickets.consume(reconnect.lease.ticket, { path: reconnect.lease.path, sessionId: s.sessionId, chatId: s.chatId });
  const sink = makeSink();
  rig.engine.attachTransport({ sessionId: s.sessionId, chatId: s.chatId,
    principalId: PRINCIPAL.userId, generation: consumed.binding.generation }, sink);
  expect(sink.frames[0]).toMatchObject({ type: "session.resumed", epoch: 2, state: "listening" });
});

it.each(["AAAA", "AQAB"])("does not count drained capture %s as backlog", async data => {
  const s = await listeningSession(rig);
  await s.handle.receive(clientFrame(s.sessionId, s.epoch, { type: "capture.start", turnId: "vturn_long", mode: "hands_free" }));
  for (let index = 0; index < 600; index++) await s.handle.receive(clientFrame(s.sessionId, s.epoch, {
    type: "capture.audio", turnId: "vturn_long", timestampMs: index * 20, data,
  }));
  expect(rig.adapter.sessions[0].audios).toHaveLength(600);
  expect(s.sink.frames.filter(frame => frame.type === "session.error")).toEqual([]);
  rig.adapter.emit({ type: "transcript.final", turnId: "vturn_long", finalityId: "vfinal_long", text: "Speech after capture" });
  await flush(rig, s.sessionId);
  expect(rig.admission.calls[0].transcript).toBe("Speech after capture");
});

it("bounds undrained audio while an asynchronous dispatch is stalled", async () => {
  rig = makeRig({ limits: { maxQueuedAudioMs: 40 } });
  const s = await listeningSession(rig);
  await s.handle.receive(clientFrame(s.sessionId, s.epoch, { type: "capture.start", turnId: "vturn_stall", mode: "hands_free" }));
  let release!: () => void;
  vi.spyOn(rig.admission, "admitFinalTranscript").mockImplementation(() => new Promise(resolve => {
    release = () => resolve({ outcome: "sent", runId: "run_1", canonicalTurnId: "cturn_1", revision: 1 });
  }));
  rig.adapter.emit({ type: "transcript.final", turnId: "vturn_stall", finalityId: "vfinal_stall", text: "Work" });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const frames = [0, 1, 2].map(index => s.handle.receive(clientFrame(s.sessionId, s.epoch, {
    type: "capture.audio", turnId: "vturn_stall", timestampMs: index * 20, data: "AAAA",
  })));
  try {
    expect(s.sink.frames).toContainEqual(expect.objectContaining({ type: "session.error", code: "audio_backpressure" }));
  } finally {
    release();
    await Promise.all(frames); await flush(rig, s.sessionId);
  }
});
