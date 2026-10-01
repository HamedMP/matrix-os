/**
 * Deterministic media seam for the standalone Aoede fixture.
 *
 * Implements `VoiceSessionClient` (the exact interface `createAoedeController`
 * consumes through `controllerDeps.voiceFactory`) around the real
 * `VoiceSessionController`, so every panel state is produced by the genuine
 * server-frame state machine — no snapshot fabrication. `startVoice` plays a
 * bounded, per-scenario list of contract-valid `VoiceServerFrame`s; user
 * commands (pause/resume/ptt/stop speaking/end) still flow through the real
 * controller and are recorded into evidence.
 */
import type { VoiceServerFrame } from "@matrix-os/contracts/voice-session";
import { VoiceServerFrameSchema } from "@matrix-os/contracts/voice-session";
import { VoiceSessionController, type VoiceSessionCommand } from "../../../../../packages/ui/src/voice-session/controller";
import type {
  VoiceSessionClient,
  VoiceSessionClientOptions,
  VoiceSessionClientSnapshot,
  VoiceSessionClientPhase,
  VoiceSessionDevice,
} from "../../../../../packages/ui/src/voice-session/client-types";
import { FIXTURE_SESSION_ID, FIXTURE_CHAT_ID } from "./payloads";
import type { FixtureEvidence } from "./fixture-backend";

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
/** Server frame without transport identity — sequence/epoch/sessionId are stamped at play time. */
export type VoiceStep = DistributiveOmit<VoiceServerFrame, "contractVersion" | "sessionId" | "epoch" | "sequence">;

export interface FixtureVoicePlan {
  /** Frames played when `startVoice` succeeds, in order. */
  frames: VoiceStep[];
  /** When true, startVoice resolves after frames; the last frame decides the settled state. */
}

const FIXTURE_DEVICES: VoiceSessionDevice[] = [
  { deviceId: "mic_fixture", kind: "audioinput", label: "Fixture microphone" },
  { deviceId: "spk_fixture", kind: "audiooutput", label: "Fixture speaker" },
];

export function createFixtureVoiceFactory(plan: FixtureVoicePlan, evidence: FixtureEvidence) {
  return (options: VoiceSessionClientOptions): VoiceSessionClient =>
    new FixtureVoiceClient(options, plan, evidence);
}

class FixtureVoiceClient implements VoiceSessionClient {
  private readonly inner: VoiceSessionController;
  private readonly listeners = new Set<() => void>();
  private phase: VoiceSessionClientPhase = "idle";
  private error: VoiceSessionClientSnapshot["error"] = null;
  private chatId: string | null = null;
  private epoch = 1;
  private sequence = 0;
  private disposed = false;

  constructor(options: VoiceSessionClientOptions, private readonly plan: FixtureVoicePlan, private readonly evidence: FixtureEvidence) {
    this.inner = new VoiceSessionController({
      initialEpoch: 1,
      sessionId: FIXTURE_SESSION_ID,
      initialTurnMode: options.request.turnMode,
      onCommand: (command: VoiceSessionCommand) => this.evidence.recordMedia(`command:${command.type}`),
    });
    this.inner.subscribe(() => this.emit());
    this.evidence.recordMedia(`create:turnMode=${options.request.turnMode}`);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): VoiceSessionClientSnapshot => ({
    phase: this.phase,
    error: this.error,
    notice: null,
    sessionId: this.phase === "idle" ? null : FIXTURE_SESSION_ID,
    chatId: this.chatId,
    reconnectStatus: null,
    voice: this.inner.getState(),
  });

  controller = () => this.inner;

