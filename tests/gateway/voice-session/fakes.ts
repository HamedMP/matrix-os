/**
 * Shared fakes for voice-session engine/route tests: manual clock, admission,
 * delivery, canonical event source, run control, chat access, and a controllable
 * provider adapter. No DB, no real providers, no real time.
 */
import type {
  VoiceAdapterEvent,
  VoiceAdapterSessionContext,
  VoiceMediaAdapter,
  VoiceMediaSession,
} from "../../../packages/gateway/src/voice-session/adapter.js";
import { VoiceMediaAdapterRegistry } from "../../../packages/gateway/src/voice-session/adapter.js";
import {
  VoiceSessionEngine,
  VoiceSessionError,
  type VoiceSessionCreateInput,
  type VoiceSessionTransportHandle,
} from "../../../packages/gateway/src/voice-session/engine.js";
import type {
  VoiceCanonicalChatEvent,
  VoiceChatEventSubscription,
  VoiceClock,
  VoiceDeliveryPort,
  VoiceAdmissionPort,
  VoiceRunControlPort,
  VoiceChatAccessPort,
  VoiceTurnAdmissionRequest,
  VoiceTurnAdmissionResult,
  VoiceChatEventSource,
  VoiceTimer,
} from "../../../packages/gateway/src/voice-session/ports.js";
import { VoiceTicketAuthority } from "../../../packages/gateway/src/voice-session/ticket-auth.js";
import type {
  VoiceClientFrame,
  VoiceServerFrame,
  VoiceSessionLimits,
} from "@matrix-os/contracts/voice-session";
import type { RequestPrincipal } from "../../../packages/gateway/src/request-principal.js";

export const PRINCIPAL: RequestPrincipal = { userId: "user_1", source: "jwt" };
export const CHAT_ID = "chat_main";

export class FakeClock implements VoiceClock {
  private t = 0;
  private seq = 0;
  private timers: { id: number; at: number; fn: () => void; cancelled: boolean }[] = [];

  now(): number {
    return this.t;
  }

  after(delayMs: number, fn: () => void): VoiceTimer {
    const timer = { id: ++this.seq, at: this.t + delayMs, fn, cancelled: false };
    this.timers.push(timer);
    return { cancel: () => { timer.cancelled = true; } };
  }

  set(ms: number): void {
    this.t = ms;
    this.runDue();
  }

  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      const due = this.timers
        .filter((timer) => !timer.cancelled && timer.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.t = due.at;
      due.cancelled = true;
      due.fn();
    }
    this.t = target;
  }

  pendingTimers(): number {
    return this.timers.filter((timer) => !timer.cancelled).length;
  }
}

export class FakeAdmission implements VoiceAdmissionPort {
  readonly calls: VoiceTurnAdmissionRequest[] = [];
  private queue: VoiceTurnAdmissionResult[] = [];
  private counter = 0;
  /** When set, admission rejects (simulating canonical failure). */
  failWith: Error | null = null;

  push(result: VoiceTurnAdmissionResult): void {
    this.queue.push(result);
  }

  async admitFinalTranscript(request: VoiceTurnAdmissionRequest): Promise<VoiceTurnAdmissionResult> {
    this.calls.push(request);
    if (this.failWith) throw this.failWith;
    this.counter += 1;
    return this.queue.shift() ?? {
      outcome: "sent",
      canonicalTurnId: `cturn_${this.counter}`,
      runId: `run_${this.counter}`,
      revision: this.counter,
    };
  }
}

export class FakeDelivery implements VoiceDeliveryPort {
  readonly pendings: Parameters<VoiceDeliveryPort["recordPending"]>[0][] = [];
  readonly acks: Parameters<VoiceDeliveryPort["acknowledge"]>[0][] = [];
  readonly terminals: Parameters<VoiceDeliveryPort["recordTerminal"]>[0][] = [];
  ackResult: { revision: number } | "ignored" | Error = { revision: 0 };
  private revision = 0;

  async recordPending(input: Parameters<VoiceDeliveryPort["recordPending"]>[0]) {
    this.pendings.push(input);
    return { revision: ++this.revision };
  }

  async acknowledge(input: Parameters<VoiceDeliveryPort["acknowledge"]>[0]) {
    this.acks.push(input);
    if (this.ackResult instanceof Error) throw this.ackResult;
    if (this.ackResult === "ignored") return "ignored" as const;
    return { revision: ++this.revision };
  }

  async recordTerminal(input: Parameters<VoiceDeliveryPort["recordTerminal"]>[0]) {
    this.terminals.push(input);
    return { revision: ++this.revision };
  }
}

export class FakeChatEvents implements VoiceChatEventSource {
  private listeners = new Set<(event: VoiceCanonicalChatEvent) => void>();
  subscriptions = 0;

