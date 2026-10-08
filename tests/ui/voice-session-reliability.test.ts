// @vitest-environment jsdom
/**
 * Wave D client reliability regressions: bounded remote-session cleanup
 * (dedupe, injected-timer retries, safe exhaustion notice), transport-loss
 * media shutdown without implied cancellation, observed AudioContext.resume
 * failures, device-loss release, and cancelled deferred startup fencing.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createVoiceSessionClient,
  type VoiceSessionClientOptions,
} from "../../packages/ui/src/voice-session/use-voice-session";
import {
  createWebVoiceMediaSession,
  type VoiceAudioContextLike,
  type VoiceCaptureFactory,
  type VoiceMediaCallbacks,
  type VoiceMediaDevicesLike,
  type VoiceMediaSession,
  type VoiceMediaStreamTrackLike,
  type VoicePcmBuffer,
  type VoicePlaybackSource,
} from "../../packages/ui/src/voice-session/media-session";
import type { SafeVoiceError } from "../../packages/contracts/src/voice-session";
import { createRemoteCleanupQueue } from "../../packages/ui/src/voice-session/client-reconnect";
import type { VoiceTransportSocket } from "../../packages/ui/src/voice-session/transport";
import type { AudioFormat, VoiceOutputAudioFormat } from "../../packages/contracts/src/voice-session";

const CHAT_ID = "chat_1";
const SESSION_ID = "vs_1";
const WS_URL = `wss://gw.example/ws/chats/${CHAT_ID}/voice/${SESSION_ID}`;
const MONO: AudioFormat = { codec: "pcm_s16le", sampleRateHz: 16_000, channels: 1, frameDurationMs: 20 };

const CAPABILITY = {
  contractVersion: 1,
  status: "available",
  surface: "web_canvas",
  transportModes: ["relayed_websocket"],
  turnModes: ["hands_free", "push_to_talk"],
  supportsInterruption: true,
  resume: "delivery_aware",
  sessionOnly: "enforced",
  actionMode: "conversation_only",
  actionCancellation: "none",
  supportsInputSelection: false,
  supportsOutputSelection: false,
};

const LIMITS = { maxSessionSeconds: 3600, maxIdleSeconds: 300, maxQueuedAudioMs: 10_000 };

function grant(ticket: string, epoch: number) {
  return {
    kind: "relayed_websocket",
    url: WS_URL,
    ticket,
    expiresAt: "2026-01-01T00:00:00Z",
    epoch,
  };
}

function createdBody(ticket = "ticket-1", epoch = 1) {
  return {
    sessionId: SESSION_ID,
    chatId: CHAT_ID,
    limits: LIMITS,
    outcome: "created",
    status: "connecting",
    transport: grant(ticket, epoch),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeSocket implements VoiceTransportSocket {
  readyState = 0;
  bufferedAmount = 0;
  readonly sent: Record<string, unknown>[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (typeof data === "string") this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closedWith = { code, reason };
    this.onclose?.({ code: code ?? 1_000, reason: reason ?? "", wasClean: true });
  }

  emitOpen(): void {
    this.readyState = 1;
    this.onopen?.({ type: "open" });
  }

  emitFrame(sequence: number, body: Record<string, unknown>, epoch = 1): void {
    this.onmessage?.({
      data: JSON.stringify({
        contractVersion: 1,
        sessionId: SESSION_ID,
        epoch,
        sequence,
        ...body,
      }),
    });
  }

  emitClose(code = 1_006): void {
    this.readyState = 3;
    this.onclose?.({ code, reason: "", wasClean: false });
  }
}

interface FakeMedia {
  session: VoiceMediaSession;
  callbacks: VoiceMediaCallbacks | null;
  startedTurns: string[];
  stops: number;
  playbackStops: number;
  enqueued: { responseId: string; segmentId: string; data: string; format?: VoiceOutputAudioFormat }[];
  releases: number;
}

function fakeMedia(prepareImpl?: () => Promise<void>): FakeMedia {
  const media: FakeMedia = {
    callbacks: null,
    startedTurns: [],
    stops: 0,
    playbackStops: 0,
    enqueued: [],
    releases: 0,
    session: {
      supported: true,
      prepare: vi.fn(prepareImpl ?? (async () => undefined)),
      startCapture: vi.fn(({ turnId }: { turnId: string }) => {
        media.startedTurns.push(turnId);
        return true;
      }),
      stopCapture: vi.fn(() => {
        media.stops += 1;
      }),
      enqueueSegment: vi.fn((input: { responseId: string; segmentId: string; data: string; format?: VoiceOutputAudioFormat }) => {
        media.enqueued.push(input);
      }),
      interruptResponse: vi.fn(() => 123),
      stopPlayback: vi.fn(() => {
        media.playbackStops += 1;
      }),
      playedThroughMs: vi.fn(() => null),
      pendingAudioMs: () => 0,
      release: vi.fn(async () => {
        media.releases += 1;
      }),
    },
  };
  return media;
}

interface ScheduledTask {
  callback: () => void;
  cleared: boolean;
}

interface World {
  options: VoiceSessionClientOptions;
  media: FakeMedia;
  sockets: FakeSocket[];
  calls: { method: string; path: string; body: unknown }[];
  scheduled: ScheduledTask[];
  runScheduled(): void;
}

function makeWorld(overrides: {
  create?: () => unknown;
  capability?: () => unknown;
  reconnect?: () => unknown;
  delete?: () => unknown;
  prepare?: () => Promise<void>;
  turnMode?: "hands_free" | "push_to_talk";
  mediaFactory?: VoiceSessionClientOptions["mediaFactory"];
} = {}): World {
  const media = fakeMedia(overrides.prepare);
  const sockets: FakeSocket[] = [];
  const calls: World["calls"] = [];
  const scheduled: ScheduledTask[] = [];
  const world: World = {
    options: undefined as unknown as VoiceSessionClientOptions,
    media,
    sockets,
    calls,
    scheduled,
    runScheduled: () => {
      const pending = scheduled.splice(0).filter((task) => !task.cleared);
      for (const task of pending) task.callback();
    },
  };
  const routes = new Map<string, () => unknown>([
    [`GET /api/chats/${CHAT_ID}/voice/capabilities`, overrides.capability ?? (() => CAPABILITY)],
    [`POST /api/chats/${CHAT_ID}/voice/sessions`, overrides.create ?? (() => createdBody())],
    [`POST /api/chats/${CHAT_ID}/voice/sessions/${SESSION_ID}/reconnect`, overrides.reconnect ?? (() => ({
      sessionId: SESSION_ID,
      chatId: CHAT_ID,
      limits: LIMITS,
      transport: grant("ticket-2", 2),
    }))],
    [`DELETE /api/chats/${CHAT_ID}/voice/sessions/${SESSION_ID}`, overrides.delete ?? (() => ({ status: "ended" }))],
  ]);
  const fetcher = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes.get(`${method} ${url.pathname}`)
      ?? routes.get(`${method} ${url.pathname.split("/").slice(0, -1).join("/")}`);
    if (!route) {
      return new Response(JSON.stringify({
        error: { code: "internal_failure", retryable: false, recovery: "none" },
      }), { status: 500 });
    }
    const body = await route();
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  let counter = 0;
  world.options = {
    baseUrl: "https://gw.example",
    request: {
      turnMode: overrides.turnMode ?? "push_to_talk",
      selection: { instanceId: "inst_voice", model: "opus" },
      interactionMode: "default",
      permissionMode: "supervised",
      memoryMode: "session_only",
    },
    fetcher,
    webSocketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    mediaFactory: overrides.mediaFactory ?? (({ callbacks }) => {
      media.callbacks = callbacks;
      return media.session;
    }),
    createId: (prefix) => `${prefix}tid-${(counter += 1)}`,
    setTimeoutFn: (callback) => {
      const task: ScheduledTask = { callback, cleared: false };
      scheduled.push(task);
      return task;
    },
    clearTimeoutFn: (timer) => {
      (timer as ScheduledTask).cleared = true;
    },
    setIntervalFn: () => undefined,
    clearIntervalFn: () => undefined,
    makeTimeoutSignal: () => new AbortController().signal,
    heartbeatIntervalMs: 250,
    heartbeatTimeoutMs: 500,
  };
  return world;
}

function deleteCalls(world: World) {
  return world.calls.filter((call) => call.method === "DELETE");
}

function listen(world: World, socketIndex = 0, epoch = 1) {
  world.sockets[socketIndex]!.emitFrame(1, { type: "session.state", state: "listening" }, epoch);
}

const pcmSegment = (samples: number): string => {
  const bytes = new Uint8Array(samples * 2);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

class FakeSource implements VoicePlaybackSource {
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  stopped = false;
  constructor(readonly buffer: VoicePcmBuffer) {}
  start(atSeconds?: number): void {
    this.startedAt = atSeconds ?? null;
  }
  stop(): void {
    this.stopped = true;
    this.onended?.();
  }
}

/** Real media session over injectable fakes; exercises the actual playout/capture paths. */
function mediaKit(options: {
  getUserMedia?: () => Promise<unknown>;
  resume?: () => Promise<void>;
} = {}) {
  const sources: FakeSource[] = [];
  let endedListener: (() => void) | null = null;
  const track: VoiceMediaStreamTrackLike & { stop: ReturnType<typeof vi.fn> } = {
    stop: vi.fn(),
    getSettings: () => ({ deviceId: "mic_default" }),
    addEventListener: (_type: "ended", listener: () => void) => {
      endedListener = listener;
    },
    removeEventListener: vi.fn(),
  };
  const stream = { getTracks: () => [track] };
  const devices: VoiceMediaDevicesLike & { getUserMedia: ReturnType<typeof vi.fn> } = {
    getUserMedia: vi.fn(options.getUserMedia ?? (async () => stream)),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const context: VoiceAudioContextLike & { close: ReturnType<typeof vi.fn> } = {
    currentTimeSeconds: 0,
    sampleRateHz: 16_000,
    createPcmBuffer: ({ samples }) => ({ durationMs: (samples.length / 16_000) * 1_000, native: samples }),
    createSource: (buffer) => {
      const source = new FakeSource(buffer);
      sources.push(source);
      return source;
    },
    close: vi.fn(async () => undefined),
    ...(options.resume === undefined ? {} : { resume: options.resume }),
  };
  const captureStop = vi.fn(async () => undefined);
  const captureFactory: VoiceCaptureFactory = () => ({ sampleRateHz: 16_000, stop: captureStop });
  const factory: VoiceSessionClientOptions["mediaFactory"] = ({ audio, callbacks }) =>
    createWebVoiceMediaSession({
      audio,
      callbacks,
      mediaDevices: devices,
      createAudioContext: () => context,
      captureFactory,
    });
  return {
    track,
    stream,
    devices,
    context,
    sources,
    captureStop,
    captureFactory,
    factory,
    fireTrackEnded: () => endedListener?.(),
  };
}

describe("bounded remote cleanup", () => {
  it("dedupes in-flight remote DELETEs for the same session key", async () => {
    const pending = deferred<unknown>();
    const world = makeWorld({ delete: () => pending.promise });
    const client = createVoiceSessionClient(world.options);
    await client.startVoice(CHAT_ID);
    const socket = world.sockets[0]!;
    socket.emitOpen();
    listen(world);

    await client.end();
    await vi.waitFor(() => expect(deleteCalls(world)).toHaveLength(1));

    // A second teardown while the first DELETE is in flight must not re-issue.
    client.dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(deleteCalls(world)).toHaveLength(1);

    pending.resolve({ status: "ended" });
    await Promise.resolve();
  });

  it("retries a failed DELETE on injected timers, bounded at 3 attempts, then holds a safe notice", async () => {
    let deletes = 0;
    const world = makeWorld({
      delete: () => {
        deletes += 1;
        return new Response("upstream unavailable", { status: 500 });
      },
    });
    const client = createVoiceSessionClient(world.options);
    await client.startVoice(CHAT_ID);
    const socket = world.sockets[0]!;
    socket.emitOpen();
    listen(world);

    await client.end();
    await vi.waitFor(() => expect(deletes).toBe(1));

    // Retries run on the injected scheduler, not real timers; wait until each
    // failed attempt has queued its timer before flushing.
    await vi.waitFor(() => expect(world.scheduled.length).toBe(1));
    world.runScheduled();
    await vi.waitFor(() => expect(deletes).toBe(2));
    await vi.waitFor(() => expect(world.scheduled.length).toBe(1));
    world.runScheduled();
    await vi.waitFor(() => expect(deletes).toBe(3));

    // Bounded: nothing further is scheduled, and the failure stays discoverable.
    world.runScheduled();
    await Promise.resolve();
    expect(deletes).toBe(3);
    expect(client.getSnapshot().notice).toMatchObject({
      code: "connection_lost",
      retryable: false,
    });

    // An exhausted job is settled — dispose must not re-enqueue it.
    client.dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(deletes).toBe(3);
  });

  it("marks cleanup settled only after the DELETE confirms", async () => {
    let deletes = 0;
    const world = makeWorld({
      delete: () => {
        deletes += 1;
        return deletes === 1 ? new Response("lost", { status: 500 }) : { status: "ended" };
      },
    });
    const client = createVoiceSessionClient(world.options);
    await client.startVoice(CHAT_ID);
    const socket = world.sockets[0]!;
    socket.emitOpen();
    listen(world);

    await client.end();
    await vi.waitFor(() => expect(deletes).toBe(1));

    // The failed first attempt leaves the job unsettled: the retry runs.
    await vi.waitFor(() => expect(world.scheduled.length).toBe(1));
    world.runScheduled();
    await vi.waitFor(() => expect(deletes).toBe(2));

    client.dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(deletes).toBe(2);
    expect(client.getSnapshot().notice).toBeNull();
  });

  it("routes a session minted after a cancelled create through the same bounded cleanup", async () => {
    const created = deferred<unknown>();
    let deletes = 0;
    const world = makeWorld({
      create: () => created.promise,
      delete: () => {
        deletes += 1;
        return deletes === 1 ? new Response("lost", { status: 500 }) : { status: "ended" };
      },
    });
    const client = createVoiceSessionClient(world.options);
    const startP = client.startVoice(CHAT_ID);
    await vi.waitFor(() => expect(
      world.calls.some((call) => call.method === "POST" && call.path.endsWith("/voice/sessions")),
    ).toBe(true));

    await client.end();
    created.resolve(createdBody());
    await startP;

    // The remote session minted after cancellation is not leaked: cleanup is
    // queued, and a failed first DELETE is retried rather than dropped.
    await vi.waitFor(() => expect(deletes).toBe(1));
    await vi.waitFor(() => expect(world.scheduled.length).toBe(1));
    world.runScheduled();
    await vi.waitFor(() => expect(deletes).toBe(2));
    expect(client.getSnapshot().phase).toBe("ended");
    expect(world.sockets).toHaveLength(0);
    client.dispose();
  });
});

describe("transport loss silences media", () => {
  it("stops capture and all queued playback on connection loss without implying cancellation", async () => {
    const world = makeWorld({ turnMode: "hands_free" });
    const client = createVoiceSessionClient(world.options);
    await client.startVoice(CHAT_ID);
    const socket = world.sockets[0]!;
    socket.emitOpen();
    listen(world);
    expect(world.media.startedTurns).toEqual(["vturn_tid-2"]);

    socket.emitFrame(2, { type: "response.started", responseId: "vresp_1", runId: "run_1" });
    socket.emitFrame(3, {
      type: "response.audio",
      responseId: "vresp_1",
      segmentId: "vseg_1",
      startMs: 0,
      data: "QUJD",
    });
    socket.emitFrame(4, {
      type: "response.audio",
      responseId: "vresp_1",
      segmentId: "vseg_2",
      startMs: 0,
      data: "QUJD",
    });
    expect(world.media.enqueued).toHaveLength(2);

    socket.emitClose(1_006);
    expect(client.getSnapshot().phase).toBe("reconnecting");
    // Capture and every current/queued playback halt immediately.
    expect(world.media.stops).toBe(1);
    expect(world.media.playbackStops).toBe(1);
    // Nothing may imply the run, generation, or a tool was cancelled.
    const wireTypes = socket.sent.map((frame) => frame.type);
    expect(wireTypes).not.toContain("response.interrupt");
    expect(wireTypes).not.toContain("session.end");

    // A higher-epoch resume restarts hands-free capture with a fresh turn id.
    world.runScheduled();
    await vi.waitFor(() => expect(world.sockets).toHaveLength(2));
    const replacement = world.sockets[1]!;
    replacement.emitOpen();
    replacement.emitFrame(1, { type: "session.resumed", state: "listening", reason: "restored" }, 2);
    expect(client.getSnapshot().phase).toBe("active");
    await vi.waitFor(() => expect(world.media.startedTurns).toHaveLength(2));
    expect(replacement.sent.some((frame) => frame.type === "capture.start")).toBe(true);
    client.dispose();
  });

  it("stopPlayback drops the current source and pending queue, freeing redelivery after loss", async () => {
    const kit = mediaKit();
    const session = createWebVoiceMediaSession({
      audio: MONO,
      callbacks: { onAudioChunk: () => true, onSegmentPlayed: () => undefined },
      mediaDevices: kit.devices,
      createAudioContext: () => kit.context,
      captureFactory: kit.captureFactory,
    });
    await session.prepare();
    session.enqueueSegment({ responseId: "vresp_1", segmentId: "vseg_1", data: pcmSegment(3_200) });
    session.enqueueSegment({ responseId: "vresp_1", segmentId: "vseg_2", data: pcmSegment(3_200) });
    expect(kit.sources).toHaveLength(1); // seg1 playing, seg2 queued

    session.stopPlayback();
    expect(kit.sources[0]!.stopped).toBe(true);

    // A post-resume redelivery of unplayed audio must be allowed to play again.
    session.enqueueSegment({ responseId: "vresp_1", segmentId: "vseg_2", data: pcmSegment(3_200) });
    expect(kit.sources).toHaveLength(2);
    await session.release();
  });
});

describe("observed AudioContext.resume failure", () => {
  it("surfaces a rejected resume as output_unavailable instead of believing audio is live", async () => {
    const kit = mediaKit({ resume: () => Promise.reject(new Error("autoplay blocked")) });
    const world = makeWorld({ mediaFactory: kit.factory });
    const client = createVoiceSessionClient(world.options);
    await client.startVoice(CHAT_ID);
    const socket = world.sockets[0]!;
    socket.emitOpen();
    listen(world);

    socket.emitFrame(2, { type: "response.started", responseId: "vresp_1", runId: "run_1" });
    socket.emitFrame(3, {
      type: "response.audio",
      responseId: "vresp_1",
      segmentId: "vseg_1",
      startMs: 0,
      data: pcmSegment(3_200),
    });

    await vi.waitFor(() => expect(client.getSnapshot().phase).toBe("failed"));
    expect(client.getSnapshot().error).toMatchObject({
      code: "output_unavailable",
      recovery: "choose_output",
      retryable: true,
    });
    // The dead context is released rather than kept as apparently-active output.
    await vi.waitFor(() => expect(kit.context.close).toHaveBeenCalled());
    client.dispose();
  });
});

describe("device loss", () => {
  it("releases media, stops playback, and fails with an allowlisted choose_input", async () => {
    const kit = mediaKit();
    const world = makeWorld({ mediaFactory: kit.factory });
    const client = createVoiceSessionClient(world.options);
    await client.startVoice(CHAT_ID);
    const socket = world.sockets[0]!;
    socket.emitOpen();
    listen(world);
    socket.emitFrame(2, { type: "response.started", responseId: "vresp_1", runId: "run_1" });
    socket.emitFrame(3, {
      type: "response.audio",
      responseId: "vresp_1",
      segmentId: "vseg_1",
      startMs: 0,
      data: pcmSegment(3_200),
    });
    expect(kit.sources).toHaveLength(1);

    kit.fireTrackEnded();
    await vi.waitFor(() => expect(client.getSnapshot().phase).toBe("failed"));
    expect(client.getSnapshot().error).toMatchObject({
      code: "input_unavailable",
      recovery: "choose_input",
      retryable: true,
    });
    // No ghost mic or stale playback: track, capture handle, and source die.
    await vi.waitFor(() => expect(kit.captureStop).toHaveBeenCalled());
    await vi.waitFor(() => expect(kit.track.stop).toHaveBeenCalled());
    await vi.waitFor(() => expect(kit.sources[0]!.stopped).toBe(true));
    await vi.waitFor(() => expect(deleteCalls(world)).toHaveLength(1));
    client.dispose();
  });
});

describe("cancelled deferred startup", () => {
  it("a cancelled deferred permission resolves to a released mic, never a ghost capture", async () => {
    const pending = deferred<unknown>();
    const kit = mediaKit({ getUserMedia: () => pending.promise });
    const world = makeWorld({ mediaFactory: kit.factory });
    const client = createVoiceSessionClient(world.options);

    const startP = client.startVoice(CHAT_ID);
    await vi.waitFor(() => expect(kit.devices.getUserMedia).toHaveBeenCalledOnce());

    await client.end();
    pending.resolve(kit.stream);
    await startP;

    // The late-granted stream is stopped immediately; nothing captures.
    expect(kit.track.stop).toHaveBeenCalled();
    expect(world.calls.some((call) => call.method === "POST" && call.path.endsWith("/voice/sessions"))).toBe(false);
    expect(world.sockets).toHaveLength(0);
    expect(client.getSnapshot().phase).toBe("ended");
    client.dispose();
  });

  it("a reconnect grant resolving after end() is fenced by generation", async () => {
    const pending = deferred<unknown>();
    const world = makeWorld({ reconnect: () => pending.promise });
    const client = createVoiceSessionClient(world.options);
    await client.startVoice(CHAT_ID);
    const socket = world.sockets[0]!;
    socket.emitOpen();
    listen(world);

    socket.emitClose(1_006);
    world.runScheduled();
    await vi.waitFor(() => expect(
      world.calls.some((call) => call.method === "POST" && call.path.endsWith("/reconnect")),
    ).toBe(true));

    await client.end();
    pending.resolve({
      sessionId: SESSION_ID,
      chatId: CHAT_ID,
      limits: LIMITS,
      transport: grant("ticket-late", 9),
    });
    await Promise.resolve();
    await Promise.resolve();

    // The superseded grant must never attach a socket or mutate state.
    expect(world.sockets).toHaveLength(1);
    expect(client.getSnapshot().phase).toBe("ended");
    client.dispose();
  });
});

describe("failed cleanup registry and explicit retry", () => {
  function queueHarness(deleteImpl: () => unknown) {
    let now = 1_000;
    const scheduled: { callback: () => void; ms: number }[] = [];
    const exhausted: string[] = [];
    const settled: string[] = [];
    const queue = createRemoteCleanupQueue({
      deleteRemote: async () => {
        const outcome = deleteImpl();
        if (outcome instanceof Error) throw outcome;
      },
      setTimeoutFn: (callback, ms) => {
        const task = { callback, ms };
        scheduled.push(task);
        return task;
      },
      clearTimeoutFn: () => undefined,
      now: () => now,
      onExhausted: (chatId, sessionId) => exhausted.push(`${chatId}/${sessionId}`),
      onSettled: (chatId, sessionId) => settled.push(`${chatId}/${sessionId}`),
    });
    return {
      queue,
      scheduled,
      exhausted,
      settled,
      advance: (ms: number) => { now += ms; },
      runScheduled: () => {
        for (const task of scheduled.splice(0)) task.callback();
      },
    };
  }

  async function exhaust(h: ReturnType<typeof queueHarness>) {
    h.queue.enqueue(CHAT_ID, SESSION_ID);
    await vi.waitFor(() => expect(h.scheduled.length).toBe(1));
    h.runScheduled();
    await vi.waitFor(() => expect(h.scheduled.length).toBe(1));
    h.runScheduled();
    await vi.waitFor(() => expect(h.exhausted).toHaveLength(1));
  }

  it("an exhausted DELETE is NOT settled: it parks in the failed registry and enqueue dedupes", async () => {
    const h = queueHarness(() => new Error("upstream unavailable"));
    await exhaust(h);

    expect(h.queue.isSettled(CHAT_ID, SESSION_ID)).toBe(false);
    expect(h.queue.isFailed(CHAT_ID, SESSION_ID)).toBe(true);
    expect(h.queue.failedSize()).toBe(1);
    expect(h.queue.size()).toBe(0);

    // Automatic re-enqueue (teardown/dispose) never restarts the cycle.
    let deletes = 0;
    const recount = queueHarness(() => {
      deletes += 1;
      return new Error("still down");
    });
    await exhaust(recount);
    recount.queue.enqueue(CHAT_ID, SESSION_ID);
    await Promise.resolve();
    expect(deletes).toBe(3); // bounded at max attempts; nothing new ran
  });

  it("retryCleanup is rate-limited to one fresh bounded cycle per key per 60s", async () => {
    let deletes = 0;
    const h = queueHarness(() => {
      deletes += 1;
      return deletes < 4 ? new Error("down") : { status: "ended" };
    });
    await exhaust(h);
    expect(deletes).toBe(3);

    // Inside the 60s window the explicit retry is refused without a DELETE.
    expect(h.queue.retryCleanup(CHAT_ID, SESSION_ID)).toBe(false);
    expect(deletes).toBe(3);
    expect(h.queue.isFailed(CHAT_ID, SESSION_ID)).toBe(true);

    // After the window a fresh bounded cycle runs and settles on success.
    h.advance(61_000);
    expect(h.queue.retryCleanup(CHAT_ID, SESSION_ID)).toBe(true);
    await vi.waitFor(() => expect(deletes).toBe(4));
    await vi.waitFor(() => expect(h.settled).toEqual([`${CHAT_ID}/${SESSION_ID}`]));
    expect(h.queue.isSettled(CHAT_ID, SESSION_ID)).toBe(true);
    expect(h.queue.isFailed(CHAT_ID, SESSION_ID)).toBe(false);

    // A settled or unknown key is never retried.
    expect(h.queue.retryCleanup(CHAT_ID, SESSION_ID)).toBe(false);
    expect(h.queue.retryCleanup(CHAT_ID, "vs_other")).toBe(false);
  });

  it("a retry cycle that exhausts again re-parks in the failed registry", async () => {
    const h = queueHarness(() => new Error("permanent outage"));
    await exhaust(h);
    h.advance(61_000);
    expect(h.queue.retryFailed()).toBe(1);

    await vi.waitFor(() => expect(h.scheduled.length).toBe(1));
    h.runScheduled();
    await vi.waitFor(() => expect(h.scheduled.length).toBe(1));
    h.runScheduled();
    await vi.waitFor(() => expect(h.exhausted).toHaveLength(2));
    expect(h.queue.isFailed(CHAT_ID, SESSION_ID)).toBe(true);
    expect(h.queue.isSettled(CHAT_ID, SESSION_ID)).toBe(false);
    // The fresh exhaustion restarts the 60s window.
    expect(h.queue.retryCleanup(CHAT_ID, SESSION_ID)).toBe(false);
  });

  it("client.retryCleanup runs the failed DELETE cycle once the window opens and clears the notice", async () => {
    let now = 50_000;
    let deletes = 0;
    const world = makeWorld({
      delete: () => {
        deletes += 1;
        return deletes < 4 ? new Response("upstream unavailable", { status: 500 }) : { status: "ended" };
      },
    });
    world.options.now = () => now;
    const client = createVoiceSessionClient(world.options);
    await client.startVoice(CHAT_ID);
    const socket = world.sockets[0]!;
    socket.emitOpen();
    listen(world);

    await client.end();
    await vi.waitFor(() => expect(deletes).toBe(1));
    await vi.waitFor(() => expect(world.scheduled.length).toBe(1));
    world.runScheduled();
    await vi.waitFor(() => expect(deletes).toBe(2));
    await vi.waitFor(() => expect(world.scheduled.length).toBe(1));
    world.runScheduled();
    await vi.waitFor(() => expect(deletes).toBe(3));
    expect(client.getSnapshot().notice).toMatchObject({ code: "connection_lost" });

    // Explicit retry inside the 60s window is refused; nothing is enqueued.
    expect(client.retryCleanup()).toBe(0);
    await Promise.resolve();
    expect(deletes).toBe(3);

    now += 61_000;
    expect(client.retryCleanup()).toBe(1);
    await vi.waitFor(() => expect(deletes).toBe(4));
    // The confirmed DELETE retires the failure notice.
    await vi.waitFor(() => expect(client.getSnapshot().notice).toBeNull());
    client.dispose();
    await Promise.resolve();
    expect(deletes).toBe(4);
  });
});

describe("prepare rejection after partial allocation", () => {
  it("releases held media and fences late callbacks when a custom prepare rejects mid-allocation", async () => {
    let capturedCallbacks: VoiceMediaCallbacks | null = null;
    let releases = 0;
    let allocated = false;
    const world = makeWorld({
      mediaFactory: ({ callbacks }) => {
        capturedCallbacks = callbacks;
        const session: VoiceMediaSession = {
          supported: true,
          // Custom prepare allocates a resource, THEN rejects — the classic
          // partial-allocation failure the client must still unwind.
          prepare: vi.fn(async () => {
            allocated = true;
            throw new Error("custom prepare exploded");
          }),
          startCapture: vi.fn(() => true),
          stopCapture: vi.fn(),
          enqueueSegment: vi.fn(),
          interruptResponse: vi.fn(() => null),
          stopPlayback: vi.fn(),
          playedThroughMs: vi.fn(() => null),
          pendingAudioMs: () => 0,
          release: vi.fn(async () => {
            releases += 1;
          }),
        };
        return session;
      },
    });
    const client = createVoiceSessionClient(world.options);
    await client.startVoice(CHAT_ID);

    expect(allocated).toBe(true);
    // The rejected media is released even though failSession no longer sees it.
    await vi.waitFor(() => expect(releases).toBe(1));
    expect(client.getSnapshot()).toMatchObject({
      phase: "failed",
      error: { code: "input_unavailable", recovery: "choose_input" },
    });
    // No remote session was minted, so nothing needs deleting.
    expect(world.calls.some((call) => call.method === "POST" && call.path.endsWith("/voice/sessions"))).toBe(false);

    // Late callbacks from the dead media are fenced: no chunks, no resurrection.
    expect(capturedCallbacks!.onAudioChunk({ turnId: "vturn_x", timestampMs: 0, data: "QUJD" })).toBe(false);
    capturedCallbacks!.onError?.({ code: "input_unavailable", retryable: true, recovery: "choose_input" });
    expect(client.getSnapshot().phase).toBe("failed");
    client.dispose();
    expect(releases).toBe(1);
  });
});
