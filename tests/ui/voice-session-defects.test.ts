// @vitest-environment jsdom
/**
 * Regression coverage for the research-verified voice session defects:
 * in-flight start fencing, mic release on failure, remote-ended/failed
 * phases, client.ready wire ordering, reconnect serialization, replayed
 * audio dedupe, mono capture honesty, and output-format tolerance.
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
  type VoiceMediaStreamLike,
  type VoicePcmBuffer,
  type VoicePlaybackSource,
} from "../../packages/ui/src/voice-session/media-session";
import { voiceErrorForCode } from "../../packages/ui/src/voice-session/session-api";
import { voiceDeclaredAudioFormat } from "../../packages/ui/src/voice-session/client-transport";
import { createReconnectLoop } from "../../packages/ui/src/voice-session/client-reconnect";
import {
  VoiceTransport,
  type VoiceTransportSocket,
} from "../../packages/ui/src/voice-session/transport";
import type {
  AudioFormat,
  VoiceOutputAudioFormat,
  VoicePlaybackAck,
} from "../../packages/contracts/src/voice-session";

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
  readonly rawSent: (string | ArrayBuffer | ArrayBufferView)[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    this.rawSent.push(data);
    if (typeof data === "string") {
      this.sent.push(JSON.parse(data) as Record<string, unknown>);
    } else {
      this.sent.push({ type: "__binary__" });
    }
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
  enqueued: { responseId: string; segmentId: string; data: string; format?: VoiceOutputAudioFormat }[];
  interrupts: string[];
  releases: number;
  order: string[];
}

function fakeMedia(prepareImpl?: () => Promise<void>): FakeMedia {
  const media: FakeMedia = {
    callbacks: null,
    startedTurns: [],
    stops: 0,
    enqueued: [],
    interrupts: [],
    releases: 0,
    order: [],
    session: {
      supported: true,
      prepare: vi.fn(prepareImpl ?? (async () => undefined)),
      startCapture: vi.fn(({ turnId }: { turnId: string }) => {
        media.startedTurns.push(turnId);
        media.order.push("startCapture");
        return true;
      }),
      stopCapture: vi.fn(() => {
        media.stops += 1;
        media.order.push("stopCapture");
      }),
      enqueueSegment: vi.fn((input: { responseId: string; segmentId: string; data: string; format?: VoiceOutputAudioFormat }) => {
        media.enqueued.push(input);
      }),
      interruptResponse: vi.fn((responseId: string) => {
        media.interrupts.push(responseId);
        return 123;
      }),
      playedThroughMs: vi.fn(() => null),
      pendingAudioMs: () => 0,
      release: vi.fn(async () => {
        media.releases += 1;
        media.order.push("release");
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
  urls: string[];
  calls: { method: string; path: string; body: unknown }[];
  scheduled: ScheduledTask[];
  heartbeatTicks: (() => void)[];
  factoryAudio: AudioFormat | null;
  respond(path: string, body: () => unknown): void;
  runScheduled(): void;
}

function makeWorld(overrides: {
  create?: () => unknown;
  capability?: () => unknown;
  reconnect?: () => unknown;
  prepare?: () => Promise<void>;
  turnMode?: "hands_free" | "push_to_talk";
  audio?: AudioFormat;
  maxReconnectAttempts?: number;
  mediaCapabilities?: VoiceSessionClientOptions["mediaCapabilities"];
} = {}): World {
  const media = fakeMedia(overrides.prepare);
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const calls: World["calls"] = [];
  const scheduled: ScheduledTask[] = [];
  const heartbeatTicks: (() => void)[] = [];
  const world: World = {
    options: undefined as unknown as VoiceSessionClientOptions,
    media,
    sockets,
    urls,
    calls,
    scheduled,
    heartbeatTicks,
    factoryAudio: null,
    respond: (path, body) => routes.set(path, body),
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
    [`DELETE /api/chats/${CHAT_ID}/voice/sessions/${SESSION_ID}`, () => ({ status: "ended" })],
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
    webSocketFactory: (url) => {
      urls.push(url);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    mediaFactory: ({ audio, callbacks }) => {
      world.factoryAudio = audio;
      media.callbacks = callbacks;
      return media.session;
    },
    createId: (prefix) => `${prefix}tid-${(counter += 1)}`,
    setTimeoutFn: (callback) => {
      const task: ScheduledTask = { callback, cleared: false };
      scheduled.push(task);
      return task;
    },
    clearTimeoutFn: (timer) => {
      (timer as ScheduledTask).cleared = true;
    },
    setIntervalFn: (callback) => {
      heartbeatTicks.push(callback);
      return callback;
    },
    clearIntervalFn: () => undefined,
    makeTimeoutSignal: () => new AbortController().signal,
    heartbeatIntervalMs: 250,
    heartbeatTimeoutMs: 500,
    ...(overrides.audio === undefined ? {} : { audio: overrides.audio }),
    ...(overrides.maxReconnectAttempts === undefined
      ? {}
      : { maxReconnectAttempts: overrides.maxReconnectAttempts }),
    ...(overrides.mediaCapabilities === undefined
      ? {}
      : { mediaCapabilities: overrides.mediaCapabilities }),
  };
  return world;
}

function deleteCalls(world: World) {
  return world.calls.filter((call) => call.method === "DELETE");
}

function listen(world: World, socketIndex = 0, epoch = 1) {
  world.sockets[socketIndex]!.emitFrame(1, { type: "session.state", state: "listening" }, epoch);
}

describe("in-flight start fencing (cancel hides no live session)", () => {
  it("end() during createSession fences the late grant, deletes the minted session, and releases the mic", async () => {
    const created = deferred<unknown>();
    const world = makeWorld({ create: () => created.promise });
    const client = createVoiceSessionClient(world.options);

    const startP = client.startVoice(CHAT_ID);
    await vi.waitFor(() => expect(
      world.calls.some((call) => call.method === "POST" && call.path.endsWith("/voice/sessions")),
    ).toBe(true));

    await client.end();
    expect(client.getSnapshot().phase).toBe("ended");

    created.resolve(createdBody());
    await startP;
    await vi.waitFor(() => expect(world.media.releases).toBeGreaterThan(0));

    // No transport may be attached after cancel, and the minted remote
    // session must be deleted best-effort.
    expect(world.sockets).toHaveLength(0);
    expect(deleteCalls(world)).toHaveLength(1);
    expect(client.getSnapshot().phase).toBe("ended");
    client.dispose();
  });

  it("end() during getCapabilities aborts the start before any session is minted", async () => {
    const capability = deferred<unknown>();
    const world = makeWorld({ capability: () => capability.promise });
    const client = createVoiceSessionClient(world.options);

    const startP = client.startVoice(CHAT_ID);
    await vi.waitFor(() => expect(
      world.calls.some((call) => call.path.endsWith("/voice/capabilities")),
    ).toBe(true));

    await client.end();
    capability.resolve(CAPABILITY);
    await startP;

    expect(world.calls.some((call) => call.method === "POST")).toBe(false);
    expect(world.sockets).toHaveLength(0);
    expect(deleteCalls(world)).toHaveLength(0);
    expect(client.getSnapshot().phase).toBe("ended");
    client.dispose();
  });

  it("end() during getUserMedia releases the mic and never creates a remote session", async () => {
    const prepared = deferred<void>();
    const world = makeWorld({ prepare: () => prepared.promise });
    const client = createVoiceSessionClient(world.options);

    const startP = client.startVoice(CHAT_ID);
    await vi.waitFor(() => expect(world.media.session.prepare).toHaveBeenCalledOnce());

    await client.end();
    expect(world.media.releases).toBe(1);

    prepared.resolve();
    await startP;

    expect(world.calls.some((call) => call.method === "POST")).toBe(false);
    expect(world.sockets).toHaveLength(0);
    expect(client.getSnapshot().phase).toBe("ended");
    client.dispose();
  });

  it("continueInChat during createSession fences the late grant and deletes the minted session", async () => {
    const created = deferred<unknown>();
    const world = makeWorld({ create: () => created.promise });
    const onContinueInChat = vi.fn();
    world.options.onContinueInChat = onContinueInChat;
    const client = createVoiceSessionClient(world.options);

    const startP = client.startVoice(CHAT_ID);
    await vi.waitFor(() => expect(
      world.calls.some((call) => call.method === "POST" && call.path.endsWith("/voice/sessions")),
    ).toBe(true));

    client.continueInChat();
    expect(onContinueInChat).toHaveBeenCalledOnce();

    created.resolve(createdBody());
    await startP;

    expect(world.sockets).toHaveLength(0);
    await vi.waitFor(() => expect(deleteCalls(world)).toHaveLength(1));
    client.dispose();
  });

  it("a fresh startVoice after cancel starts a real session", async () => {
    const created = deferred<unknown>();
    let createCalls = 0;
    const world = makeWorld({
      create: () => {
        createCalls += 1;
        return createCalls === 1 ? created.promise : createdBody("ticket-9", 3);
      },
    });
    const client = createVoiceSessionClient(world.options);

    const startP = client.startVoice(CHAT_ID);
    await vi.waitFor(() => expect(createCalls).toBe(1));
    await client.end();
    created.resolve(createdBody());
    await startP;

    await client.startVoice(CHAT_ID);
    await vi.waitFor(() => expect(world.sockets).toHaveLength(1));
    expect(new URL(world.urls[0]!).searchParams.get("ticket")).toBe("ticket-9");
    client.dispose();
  });
});

describe("failure paths release the microphone and remote session", () => {
  it("createSession failure releases the prepared media", async () => {
    const world = makeWorld({
      create: () => new Response("upstream provider exploded", { status: 500 }),
    });
    const client = createVoiceSessionClient(world.options);
    await client.startVoice(CHAT_ID);
    expect(client.getSnapshot().phase).toBe("failed");
    await vi.waitFor(() => expect(world.media.releases).toBe(1));
    client.dispose();
  });

  it("a non-relayed transport grant releases media and deletes the minted session", async () => {
    const world = makeWorld({
      create: () => ({
        sessionId: SESSION_ID,
        chatId: CHAT_ID,
        limits: LIMITS,
        outcome: "created",
        status: "connecting",
        transport: {
          kind: "direct_webrtc",
          ephemeralCredential: "cred",
          expiresAt: "2026-01-01T00:00:00Z",
          epoch: 1,
          controlUrl: "https://gw.example/ctl",
          controlTicket: "ct",
        },
      }),
    });
    const client = createVoiceSessionClient(world.options);
    await client.startVoice(CHAT_ID);
    expect(client.getSnapshot()).toMatchObject({
      phase: "failed",
      error: { code: "unsupported_surface" },
    });
    await vi.waitFor(() => expect(world.media.releases).toBe(1));
    await vi.waitFor(() => expect(deleteCalls(world)).toHaveLength(1));
    client.dispose();
  });

  it("a media error mid-session stops capture, releases the mic, and deletes remote", async () => {
    const world = makeWorld({ turnMode: "push_to_talk" });
    const client = createVoiceSessionClient(world.options);
    await client.startVoice(CHAT_ID);
    const socket = world.sockets[0]!;
    socket.emitOpen();
    listen(world);
    client.controller()!.beginPushToTalk();
    expect(world.media.startedTurns).toHaveLength(1);

    world.media.callbacks!.onError!(voiceErrorForCode("input_unavailable"));
    expect(client.getSnapshot().phase).toBe("failed");
    await vi.waitFor(() => expect(world.media.releases).toBe(1));
    await vi.waitFor(() => expect(deleteCalls(world)).toHaveLength(1));
    // Stop capture runs before release so no late chunk escapes a torn-down session.
    expect(world.media.order.indexOf("stopCapture")).toBeGreaterThanOrEqual(0);
    expect(world.media.order.indexOf("stopCapture")).toBeLessThan(world.media.order.indexOf("release"));
    client.dispose();
  });

  it("a non-reconnectable socket close releases the mic and deletes remote", async () => {
    const world = makeWorld();
    const client = createVoiceSessionClient(world.options);
    await client.startVoice(CHAT_ID);
    const socket = world.sockets[0]!;
    socket.emitOpen();
    listen(world);

    socket.emitClose(1_008);
    expect(client.getSnapshot().phase).toBe("failed");
    await vi.waitFor(() => expect(world.media.releases).toBe(1));
    await vi.waitFor(() => expect(deleteCalls(world)).toHaveLength(1));
    client.dispose();
  });

  it("exhausting the reconnect ladder releases the mic and deletes remote", async () => {
    const world = makeWorld({ maxReconnectAttempts: 0 });
    const client = createVoiceSessionClient(world.options);
    await client.startVoice(CHAT_ID);
    const socket = world.sockets[0]!;
    socket.emitOpen();
    listen(world);

    socket.emitClose(1_006);
    expect(client.getSnapshot().phase).toBe("failed");
    await vi.waitFor(() => expect(world.media.releases).toBe(1));
    await vi.waitFor(() => expect(deleteCalls(world)).toHaveLength(1));
    client.dispose();
  });
});

describe("turn and create lifecycle", () => {
  it("rotates a hands-free capture id when the server finalizes the active turn", async () => {
    const world = makeWorld({ turnMode: "hands_free" });
    const client = createVoiceSessionClient(world.options);
    await client.startVoice(CHAT_ID);
    const socket = world.sockets[0]!;
    socket.emitOpen();
    listen(world);
    expect(world.media.startedTurns).toEqual(["vturn_tid-2"]);

    socket.emitFrame(2, {
      type: "transcript.final",
      turnId: "vturn_tid-2",
      finalityId: "vfinal_1",
      canonicalTurnId: "cturn_1",
      localOrder: 1,
      text: "hello",
    });

    expect(world.media.startedTurns).toEqual(["vturn_tid-2", "vturn_tid-3"]);
    expect(socket.sent.slice(-2)).toEqual([
      expect.objectContaining({ type: "capture.stop", turnId: "vturn_tid-2" }),
      expect.objectContaining({ type: "capture.start", turnId: "vturn_tid-3", mode: "hands_free" }),
    ]);
    client.dispose();
  });

  it("rotates a hands-free capture id when speech completes empty", async () => {
    const world = makeWorld({ turnMode: "hands_free" });
    const client = createVoiceSessionClient(world.options);
    await client.startVoice(CHAT_ID);
    const socket = world.sockets[0]!;
    socket.emitOpen();
    listen(world);

    socket.emitFrame(2, {
      type: "capture.completed",
      turnId: "vturn_tid-2",
      outcome: "empty",
    });

    expect(world.media.startedTurns).toEqual(["vturn_tid-2", "vturn_tid-3"]);
    client.dispose();
  });

  it("reuses one create request id across two lost responses and a user retry", async () => {
    let attempts = 0;
    const world = makeWorld({
      create: () => {
        attempts += 1;
        if (attempts <= 2) throw new TypeError("network response lost");
        return {
          ...createdBody("ticket-recovered", 3),
          outcome: "rotated_unconsumed",
        };
      },
    });
    const client = createVoiceSessionClient(world.options);
    await client.startVoice(CHAT_ID);
    expect(client.getSnapshot().phase).toBe("failed");

    client.retry();
    await vi.waitFor(() => expect(world.sockets).toHaveLength(1));

    const creates = world.calls.filter((call) => call.method === "POST" && call.path.endsWith("/voice/sessions"));
    expect(creates).toHaveLength(3);
    expect(new Set(creates.map((call) => (call.body as { clientRequestId: string }).clientRequestId)).size).toBe(1);
    expect(new URL(world.urls[0]!).searchParams.get("ticket")).toBe("ticket-recovered");
    expect(client.getSnapshot().phase).toBe("active");
    client.dispose();
  });

  it("replaces the unresolved create id after a definitive failure", async () => {
    let attempts = 0;
    const world = makeWorld({
      create: () => {
        attempts += 1;
        if (attempts <= 2) throw new TypeError("network response lost");
        if (attempts === 3) return new Response(JSON.stringify({
          error: voiceErrorForCode("chat_unavailable"),
        }), { status: 404, headers: { "content-type": "application/json" } });
        return createdBody("ticket-new", 1);
      },
    });
    const client = createVoiceSessionClient(world.options);
    await client.startVoice(CHAT_ID);
    client.retry();
    await vi.waitFor(() => expect(attempts).toBe(3));
    await vi.waitFor(() => expect(client.getSnapshot().phase).toBe("failed"));

    const firstCreates = world.calls.filter((call) => call.method === "POST" && call.path.endsWith("/voice/sessions"));
    const unresolvedId = (firstCreates[0]!.body as { clientRequestId: string }).clientRequestId;
    expect(firstCreates.every((call) => (call.body as { clientRequestId: string }).clientRequestId === unresolvedId)).toBe(true);

    await client.startVoice(CHAT_ID);
    const creates = world.calls.filter((call) => call.method === "POST" && call.path.endsWith("/voice/sessions"));
    expect((creates[3]!.body as { clientRequestId: string }).clientRequestId).not.toBe(unresolvedId);
    expect(client.getSnapshot().phase).toBe("active");
    client.dispose();
  });

  it("replaces an unresolved create id after an explicit end reset", async () => {
    let attempts = 0;
    const world = makeWorld({
      create: () => {
        attempts += 1;
        if (attempts <= 2) throw new TypeError("network response lost");
        return createdBody("ticket-after-reset", 1);
      },
    });
    const client = createVoiceSessionClient(world.options);
    await client.startVoice(CHAT_ID);
    const unresolvedId = (world.calls.find((call) => call.method === "POST")!.body as { clientRequestId: string }).clientRequestId;

    await client.end();
    await client.startVoice(CHAT_ID);

    const creates = world.calls.filter((call) => call.method === "POST" && call.path.endsWith("/voice/sessions"));
    expect(creates).toHaveLength(3);
    expect((creates[2]!.body as { clientRequestId: string }).clientRequestId).not.toBe(unresolvedId);
    expect(client.getSnapshot().phase).toBe("active");
    client.dispose();
  });
});

describe("active microphone loss", () => {
  it("stops capture, reports a recoverable input failure, and removes the ended listener", async () => {
    let endedListener: (() => void) | null = null;
    const track = {
      stop: vi.fn(),
      getSettings: () => ({ deviceId: "mic_default" }),
      addEventListener: vi.fn((_type: "ended", listener: () => void) => { endedListener = listener; }),
      removeEventListener: vi.fn(),
    };
    const captureStop = vi.fn(async () => undefined);
    const onError = vi.fn();
    const session = createWebVoiceMediaSession({
      audio: MONO,
      callbacks: { onAudioChunk: () => true, onSegmentPlayed: () => undefined, onError },
      mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) },
      captureFactory: () => ({ sampleRateHz: 16_000, stop: captureStop }),
      createAudioContext: () => null,
    });
    await session.prepare();
    session.startCapture({ turnId: "vturn_1" });

    endedListener!();
    await vi.waitFor(() => expect(captureStop).toHaveBeenCalledOnce());
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "input_unavailable",
      retryable: true,
      recovery: "choose_input",
    }));

    await session.release();
    expect(track.removeEventListener).toHaveBeenCalledWith("ended", endedListener);
    expect(captureStop).toHaveBeenCalledOnce();
  });
});

describe("remote session termination drives the public phase", () => {
  it("session.state ended moves the client to ended, releases media, and skips DELETE", async () => {
    const world = makeWorld();
    const client = createVoiceSessionClient(world.options);
    await client.startVoice(CHAT_ID);
    const socket = world.sockets[0]!;
    socket.emitOpen();
    listen(world);

    socket.emitFrame(2, { type: "session.state", state: "ended", reason: "shutdown" });
    expect(client.getSnapshot().phase).toBe("ended");
    expect(client.getSnapshot().voice?.state).toBe("ended");
    await vi.waitFor(() => expect(world.media.releases).toBe(1));
    // The server ended it — a client DELETE would be a redundant write.
    expect(deleteCalls(world)).toHaveLength(0);
    client.dispose();
  });

  it("session.state failed keeps reconnect-revival when the ladder allows it", async () => {
    const world = makeWorld();
    const client = createVoiceSessionClient(world.options);
    await client.startVoice(CHAT_ID);
    const socket = world.sockets[0]!;
    socket.emitOpen();
    listen(world);

    socket.emitFrame(2, { type: "session.state", state: "failed" });
    expect(client.getSnapshot().phase).toBe("reconnecting");
    world.runScheduled();
    await vi.waitFor(() => expect(world.sockets).toHaveLength(2));
    const replacement = world.sockets[1]!;
    replacement.emitOpen();
    replacement.emitFrame(1, { type: "session.resumed", state: "listening", reason: "restored" }, 2);
    expect(client.getSnapshot().phase).toBe("active");
    client.dispose();
  });

  it("session.state failed with an exhausted ladder fails the session", async () => {
    const world = makeWorld({ maxReconnectAttempts: 0 });
    const client = createVoiceSessionClient(world.options);
    await client.startVoice(CHAT_ID);
    const socket = world.sockets[0]!;
    socket.emitOpen();
    listen(world);

    socket.emitFrame(2, { type: "session.state", state: "failed" });
    expect(client.getSnapshot().phase).toBe("failed");
    await vi.waitFor(() => expect(world.media.releases).toBe(1));
    client.dispose();
  });
});

describe("client.ready wire ordering", () => {
  it("ready ships first on open; pre-open queued frames follow with monotonic sequence", async () => {
    const world = makeWorld();
    const client = createVoiceSessionClient(world.options);
    await client.startVoice(CHAT_ID);
    const socket = world.sockets[0]!;

    // Socket still CONNECTING: this control frame must queue behind the hello.
    client.controller()!.pause();
    socket.emitOpen();

    expect(socket.sent[0]).toMatchObject({ type: "client.ready", sequence: 1 });
    expect(socket.sent[1]).toMatchObject({ type: "session.pause", sequence: 2 });
    const sequences = socket.sent.map((frame) => frame.sequence as number);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    client.dispose();
  });

  it("VoiceTransport stamps sequence at write time so a connecting queue cannot invert order", () => {
    const sockets: FakeSocket[] = [];
    const transport = new VoiceTransport({
      sessionId: SESSION_ID,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      setIntervalFn: () => undefined,
      events: {
        onFrame: () => undefined,
        onOpen: () => {
          // Mirrors the client.ready hello: emitted before the queue drains.
          transport.send({ type: "session.resume" });
        },
      },
    });
    transport.connect({ url: "wss://gw/ws/voice", ticket: "t1", epoch: 1 });
    transport.send({ type: "session.pause" });
    transport.send({ type: "heartbeat", timestampMs: 7 });

    sockets[0]!.emitOpen();
    const sent = sockets[0]!.sent;
    expect(sent.map((frame) => frame.type)).toEqual([
      "session.resume",
      "session.pause",
      "heartbeat",
    ]);
    expect(sent.map((frame) => frame.sequence)).toEqual([1, 2, 3]);
    transport.dispose();
  });

  it("mixed text and binary queued pre-open flush in true FIFO order with monotonic sequence", () => {
    const sockets: FakeSocket[] = [];
    const transport = new VoiceTransport({
      sessionId: SESSION_ID,
      binaryAudio: true,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      setIntervalFn: () => undefined,
      events: {
        onFrame: () => undefined,
        onOpen: () => {
          transport.send({ type: "session.resume" });
        },
      },
    });
    transport.connect({ url: "wss://gw/ws/voice", ticket: "t1", epoch: 1 });
    transport.send({ type: "session.pause" });           // text, queued first
    transport.sendBinary(new Uint8Array([1, 2, 3]).buffer); // binary, queued second
    transport.send({ type: "session.resume" });          // text, queued third

    sockets[0]!.emitOpen();
    const socket = sockets[0]!;
    // Wire order must be ready(1) → pause(2) → binary → resume(4):
    // binary frames occupy a sequence position even though the header is
    // producer-encoded, so later JSON frames keep a strictly increasing wire seq.
    expect(socket.sent.map((frame) => frame.type)).toEqual([
      "session.resume",
      "session.pause",
      "__binary__",
      "session.resume",
    ]);
    const jsonSeqs = socket.sent
      .filter((frame) => frame.type !== "__binary__")
      .map((frame) => frame.sequence as number);
    expect(jsonSeqs).toEqual([1, 2, 4]);
    transport.dispose();
  });
});

describe("reconnect performs are serialized", () => {
  function loopHarness(options: { maxAttempts?: number } = {}) {
    const scheduled: ScheduledTask[] = [];
    const failures: { code: string }[] = [];
    const grants: { epoch: number }[] = [];
    const phases: string[] = [];
    const deferredGrant = deferred<unknown>();
    const reconnect = vi.fn((_chatId: string, _sessionId: string) => deferredGrant.promise);
    let disposed = false;
    let generation = 1;
    const loop = createReconnectLoop({
      isDisposed: () => disposed,
      generation: () => generation,
      session: () => ({ sessionId: SESSION_ID, chatId: CHAT_ID }),
      api: { reconnect },
      maxAttempts: options.maxAttempts ?? 4,
      setTimeoutFn: (callback) => {
        const task: ScheduledTask = { callback, cleared: false };
        scheduled.push(task);
        return task;
      },
      clearTimeoutFn: (timer) => {
        (timer as ScheduledTask).cleared = true;
      },
      setPhase: (phase) => phases.push(phase),
      failSession: (error) => failures.push(error),
      onGrant: (grantValue) => grants.push(grantValue as { epoch: number }),
    });
    return { loop, scheduled, failures, grants, phases, reconnect, deferredGrant,
      dispose: () => { disposed = true; },
      bumpGeneration: () => { generation += 1; } };
  }

  it("overlapping performs coalesce into one REST call and one grant application", async () => {
    const h = loopHarness();
    const first = h.loop.perform(true);
    const second = h.loop.perform(true);
    expect(h.reconnect).toHaveBeenCalledTimes(1);

    h.deferredGrant.resolve({ transport: grant("ticket-2", 2) });
    await first;
    await second;
    expect(h.grants).toHaveLength(1);
    expect(h.grants[0]).toMatchObject({ epoch: 2 });
  });

  it("a manual reconnect joins an in-flight scheduled attempt", async () => {
    const h = loopHarness();
    h.loop.schedule();
    expect(h.scheduled).toHaveLength(1);
    h.scheduled.splice(0).forEach((task) => task.callback());
    expect(h.reconnect).toHaveBeenCalledTimes(1);

    const manual = h.loop.perform(true);
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    h.deferredGrant.resolve({ transport: grant("ticket-2", 2) });
    await manual;
    expect(h.grants).toHaveLength(1);
  });

  it("a new perform after the in-flight one settles mints a fresh attempt", async () => {
    const h = loopHarness();
    const first = h.loop.perform(true);
    h.deferredGrant.resolve({ transport: grant("ticket-2", 2) });
    await first;

    const next = deferred<unknown>();
    h.reconnect.mockImplementation(() => next.promise);
    const second = h.loop.perform(false);
    expect(h.reconnect).toHaveBeenCalledTimes(2);
    next.resolve({ transport: grant("ticket-3", 3) });
    await second;
    expect(h.grants).toHaveLength(2);
    expect(h.grants[1]).toMatchObject({ epoch: 3 });
  });

  it("client-level overlapping reconnects mint exactly one epoch", async () => {
    const reconnect = deferred<unknown>();
    let reconnectCalls = 0;
    const world = makeWorld({
      reconnect: () => {
        reconnectCalls += 1;
        return reconnect.promise;
      },
    });
    const client = createVoiceSessionClient(world.options);
    await client.startVoice(CHAT_ID);
    const socket = world.sockets[0]!;
    socket.emitOpen();
    listen(world);

    socket.emitClose(1_006);
    world.runScheduled();
    const manual = client.reconnect();
    await vi.waitFor(() => expect(reconnectCalls).toBe(1));
    reconnect.resolve({
      sessionId: SESSION_ID,
      chatId: CHAT_ID,
      limits: LIMITS,
      transport: grant("ticket-2", 2),
    });
    await manual;
    expect(world.sockets).toHaveLength(2);
    expect(reconnectCalls).toBe(1);
    client.dispose();
  });
});

describe("replayed audio dedupe", () => {
  class FakeSource implements VoicePlaybackSource {
    onended: (() => void) | null = null;
    stopped = false;
    constructor(readonly buffer: VoicePcmBuffer) {}
    start(): void { /* started implicitly */ }
    stop(): void {
      this.stopped = true;
      this.onended?.();
    }
    finish(): void {
      this.onended?.();
    }
  }

  function mediaWorld(format?: AudioFormat) {
    const sources: FakeSource[] = [];
    const createdBuffers: { samples: Float32Array; sampleRateHz: number; channels: number; durationMs: number }[] = [];
    const context: VoiceAudioContextLike = {
      currentTimeSeconds: 0,
      sampleRateHz: 48_000,
      createPcmBuffer: ({ samples, sampleRateHz, channels }) => {
        const frames = samples.length / channels;
        const durationMs = (frames / sampleRateHz) * 1_000;
        createdBuffers.push({ samples, sampleRateHz, channels, durationMs });
        return { durationMs, native: samples };
      },
      createSource: (buffer) => {
        const source = new FakeSource(buffer);
        sources.push(source);
        return source;
      },
      close: vi.fn(async () => undefined),
    };
    const track = { stop: vi.fn(), getSettings: () => ({ deviceId: "mic_default" }) };
    const stream: VoiceMediaStreamLike = { getTracks: () => [track] };
    const devices: VoiceMediaDevicesLike = { getUserMedia: vi.fn(async () => stream) };
    const captureFactory: VoiceCaptureFactory = () => ({ sampleRateHz: 16_000, stop: vi.fn(async () => undefined) });
    const acks: VoicePlaybackAck[] = [];
    const session = createWebVoiceMediaSession({
      audio: format ?? MONO,
      callbacks: {
        onAudioChunk: () => true,
        onSegmentPlayed: (ack) => acks.push(ack),
      },
      mediaDevices: devices,
      createAudioContext: () => context,
      captureFactory,
    });
    return { session, sources, createdBuffers, acks, track, devices };
  }

  const pcmSegment = (samples: number): string => {
    const bytes = new Uint8Array(samples * 2);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  };

  it("a replayed segment while queued/playing is not scheduled twice", async () => {
    const w = mediaWorld();
    await w.session.prepare();
    w.session.enqueueSegment({ responseId: "vresp_1", segmentId: "vseg_1", data: pcmSegment(3_200) });
    w.session.enqueueSegment({ responseId: "vresp_1", segmentId: "vseg_1", data: pcmSegment(3_200) });
    expect(w.sources).toHaveLength(1);

    w.sources[0]!.finish();
    expect(w.acks).toEqual([
      { responseId: "vresp_1", segmentId: "vseg_1", deliveryRevision: 1, playedThroughMs: 200 },
    ]);
    // The replayed copy never becomes a second source and emits no second ack.
    expect(w.sources).toHaveLength(1);
    expect(w.acks).toHaveLength(1);
  });

  it("a replayed already-played segment re-acks without a second playout", async () => {
    const w = mediaWorld();
    await w.session.prepare();
    w.session.enqueueSegment({ responseId: "vresp_1", segmentId: "vseg_1", data: pcmSegment(3_200) });
    w.sources[0]!.finish();
    expect(w.acks).toHaveLength(1);

    // Post-reconnect at-least-once redelivery: ack bookkeeping completes but
    // the user never hears the segment twice.
    w.session.enqueueSegment({ responseId: "vresp_1", segmentId: "vseg_1", data: pcmSegment(3_200) });
    expect(w.sources).toHaveLength(1);
    expect(w.acks).toHaveLength(2);
    expect(w.acks[1]).toEqual(w.acks[0]);
  });

  it("an interrupted unplayed segment can be delivered again", async () => {
    const w = mediaWorld();
    await w.session.prepare();
    w.session.enqueueSegment({ responseId: "vresp_1", segmentId: "vseg_1", data: pcmSegment(3_200) });
    expect(w.sources).toHaveLength(1);
    w.session.interruptResponse("vresp_1");
    w.session.enqueueSegment({ responseId: "vresp_1", segmentId: "vseg_1", data: pcmSegment(3_200) });
    expect(w.sources).toHaveLength(2);
  });

  it("different segments of one response still play and ack normally", async () => {
    const w = mediaWorld();
    await w.session.prepare();
    w.session.enqueueSegment({ responseId: "vresp_1", segmentId: "vseg_1", data: pcmSegment(3_200) });
    w.session.enqueueSegment({ responseId: "vresp_1", segmentId: "vseg_2", data: pcmSegment(3_200) });
    expect(w.sources).toHaveLength(1);
    w.sources[0]!.finish();
    expect(w.sources).toHaveLength(2);
    w.sources[1]!.finish();
    expect(w.acks.map((ack) => ack.segmentId)).toEqual(["vseg_1", "vseg_2"]);
  });
});