  subscribe(
    _input: { chatId: string; principalId: string },
    listener: (event: VoiceCanonicalChatEvent) => void,
  ): VoiceChatEventSubscription {
    this.subscriptions += 1;
    this.listeners.add(listener);
    return { close: () => { this.listeners.delete(listener); } };
  }

  emit(event: VoiceCanonicalChatEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

export class FakeRunControl implements VoiceRunControlPort {
  readonly cancelledRuns: { chatId: string; runId: string; principalId: string; reason: string }[] = [];
  readonly cancelledActions: { chatId: string; actionId: string; principalId: string }[] = [];

  async cancelRun(input: { chatId: string; runId: string; principalId: string; reason: "user" | "interruption" }) {
    this.cancelledRuns.push(input);
    return "cancelled" as const;
  }

  async cancelAction(input: { chatId: string; actionId: string; principalId: string }) {
    this.cancelledActions.push(input);
    return "cancelled" as const;
  }
}

export class FakeChatAccess implements VoiceChatAccessPort {
  readonly calls: { principalId: string; chatId: string; level: string }[] = [];
  denied = false;

  requireAccess(input: { principalId: string; chatId: string; level: "read" | "write" }): void {
    this.calls.push(input);
    if (this.denied || input.chatId !== CHAT_ID) {
      throw new VoiceSessionError("not_found", "Voice session not found", 404);
    }
  }
}

export interface FakeAdapterSession extends VoiceMediaSession {
  captures: ({ turnId: string; mode: string } | null)[];
  audios: { turnId: string; timestampMs: number; data: string }[];
  synths: { responseId: string; segmentId: string; text: string }[];
  cancels: string[];
  interrupts: { responseId: string; playedThroughMs: number }[];
  closed: boolean;
}

export class FakeAdapter implements VoiceMediaAdapter {
  readonly id: string;
  readonly capabilities: VoiceMediaAdapter["capabilities"];
  readonly sessions: FakeAdapterSession[] = [];
  startCalls: VoiceAdapterSessionContext[] = [];
  private emitFn: ((event: VoiceAdapterEvent) => void) | null = null;
  /** When set, start() fails (provider unavailable). */
  startError: Error | null = null;

  constructor(id = "fake", capabilities: Partial<VoiceMediaAdapter["capabilities"]> = {}) {
    this.id = id;
    this.capabilities = {
      transportModes: ["relayed_websocket"],
      turnModes: ["hands_free", "push_to_talk"],
      supportsInterruption: true,
      resume: "rebuild_only",
      sessionOnly: "enforced",
      actionMode: "conversation_only",
      actionCancellation: "run",
      supportsInputSelection: true,
      supportsOutputSelection: true,
      ...capabilities,
    };
  }

  start(context: VoiceAdapterSessionContext): VoiceMediaSession {
    this.startCalls.push(context);
    if (this.startError) throw this.startError;
    this.emitFn = context.emit;
    const session: FakeAdapterSession = {
      captures: [],
      audios: [],
      synths: [],
      cancels: [],
      interrupts: [],
      closed: false,
      setCapture(capture) {
        session.captures.push(capture);
      },
      pushAudio(audio) {
        session.audios.push(audio);
      },
      synthesize(command) {
        session.synths.push({
          responseId: command.responseId,
          segmentId: command.segment.segmentId,
          text: command.text,
        });
      },
      cancelResponse(responseId) {
        session.cancels.push(responseId);
      },
      interrupt(responseId, playedThroughMs) {
        session.interrupts.push({ responseId, playedThroughMs });
      },
      close() {
        session.closed = true;
      },
    };
    this.sessions.push(session);
    return session;
  }

  emit(event: VoiceAdapterEvent): void {
    this.emitFn?.(event);
  }
}

export interface VoiceTestRig {
  clock: FakeClock;
  admission: FakeAdmission;
  delivery: FakeDelivery;
  events: FakeChatEvents;
  runControl: FakeRunControl;
  adapter: FakeAdapter;
  registry: VoiceMediaAdapterRegistry;
  tickets: VoiceTicketAuthority;
  engine: VoiceSessionEngine;
  logs: { event: string; fields: Record<string, unknown> }[];
}

export function makeRig(options: {
  maxSessions?: number;
  limits?: Partial<VoiceSessionLimits>;
  engine?: Partial<ConstructorParameters<typeof VoiceSessionEngine>[0]>;
} = {}): VoiceTestRig {
  const clock = new FakeClock();
  const admission = new FakeAdmission();
  const delivery = new FakeDelivery();
  const events = new FakeChatEvents();
  const runControl = new FakeRunControl();
  const adapter = new FakeAdapter();
  const registry = new VoiceMediaAdapterRegistry();
  registry.register(adapter);
  const tickets = new VoiceTicketAuthority({ now: () => clock.now() });
  const logs: VoiceTestRig["logs"] = [];
  const engine = new VoiceSessionEngine({
    admission,
    delivery,
    chatEvents: events,
    runControl,
    adapters: registry,
    tickets,
    clock,
    log: (event, fields) => logs.push({ event, fields }),
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.maxSessions !== undefined ? { maxSessions: options.maxSessions } : {}),
    ...options.engine,
  });
  return { clock, admission, delivery, events, runControl, adapter, registry, tickets, engine, logs };
}

export function makeCreateRequest(overrides: Partial<VoiceSessionCreateInput> = {}): VoiceSessionCreateInput {
  return {
    clientRequestId: "req-client-1",
    turnMode: "hands_free",
    memoryMode: "ordinary",
    selection: { instanceId: "instance-1", model: "claude-sonnet-4" },
    interactionMode: "chat",
    permissionMode: "default",
    ...overrides,
  };
}

export interface FakeSink {
  frames: VoiceServerFrame[];
  closes: { code: number; reason: string }[];
  send(frame: VoiceServerFrame): void;
  close(code: number, reason: string): void;
}

export function makeSink(): FakeSink {
  const sink: FakeSink = {
    frames: [],
    closes: [],
    send(frame) {
      sink.frames.push(frame);
    },
    close(code, reason) {
      sink.closes.push({ code, reason });
    },
  };
  return sink;
}

/**
 * Full create → ticket consume → transport attach path. Returns the session
 * handle plus the sink collecting every server frame.
 */
export function createAttached(
  rig: VoiceTestRig,
  options: { chatId?: string; request?: Partial<VoiceSessionCreateInput>; principal?: RequestPrincipal } = {},
): {
  sessionId: string;
  chatId: string;
  sink: FakeSink;
  handle: VoiceSessionTransportHandle;
  epoch: number;
} {
  const principal = options.principal ?? PRINCIPAL;
  const chatId = options.chatId ?? CHAT_ID;
  const created = rig.engine.createSession({
    principal,
    chatId,
    request: makeCreateRequest(options.request),
  });
  if (created.outcome === "existing_consumed") throw new Error("unexpected consumed outcome");
  const consumed = rig.tickets.consume(created.lease.ticket, {
    path: created.lease.path,
    sessionId: created.session.sessionId,
    chatId,
  });
  const sink = makeSink();
  const handle = rig.engine.attachTransport(
    {
      sessionId: created.session.sessionId,
      chatId,
      principalId: principal.userId,
      generation: consumed.binding.generation,
    },
    sink,
  );
  return {
    sessionId: created.session.sessionId,
    chatId,
    sink,
    handle,
    epoch: consumed.binding.generation,
  };
}

let frameSeq = 0;

export function resetFrameSeq(): void {
  frameSeq = 0;
}

/** Build a contract-valid client frame for `sessionId`/`epoch`. */
export function clientFrame(
  sessionId: string,
  epoch: number,
  fields: { type: string } & Record<string, unknown>,
): VoiceClientFrame {
  return {
    contractVersion: 1,
    sessionId,
    epoch,
    sequence: ++frameSeq,
    ...fields,
  } as VoiceClientFrame;
}

export async function flush(rig: VoiceTestRig, sessionId: string, rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await rig.engine.drain(sessionId);
    await Promise.resolve();
  }
}

