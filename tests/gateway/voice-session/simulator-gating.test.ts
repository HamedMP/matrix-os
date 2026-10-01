/**
 * Simulator capture gating: a real provider can never emit turn-scoped media
 * events (vad/transcript) for a turn whose capture was never opened — there
 * was no audio to recognize. The simulator mirrors that contract: gated
 * events scheduled before `setCapture` arms their turn are held in a bounded
 * pending queue and flushed on arm; events for never-captured turns never
 * emit. Error/quota/device events are session-scoped and stay ungated.
 */
import { describe, expect, it } from "vitest";
import type {
  VoiceAdapterEvent,
  VoiceAdapterSessionContext,
} from "../../../packages/gateway/src/voice-session/adapter.js";
import { SimulatorVoiceMediaAdapter } from "../../../packages/gateway/src/voice-session/adapter.js";
import type {
  VoiceSimulatorAction,
  VoiceSimulatorScenario,
} from "../../../packages/gateway/src/voice-session/simulator-types.js";
import { FakeClock } from "./fakes.js";

function scenario(timeline: VoiceSimulatorAction[]): VoiceSimulatorScenario {
  return {
    scenarioId: "gating_test",
    version: 1,
    initialEpoch: 1,
    limits: { maxQueuedAudioMs: 10_000, maxDurationMs: 600_000 },
    timeline,
  };
}

function start(timeline: VoiceSimulatorAction[]) {
  const clock = new FakeClock();
  const events: VoiceAdapterEvent[] = [];
  const context: VoiceAdapterSessionContext = {
    sessionId: "vs_gate",
    chatId: "chat_gate",
    principalId: "user_gate",
    turnMode: "hands_free",
    memoryMode: "ordinary",
    emit: (event) => events.push(event),
  };
  const adapter = new SimulatorVoiceMediaAdapter({ scenario: scenario(timeline), clock });
  const session = adapter.start(context);
  return { clock, events, session };
}

const final = (atMs: number, turnId: string, text = "final"): VoiceSimulatorAction =>
  ({ atMs, type: "transcript.final", turnId, finalityId: `vfinal_${turnId}_${atMs}`, localOrder: 1, text });
const provisional = (atMs: number, turnId: string, revision: number): VoiceSimulatorAction =>
  ({ atMs, type: "transcript.provisional", turnId, revision, text: `draft ${revision}` });
const vad = (atMs: number, turnId: string): VoiceSimulatorAction =>
  ({ atMs, type: "vad", turnId, action: "speech_start" });

describe("SimulatorVoiceMediaAdapter capture gating", () => {
  it("holds turn-scoped events until setCapture arms the turn, then flushes in order", () => {
    const rig = start([vad(10, "vturn_1"), provisional(20, "vturn_1", 1), final(30, "vturn_1")]);
    rig.clock.advance(1_000);
    expect(rig.events).toEqual([]);
    rig.session.setCapture({ turnId: "vturn_1", mode: "hands_free" });
    expect(rig.events.map((event) => event.type)).toEqual([
      "vad",
      "transcript.provisional",
      "transcript.final",
    ]);
    expect(rig.events[2]).toMatchObject({ turnId: "vturn_1", text: "final" });
  });

  it("emits on schedule once the turn is armed — atMs is the earliest emit time", () => {
    const rig = start([final(50, "vturn_1")]);
    rig.session.setCapture({ turnId: "vturn_1", mode: "hands_free" });
    rig.clock.advance(49);
    expect(rig.events).toEqual([]);
    rig.clock.advance(1);
    expect(rig.events).toEqual([
      { type: "transcript.final", turnId: "vturn_1", finalityId: "vfinal_vturn_1_50", text: "final" },
    ]);
  });

  it("never emits events for a turn that was never captured", async () => {
    const rig = start([vad(10, "vturn_9"), final(20, "vturn_9")]);
    rig.clock.advance(1_000);
    expect(rig.events).toEqual([]);
    await rig.session.close();
    expect(rig.events).toEqual([]);
  });

  it("setCapture(null) disarms without clearing pending — a later arm still flushes", () => {
    const rig = start([final(10, "vturn_1")]);
    rig.clock.advance(100);
    rig.session.setCapture(null);
    expect(rig.events).toEqual([]);
    rig.session.setCapture({ turnId: "vturn_1", mode: "hands_free" });
    expect(rig.events).toHaveLength(1);
  });

  it("an armed turn keeps emitting after capture ends — finals legitimately land post-stop", () => {
    const rig = start([vad(10, "vturn_1"), final(50, "vturn_1")]);
    rig.session.setCapture({ turnId: "vturn_1", mode: "hands_free" });
    rig.clock.advance(10);
    expect(rig.events).toHaveLength(1);
    rig.session.setCapture(null);
    rig.clock.advance(40);
    expect(rig.events.map((event) => event.type)).toEqual(["vad", "transcript.final"]);
  });

  it("does not gate error, quota, or device events on capture state", () => {
    const rig = start([
      { atMs: 10, type: "quota", quota: "usage" },
      { atMs: 20, type: "device", action: "input_lost" },
    ]);
    rig.clock.advance(1_000);
    expect(rig.events).toEqual([
      { type: "error", code: "usage_limit_reached", retryable: true, fatal: false },
      { type: "error", code: "input_unavailable", retryable: true, fatal: false },
    ]);
  });

  it("bounds the pending queue at 32 events per turn and drops the rest", () => {
    const rig = start(Array.from({ length: 40 }, (_, i) => provisional(i, "vturn_1", i + 1)));
    rig.clock.advance(1_000);
    rig.session.setCapture({ turnId: "vturn_1", mode: "hands_free" });
    expect(rig.events).toHaveLength(32);
    expect(rig.events.at(-1)).toMatchObject({ revision: 32 });
  });

  it("bounds total pending events at 128 across turns", () => {
    const timeline: VoiceSimulatorAction[] = [];
    for (let turn = 1; turn <= 5; turn += 1) {
      for (let i = 0; i < 30; i += 1) {
        timeline.push(provisional(turn * 100 + i, `vturn_${turn}`, i + 1));
      }
    }
    const rig = start(timeline);
    rig.clock.advance(10_000);
    for (let turn = 1; turn <= 5; turn += 1) {
      rig.session.setCapture({ turnId: `vturn_${turn}`, mode: "hands_free" });
    }
    expect(rig.events).toHaveLength(128);
    const turnFive = rig.events.filter((event) =>
      event.type === "transcript.provisional" && event.turnId === "vturn_5"
    );
    expect(turnFive).toHaveLength(8);
  });

  it("drops every pending event on close even if the turn arms afterwards", async () => {
    const rig = start([final(10, "vturn_1")]);
    rig.clock.advance(100);
    await rig.session.close();
    rig.session.setCapture({ turnId: "vturn_1", mode: "hands_free" });
    expect(rig.events).toEqual([]);
  });
});