describe("mono capture honesty", () => {
  it("advertises the effective mono format when stereo is configured", async () => {
    const stereo: AudioFormat = { codec: "pcm_s16le", sampleRateHz: 16_000, channels: 2, frameDurationMs: 20 };
    const world = makeWorld({
      audio: stereo,
      mediaCapabilities: {
        formats: [stereo, MONO],
        binaryAudio: false,
        maxAudioFrameBytes: 65_536,
        deviceChangeEvents: true,
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = createVoiceSessionClient(world.options);
    await client.startVoice(CHAT_ID);
    const socket = world.sockets[0]!;
    socket.emitOpen();

    const ready = socket.sent[0]!;
    expect((ready.audio as AudioFormat).channels).toBe(1);
    const capabilities = ready.capabilities as { formats: AudioFormat[] };
    expect(capabilities.formats.every((format) => format.channels === 1)).toBe(true);
    // The media factory receives the effective mono format too.
    expect(world.factoryAudio?.channels).toBe(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    client.dispose();
  });
});

describe("output audio format tolerance", () => {
  const OUTPUT_24K: VoiceOutputAudioFormat = { codec: "pcm_s16le", sampleRateHz: 24_000, channels: 1 };

  it("validates a declared output format and ignores malformed ones", () => {
    expect(voiceDeclaredAudioFormat(OUTPUT_24K)).toEqual(OUTPUT_24K);
    expect(voiceDeclaredAudioFormat({ codec: "weird" })).toBeUndefined();
    expect(voiceDeclaredAudioFormat({ codec: "pcm_s16le", sampleRateHz: 24_000, channels: 3 }))
      .toBeUndefined();
    expect(voiceDeclaredAudioFormat(undefined)).toBeUndefined();
    expect(voiceDeclaredAudioFormat(null)).toBeUndefined();
  });

  it("decodes a segment by its declared format instead of the negotiated input format", async () => {
    const w = mediaWorldFixture();
    await w.session.prepare();
    // 4_800 samples of s16: 200ms at 24kHz, 300ms at the negotiated 16kHz.
    w.session.enqueueSegment({
      responseId: "vresp_1",
      segmentId: "vseg_1",
      data: pcmSegmentFixture(4_800),
      format: OUTPUT_24K,
    });
    expect(w.createdBuffers).toHaveLength(1);
    expect(w.createdBuffers[0]).toMatchObject({ sampleRateHz: 24_000, channels: 1 });
    expect(w.createdBuffers[0]!.durationMs).toBeCloseTo(200, 5);
  });

  it("falls back to the negotiated format when the declared format is absent or invalid", async () => {
    const w = mediaWorldFixture();
    await w.session.prepare();
    w.session.enqueueSegment({
      responseId: "vresp_1",
      segmentId: "vseg_1",
      data: pcmSegmentFixture(4_800),
      format: { codec: "bogus", sampleRateHz: 99_999, channels: 9 } as unknown as VoiceOutputAudioFormat,
    });
    w.session.enqueueSegment({
      responseId: "vresp_1",
      segmentId: "vseg_2",
      data: pcmSegmentFixture(4_800),
    });
    expect(w.createdBuffers).toHaveLength(2);
    expect(w.createdBuffers[0]).toMatchObject({ sampleRateHz: 16_000, channels: 1 });
    expect(w.createdBuffers[1]).toMatchObject({ sampleRateHz: 16_000, channels: 1 });
    expect(w.createdBuffers[0]!.durationMs).toBeCloseTo(300, 5);
  });

  it("de-interleaves a declared stereo format into planar playback channels", async () => {
    const w = mediaWorldFixture();
    await w.session.prepare();
    // Stereo s16 interleaved: L=0.5, R=-0.5 at 16kHz, 160 frames.
    const frames = 160;
    const interleaved = new Int16Array(frames * 2);
    for (let i = 0; i < frames; i += 1) {
      interleaved[i * 2] = 16_384;
      interleaved[i * 2 + 1] = -16_384;
    }
    const data = btoa(String.fromCharCode(...new Uint8Array(interleaved.buffer)));
    w.session.enqueueSegment({
      responseId: "vresp_1",
      segmentId: "vseg_1",
      data,
      format: { codec: "pcm_s16le", sampleRateHz: 16_000, channels: 2 },
    });
    expect(w.createdBuffers).toHaveLength(1);
    const buffer = w.createdBuffers[0]!;
    expect(buffer.channels).toBe(2);
    // Planar layout: first half is channel 0 (+0.5), second half channel 1 (-0.5).
    expect(buffer.samples[0]).toBeCloseTo(0.5, 1);
    expect(buffer.samples[frames]).toBeCloseTo(-0.5, 1);
    expect(buffer.durationMs).toBeCloseTo(10, 5);
  });

  it("a frame-declared `format` reaches playback and wins over the capability default", async () => {
    const world = makeWorld({
      capability: () => ({ ...CAPABILITY, outputAudio: OUTPUT_24K }),
    });
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
      data: "QUJD",
      format: { codec: "pcm_f32le", sampleRateHz: 32_000, channels: 1 },
    });
    socket.emitFrame(4, {
      type: "response.audio",
      responseId: "vresp_1",
      segmentId: "vseg_2",
      startMs: 0,
      data: "QUJD",
    });
    expect(world.media.enqueued).toHaveLength(2);
    // The per-frame declaration wins for that segment...
    expect(world.media.enqueued[0]!.format)
      .toEqual({ codec: "pcm_f32le", sampleRateHz: 32_000, channels: 1 });
    // ...while a bare frame uses the capability-declared outputAudio fallback.
    expect(world.media.enqueued[1]!.format).toEqual(OUTPUT_24K);
    client.dispose();
  });

  it("a frame without `format` and no capability outputAudio decodes with the negotiated format", async () => {
    const world = makeWorld();
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
      data: "QUJD",
    });
    expect(world.media.enqueued).toHaveLength(1);
    expect(world.media.enqueued[0]!.format).toBeUndefined();
    client.dispose();
  });
});