export const READY_AUDIO = {
  codec: "pcm_s16le",
  sampleRateHz: 16_000,
  channels: 1,
  frameDurationMs: 20,
} as const;

export const READY_CAPABILITIES = {
  formats: [READY_AUDIO],
  binaryAudio: false,
  maxAudioFrameBytes: 64 * 1024,
  deviceChangeEvents: true,
} as const;

/** Drive a session to `listening`: create + attach + client.ready. */
export async function listeningSession(
  rig: VoiceTestRig,
  options: Parameters<typeof createAttached>[1] = {},
) {
  const attached = createAttached(rig, options);
  await attached.handle.receive(clientFrame(attached.sessionId, attached.epoch, {
    type: "client.ready",
    audio: READY_AUDIO,
    capabilities: READY_CAPABILITIES,
  }));
  await flush(rig, attached.sessionId);
  return attached;
}

export function lastFrame(sink: FakeSink, type?: string): VoiceServerFrame | undefined {
  const frames = type ? sink.frames.filter((frame) => frame.type === type) : sink.frames;
  return frames[frames.length - 1];
}

export function framesOfType<T extends VoiceServerFrame["type"]>(
  sink: FakeSink,
  type: T,
): Extract<VoiceServerFrame, { type: T }>[] {
  return sink.frames.filter((frame): frame is Extract<VoiceServerFrame, { type: T }> => frame.type === type);
}