  async startVoice(chatId: string): Promise<void> {
    if (this.disposed || !["idle", "ended", "failed"].includes(this.phase)) return;
    this.chatId = chatId;
    this.phase = "starting";
    this.evidence.recordMedia(`startVoice:${chatId}`);
    this.emit();
    // Let the caller's connecting state render before frames land.
    await Promise.resolve();
    for (const step of this.plan.frames) {
      this.sequence += 1;
      const frame = {
        contractVersion: 1,
        sessionId: FIXTURE_SESSION_ID,
        epoch: this.epoch,
        sequence: this.sequence,
        ...step,
      } satisfies Record<string, unknown>;
      const parsed = VoiceServerFrameSchema.safeParse(frame);
      if (!parsed.success) {
        this.evidence.recordSchemaIssue(`voice frame ${step.type}: ${parsed.error.issues.map(i => i.message).join("; ")}`);
        continue;
      }
      // The real client reports "active" once the session is live — the first
      // well-formed server frame is the fixture's equivalent signal.
      if (this.phase === "starting") this.phase = "active";
      this.inner.receive(parsed.data);
      // Mirror the real client's authoritative terminal transitions: a
      // server-sent end or fatal error retires the session phase so derived
      // signals like `microphoneActive` stay truthful.
      if (parsed.data.type === "session.state" && parsed.data.state === "ended") {
        this.phase = "ended";
      } else if (parsed.data.type === "session.error") {
        this.phase = "failed";
        this.error = { code: parsed.data.code, retryable: parsed.data.retryable, recovery: parsed.data.recovery };
      }
    }
    this.emit();
  }

  async reconnect(): Promise<void> {
    this.evidence.recordMedia("reconnect");
    this.epoch += 1;
    this.sequence = 0;
    this.phase = "active";
    this.inner.receive({
      contractVersion: 1,
      sessionId: FIXTURE_SESSION_ID,
      epoch: this.epoch,
      sequence: 1,
      type: "session.resumed",
      state: "listening",
      reason: "restored",
    });
    this.emit();
  }

  async listDevices(): Promise<VoiceSessionDevice[] | null> {
    this.evidence.recordMedia("listDevices");
    return [...FIXTURE_DEVICES];
  }

  async setInputDevice(deviceId: string | null): Promise<boolean> {
    this.evidence.recordMedia(`setInputDevice:${deviceId ?? "default"}`);
    return true;
  }

  async setOutputDevice(deviceId: string | null): Promise<"applied" | "unsupported" | "unavailable"> {
    this.evidence.recordMedia(`setOutputDevice:${deviceId ?? "default"}`);
    return "applied";
  }

  retry(): void {
    this.evidence.recordMedia("retry");
    this.inner.retry();
  }

  retryCleanup(): number {
    return 0;
  }

  continueInChat(): void {
    this.evidence.recordMedia("continueInChat");
  }

  async end(): Promise<void> {
    if (this.phase === "ended") return;
    this.evidence.recordMedia("end");
    this.inner.end();
    this.phase = "ended";
    this.emit();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.inner.dispose();
    this.listeners.clear();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // media listeners must never break the fixture loop
      }
    }
  }
}

/** Shared frame fragments used by the scenario registry. */
export const voiceFrames = {
  listening: (): VoiceStep => ({ type: "session.state", state: "listening" }),
  thinking: (): VoiceStep => ({ type: "session.state", state: "thinking" }),
  usingTool: (label: string, operationId = "action_running_inspect"): VoiceStep => ({
    type: "operation.status",
    runId: "run_aoede_1",
    label,
    state: "running",
    operationId,
  }),
  toolDone: (label: string, operationId = "action_running_inspect"): VoiceStep => ({
    type: "operation.status",
    runId: "run_aoede_1",
    label,
    state: "succeeded",
    operationId,
  }),
  speaking: (): VoiceStep => [
    { type: "response.started", responseId: "vresp_aoede_1", runId: "run_aoede_1" },
    {
      type: "response.audio",
      responseId: "vresp_aoede_1",
      segmentId: "vseg_aoede_1",
      startMs: 0,
      data: btoa("aoede-fixture-audio"),
    },
    { type: "session.state", state: "speaking" },
  ] as VoiceStep[],
  provisional: (text: string): VoiceStep => ({
    type: "transcript.provisional",
    turnId: "vturn_aoede_1",
    revision: 1,
    text,
  }),
  transcriptFinal: (text: string): VoiceStep => ({
    type: "transcript.final",
    turnId: "vturn_aoede_1",
    finalityId: "vfinal_aoede_1",
    canonicalTurnId: "cturn_aoede_1",
    localOrder: 1,
    text,
  }),
  ended: (): VoiceStep => ({ type: "session.state", state: "ended", reason: "user_requested" }),
  goingAway: (): VoiceStep => ({ type: "transport.going_away", retryAfterMs: 250, reconnectAllowed: true }),
  sessionError: (): VoiceStep => ({
    type: "session.error",
    code: "internal_failure",
    retryable: true,
    recovery: "start_new_session",
  }),
};

export { FIXTURE_CHAT_ID };