// Local copies so the format-tolerance suite stays independent of the dedupe
// suite's fixture internals.
function pcmSegmentFixture(samples: number): string {
  const bytes = new Uint8Array(samples * 2);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function mediaWorldFixture(format?: AudioFormat) {
  const sources: { finish(): void }[] = [];
  const createdBuffers: { samples: Float32Array; sampleRateHz: number; channels: number; durationMs: number }[] = [];
  const context: VoiceAudioContextLike = {
    currentTimeSeconds: 0,
    sampleRateHz: 48_000,
    createPcmBuffer: ({ samples, sampleRateHz, channels }) => {
      const frames = samples.length / channels;
      const durationMs = (frames / sampleRateHz) * 1_000;
      createdBuffers.push({ samples, sampleRateHz, channels, durationMs });
      return { durationMs, native: samples };
    },
    createSource: (buffer) => {
      const source = {
        onended: null as (() => void) | null,
        start: () => undefined,
        stop: () => undefined,
      };
      sources.push({ finish: () => source.onended?.() });
      return source;
    },
    close: vi.fn(async () => undefined),
  };
  const stream: VoiceMediaStreamLike = { getTracks: () => [{ stop: vi.fn() }] };
  const devices: VoiceMediaDevicesLike = { getUserMedia: vi.fn(async () => stream) };
  const session = createWebVoiceMediaSession({
    audio: format ?? MONO,
    callbacks: { onAudioChunk: () => true, onSegmentPlayed: () => undefined },
    mediaDevices: devices,
    createAudioContext: () => context,
    captureFactory: () => ({ sampleRateHz: 16_000, stop: vi.fn(async () => undefined) }),
  });
  return { session, sources, createdBuffers };
}
