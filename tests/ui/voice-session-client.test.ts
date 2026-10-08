// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  createVoiceSessionClient,
  useVoiceSession,
  type VoiceSessionClientOptions,
} from "../../packages/ui/src/voice-session/use-voice-session";
import { VoiceMediaError, type VoiceMediaSession, type VoiceMediaCallbacks } from "../../packages/ui/src/voice-session/media-session";
import { createVoiceSessionApi, voiceErrorForCode } from "../../packages/ui/src/voice-session/session-api";
import type { VoiceTransportSocket } from "../../packages/ui/src/voice-session/transport";

const CHAT_ID = "chat_1";
const SESSION_ID = "vs_1";
const WS_URL = `wss://gw.example/ws/chats/${CHAT_ID}/voice/${SESSION_ID}`;

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

it("budgets slow voice admission and reconnect separately from prompt cleanup", async () => {
  const timeout = vi.fn((_ms: number) => new AbortController().signal);
  const api = createVoiceSessionApi({ baseUrl: "https://runtime.test", makeTimeoutSignal: timeout,
    fetcher: vi.fn(async (url, init) => new Response(JSON.stringify(
      String(url).endsWith("capabilities") ? CAPABILITY
        : String(url).endsWith("reconnect") ? { sessionId: SESSION_ID, chatId: CHAT_ID, limits: LIMITS, transport: grant("ticket-new", 2) }
          : init?.method === "DELETE" ? {} : createdBody(),
    ))),
  });
  await api.getCapabilities(CHAT_ID);
  await api.createSession(CHAT_ID, { clientRequestId: "request-slow", turnMode: "hands_free", memoryMode: "ordinary",
    selection: { instanceId: "codex_default", model: "real-model" }, interactionMode: "default", permissionMode: "supervised" });
  await api.reconnect(CHAT_ID, SESSION_ID);
  await api.deleteSession(CHAT_ID, SESSION_ID);
  expect(timeout.mock.calls.map(call => call[0])).toEqual([30_000, 30_000, 30_000, 10_000]);
});

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
    this.sent.push(JSON.parse(String(data)) as Record<string, unknown>);
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
  enqueued: { responseId: string; segmentId: string; data: string }[];
  interrupts: string[];
  interruptBoundary: number | null;
  releases: number;
  switches: (string | undefined)[];
  outputs: (string | null)[];
  switchImpl: (deviceId?: string) => Promise<void>;
  outputImpl: (deviceId: string | null) => Promise<"applied" | "unsupported" | "unavailable">;
}

function fakeMedia(prepareImpl?: () => Promise<void>): FakeMedia {
  const media: FakeMedia = {
    callbacks: null,
    startedTurns: [],
    stops: 0,
    playbackStops: 0,
    enqueued: [],
    interrupts: [],
    interruptBoundary: 123,
    releases: 0,
    switches: [],
    outputs: [],
    switchImpl: async () => undefined,
    outputImpl: async () => "applied",
    session: {
      supported: true,
      prepare: vi.fn(prepareImpl ?? (async () => undefined)),
      switchInputDevice: vi.fn(async (deviceId?: string) => {
        media.switches.push(deviceId);
        await media.switchImpl(deviceId);
      }),
      setOutputDevice: vi.fn(async (deviceId: string | null) => {
        media.outputs.push(deviceId);
        return media.outputImpl(deviceId);
      }),
      startCapture: vi.fn(({ turnId }: { turnId: string }) => {
        media.startedTurns.push(turnId);
        return true;
      }),
      stopCapture: vi.fn(() => {
        media.stops += 1;
      }),
      enqueueSegment: vi.fn((input: { responseId: string; segmentId: string; data: string }) => {
        media.enqueued.push(input);
      }),
      interruptResponse: vi.fn((responseId: string) => {
        media.interrupts.push(responseId);
        return media.interruptBoundary;
      }),
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

interface World {
  options: VoiceSessionClientOptions;
  media: FakeMedia;
  sockets: FakeSocket[];
  urls: string[];
  calls: { method: string; path: string; body: unknown }[];
  scheduled: (() => void)[];
  heartbeatTicks: (() => void)[];
  setNow(value: number): void;
  respond(path: string, body: () => unknown): void;
}

function makeWorld(overrides: {
  create?: () => unknown;
  capability?: () => unknown;
  reconnect?: () => unknown;
  prepare?: () => Promise<void>;
  turnMode?: "hands_free" | "push_to_talk";
} = {}): World {
  const media = fakeMedia(overrides.prepare);
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const calls: World["calls"] = [];
  const scheduled: (() => void)[] = [];
  const heartbeatTicks: (() => void)[] = [];
  let now = 10_000;
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
    const body = route();
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  let counter = 0;
  const options: VoiceSessionClientOptions = {
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
    mediaFactory: ({ callbacks }) => {
      media.callbacks = callbacks;
      return media.session;
    },
    createId: (prefix) => `${prefix}tid-${(counter += 1)}`,
    now: () => now,
    setTimeoutFn: (callback) => {
      scheduled.push(callback);
      return callback;
    },
    clearTimeoutFn: () => undefined,
    setIntervalFn: (callback) => {
      heartbeatTicks.push(callback);
      return callback;
    },
    clearIntervalFn: () => undefined,
    makeTimeoutSignal: () => new AbortController().signal,
    heartbeatIntervalMs: 250,
    heartbeatTimeoutMs: 500,
  };
  return {
    options,
    media,
    sockets,
    urls,
    calls,
    scheduled,
    heartbeatTicks,
    setNow: (value) => { now = value; },
    respond: (path, body) => routes.set(path, body),
  };
}

async function started(world: World, chatId = CHAT_ID) {
  const client = createVoiceSessionClient(world.options);
  await client.startVoice(chatId);
  return client;
}

function listen(world: World, socketIndex = 0, epoch = 1) {
  world.sockets[socketIndex]!.emitFrame(1, { type: "session.state", state: "listening" }, epoch);
}

describe("createVoiceSessionClient", () => {
  it("runs capabilities → permission → create → connect and opens hands-free capture on listening", async () => {
    const world = makeWorld({ turnMode: "hands_free" });
    const rationale = vi.fn();
    world.options.onPermissionRationale = rationale;
    const client = await started(world);

    expect(world.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET /api/chats/${CHAT_ID}/voice/capabilities`,
      `POST /api/chats/${CHAT_ID}/voice/sessions`,
    ]);
    // The rationale hook is handed to media.prepare so the UI can explain the mic prompt first.
    expect(mediaPrepareOf(world)).toHaveBeenCalledOnce();
    expect(mediaPrepareOf(world)).toHaveBeenCalledWith({ onRationale: rationale });
    const createBody = world.calls[1]!.body as Record<string, unknown>;
    expect(createBody).toMatchObject({
      turnMode: "hands_free",
      memoryMode: "session_only",
      interactionMode: "default",
      permissionMode: "supervised",
    });
    expect(String(createBody.clientRequestId)).toMatch(/^req_[A-Za-z0-9_-]+$/);

    // Ticket lands on the voice socket path as ?ticket= — never a bearer token.
    expect(world.urls).toHaveLength(1);
    const socketUrl = new URL(world.urls[0]!);
    expect(socketUrl.pathname).toBe(`/ws/chats/${CHAT_ID}/voice/${SESSION_ID}`);
    expect(socketUrl.searchParams.get("ticket")).toBe("ticket-1");

    const socket = world.sockets[0]!;
    socket.emitOpen();
    expect(socket.sent[0]).toMatchObject({
      type: "client.ready",
      contractVersion: 1,
      sessionId: SESSION_ID,
      epoch: 1,
      sequence: 1,
    });
    expect((socket.sent[0] as { capabilities: { binaryAudio: boolean } }).capabilities.binaryAudio).toBe(false);

    listen(world);
    const snapshot = client.getSnapshot();
    expect(snapshot.phase).toBe("active");
    expect(snapshot.voice?.state).toBe("listening");
    // Hands-free: the client owns capture while the session is live.
    expect(world.media.startedTurns).toEqual(["vturn_tid-2"]);
    expect(socket.sent[1]).toMatchObject({ type: "capture.start", turnId: "vturn_tid-2", mode: "hands_free", sequence: 2 });

    client.dispose();
  });

  it("drives push-to-talk purely through controller commands", async () => {
    const world = makeWorld({ turnMode: "push_to_talk" });
    const client = await started(world);
    const socket = world.sockets[0]!;
    socket.emitOpen();
    listen(world);
    // No automatic capture in push_to_talk.
    expect(world.media.startedTurns).toHaveLength(0);

    const controller = client.controller()!;
    controller.beginPushToTalk();
    expect(world.media.startedTurns).toEqual(["vturn_tid-2"]);
    expect(socket.sent.at(-1)).toMatchObject({ type: "capture.start", turnId: "vturn_tid-2", mode: "push_to_talk" });

    // Audio chunks produced by media become capture.audio frames.
    world.media.callbacks!.onAudioChunk({ turnId: "vturn_tid-2", timestampMs: 5, data: "QUJD" });
    expect(socket.sent.at(-1)).toMatchObject({ type: "capture.audio", turnId: "vturn_tid-2", data: "QUJD" });

    controller.endPushToTalk();
    expect(world.media.stops).toBe(1);
    expect(socket.sent.at(-1)).toMatchObject({ type: "capture.stop", turnId: "vturn_tid-2" });
    client.dispose();
  });

  it("requires an explicit reconnect() after an existing_consumed create response", async () => {
    const world = makeWorld({
      create: () => ({
        sessionId: SESSION_ID,
        chatId: CHAT_ID,
        limits: LIMITS,
        outcome: "existing_consumed",
        status: "listening",
        reconnectRequired: true,
      }),
      reconnect: () => ({
        sessionId: SESSION_ID,
        chatId: CHAT_ID,
        limits: LIMITS,
        transport: grant("ticket-rotated", 2),
      }),
    });
    const client = await started(world);

    const snapshot = client.getSnapshot();
    expect(snapshot.phase).toBe("awaiting_reconnect");
    expect(snapshot.reconnectStatus).toBe("listening");
    expect(snapshot.voice).toMatchObject({
      state: "failed",
      error: { code: "session_conflict", recovery: "retry_connection", retryable: true },
    });
    // No socket may be opened without the explicit authenticated reconnect.
    expect(world.sockets).toHaveLength(0);

    await client.reconnect();
    await vi.waitFor(() => expect(world.sockets).toHaveLength(1));
    expect(world.calls.map((call) => `${call.method} ${call.path}`)).toContain(
      `POST /api/chats/${CHAT_ID}/voice/sessions/${SESSION_ID}/reconnect`,
    );
    expect(new URL(world.urls[0]!).searchParams.get("ticket")).toBe("ticket-rotated");

    const socket = world.sockets[0]!;
    socket.emitOpen();
    expect(socket.sent[0]).toMatchObject({ type: "client.ready", epoch: 2, sequence: 1 });
    socket.emitFrame(1, { type: "session.resumed", state: "listening", reason: "restored" }, 2);
    expect(client.getSnapshot().phase).toBe("active");
    expect(client.getSnapshot().voice).toMatchObject({ epoch: 2, state: "listening" });
    client.dispose();
  });

  it("routes playback acks through controller validation to playback.segment_played frames", async () => {
    const world = makeWorld();
    const client = await started(world);
    const socket = world.sockets[0]!;
    socket.emitOpen();
    listen(world);
    socket.emitFrame(2, { type: "response.started", responseId: "vresp_1", runId: "run_1" });
    socket.emitFrame(3, { type: "response.audio", responseId: "vresp_1", segmentId: "vseg_1", startMs: 0, data: "QUJD" });
    expect(world.media.enqueued).toEqual([{ responseId: "vresp_1", segmentId: "vseg_1", data: "QUJD" }]);

    // An ack for a segment the server never sent is refused by the controller.
    world.media.callbacks!.onSegmentPlayed({
      responseId: "vresp_1", segmentId: "vseg_forged", deliveryRevision: 1, playedThroughMs: 400,
    });
    expect(socket.sent.some((frame) => frame.type === "playback.segment_played")).toBe(false);

    world.media.callbacks!.onSegmentPlayed({
      responseId: "vresp_1", segmentId: "vseg_1", deliveryRevision: 1, playedThroughMs: 200,
    });
    const ackFrame = socket.sent.find((frame) => frame.type === "playback.segment_played");
    expect(ackFrame).toMatchObject({
      responseId: "vresp_1", segmentId: "vseg_1", deliveryRevision: 1, playedThroughMs: 200,
    });
    client.dispose();
  });

  it("reports the media-measured boundary, not the stale ack floor, on response.interrupt", async () => {
    const world = makeWorld();
    const client = await started(world);
    const socket = world.sockets[0]!;
    socket.emitOpen();
    listen(world);
    socket.emitFrame(2, { type: "response.started", responseId: "vresp_1", runId: "run_1" });
    socket.emitFrame(3, { type: "session.state", state: "speaking" });

    client.controller()!.stopSpeaking();
    const interrupt = socket.sent.find((frame) => frame.type === "response.interrupt");
    expect(world.media.interrupts).toEqual(["vresp_1"]);
    // Fake media reports 123ms actually played; the controller's ack floor was 0.
    expect(interrupt).toMatchObject({ responseId: "vresp_1", playedThroughMs: 123 });
    client.dispose();
  });

  it("stops playout locally when the server reports response.interrupted", async () => {
    const world = makeWorld();
    const client = await started(world);
    const socket = world.sockets[0]!;
    socket.emitOpen();
    listen(world);
    socket.emitFrame(2, { type: "response.started", responseId: "vresp_1", runId: "run_1" });
    socket.emitFrame(3, { type: "response.interrupted", responseId: "vresp_1", effectiveThroughMs: 90 });
    expect(world.media.interrupts).toEqual(["vresp_1"]);
    // Server-side interrupt carries no extra client response.interrupt echo.
    expect(socket.sent.some((frame) => frame.type === "response.interrupt")).toBe(false);
    client.dispose();
  });

  it("marks the session reconnecting on heartbeat timeout and recovers via REST reconnect", async () => {
    const world = makeWorld();
    const client = await started(world);
    const socket = world.sockets[0]!;
    socket.emitOpen();
    listen(world);

    // Silence beyond the heartbeat window kills the socket without a close frame.
    world.setNow(11_000);
    world.heartbeatTicks[0]!();
    expect(socket.closedWith?.code).toBe(1_001);
    expect(client.getSnapshot().phase).toBe("reconnecting");
    expect(client.getSnapshot().voice?.state).toBe("reconnecting");

    // The scheduled reconnect mints a fresh ticket/epoch through REST.
    expect(world.scheduled).toHaveLength(1);
    scheduledRun(world);
    await vi.waitFor(() => expect(world.sockets).toHaveLength(2));
    expect(new URL(world.urls[1]!).searchParams.get("ticket")).toBe("ticket-2");

    const replacement = world.sockets[1]!;
    replacement.emitOpen();
    replacement.emitFrame(1, { type: "session.resumed", state: "listening", reason: "restored" }, 2);
    expect(client.getSnapshot().voice).toMatchObject({ epoch: 2, state: "listening" });
    expect(client.getSnapshot().phase).toBe("active");
    client.dispose();
  });

  it("maps media permission failure to a safe session error without calling session routes", async () => {
    const world = makeWorld({
      prepare: async () => {
        throw new VoiceMediaError(voiceErrorForCode("permission_denied"));
      },
    });
    const client = await started(world);
    expect(client.getSnapshot()).toMatchObject({
      phase: "failed",
      error: { code: "permission_denied", recovery: "request_permission", retryable: true },
    });
    expect(world.calls.map((call) => call.path)).not.toContain(`/api/chats/${CHAT_ID}/voice/sessions`);
    expect(world.sockets).toHaveLength(0);
    client.dispose();
  });

  it("surfaces safe API error codes without leaking server details", async () => {
    const world = makeWorld({
      create: () => new Response(JSON.stringify({
        error: { code: "session_limit_reached", retryable: false, recovery: "start_new_session" },
      }), { status: 429 }),
    });
    const client = await started(world);
    expect(client.getSnapshot()).toMatchObject({
      phase: "failed",
      error: { code: "session_limit_reached", recovery: "start_new_session" },
    });
    client.dispose();

    const opaque = makeWorld({ create: () => new Response("upstream provider exploded", { status: 500 }) });
    const opaqueClient = await started(opaque);
    expect(opaqueClient.getSnapshot().error?.code).toBe("provider_unavailable");
    expect(JSON.stringify(opaqueClient.getSnapshot().error)).not.toContain("exploded");
    opaqueClient.dispose();
  });

  it("end() sends session.end, closes the socket, deletes the session, and releases media", async () => {
    const world = makeWorld();
    const client = await started(world);
    const socket = world.sockets[0]!;
    socket.emitOpen();
    listen(world);

    await client.end();
    expect(socket.sent.at(-1)).toMatchObject({ type: "session.end", reason: "user" });
    expect(socket.closedWith?.code).toBe(1_000);
    expect(client.getSnapshot().phase).toBe("ended");
    expect(client.getSnapshot().voice?.state).toBe("ended");
    await vi.waitFor(() => expect(
      world.calls.some((call) => call.method === "DELETE" && call.path === `/api/chats/${CHAT_ID}/voice/sessions/${SESSION_ID}`),
    ).toBe(true));
    await vi.waitFor(() => expect(world.media.releases).toBeGreaterThan(0));
  });

  it("dispose() tears down socket, media, and controller idempotently", async () => {
    const world = makeWorld();
    const client = await started(world);
    const socket = world.sockets[0]!;
    socket.emitOpen();
    listen(world);
    const controller = client.controller()!;

    client.dispose();
    client.dispose();
    expect(socket.closedWith?.code).toBe(1_000);
    expect(controller.getState().state).toBe("ended");
    await vi.waitFor(() => expect(world.media.releases).toBe(1));
    await vi.waitFor(() => expect(
      world.calls.some((call) => call.method === "DELETE"),
    ).toBe(true));
    // A late socket close after dispose reports nothing and changes nothing.
    socket.emitClose(1_006);
    expect(client.getSnapshot().phase).toBe("active");
  });

  it("fails terminally on a policy close and reschedules reconnects on retryable failure", async () => {
    const world = makeWorld();
    const client = await started(world);
    const socket = world.sockets[0]!;
    socket.emitOpen();
    listen(world);

    socket.emitClose(1_008);
    expect(client.getSnapshot()).toMatchObject({
      phase: "failed",
      voice: { state: "failed", error: { code: "connection_lost", retryable: false } },
    });
    client.dispose();

    // Retryable reconnect failure defers to the bounded backoff schedule.
    let reconnectCalls = 0;
    const flaky = makeWorld({
      reconnect: () => {
        reconnectCalls += 1;
        if (reconnectCalls === 1) {
          return new Response("gateway restarting", { status: 503 });
        }
        return { sessionId: SESSION_ID, chatId: CHAT_ID, limits: LIMITS, transport: grant("ticket-3", 2) };
      },
    });
    const flakyClient = await started(flaky);
    const flakySocket = flaky.sockets[0]!;
    flakySocket.emitOpen();
    listen(flaky);
    flakySocket.emitClose(1_006);
    expect(flakyClient.getSnapshot().phase).toBe("reconnecting");
    scheduledRun(flaky);
    await vi.waitFor(() => expect(reconnectCalls).toBe(1));
    // 503 is retryable: another attempt is scheduled rather than failing.
    await vi.waitFor(() => expect(flaky.scheduled.length).toBeGreaterThan(0));
    scheduledRun(flaky);
    await vi.waitFor(() => expect(flaky.sockets).toHaveLength(2));
    flaky.sockets[1]!.emitOpen();
    flaky.sockets[1]!.emitFrame(1, { type: "session.resumed", state: "listening", reason: "restored" }, 2);
    expect(flakyClient.getSnapshot().phase).toBe("active");
    flakyClient.dispose();
  });

  it("useVoiceSession disposes the client on unmount", async () => {
    const world = makeWorld();
    const { result, unmount } = renderHook(() => useVoiceSession(world.options));
    await act(() => result.current.startVoice(CHAT_ID));
    act(() => {
      world.sockets[0]!.emitOpen();
      listen(world);
    });
    expect(result.current.snapshot.voice?.state).toBe("listening");

    const controller = result.current.controller!;
    unmount();
    expect(controller.getState().state).toBe("ended");
    expect(world.sockets[0]!.closedWith?.code).toBe(1_000);
    await vi.waitFor(() => expect(world.media.releases).toBe(1));
    await vi.waitFor(() => expect(world.calls.some((call) => call.method === "DELETE")).toBe(true));
  });

  it("continue_in_chat tears down quietly and notifies the host surface", async () => {
    const world = makeWorld();
    const onContinueInChat = vi.fn();
    world.options.onContinueInChat = onContinueInChat;
    const client = await started(world);
    const socket = world.sockets[0]!;
    socket.emitOpen();
    listen(world);

    client.controller()!.continueInChat();
    expect(onContinueInChat).toHaveBeenCalledOnce();
    expect(socket.closedWith?.code).toBe(1_000);
    await vi.waitFor(() => expect(world.media.releases).toBe(1));
  });
});

describe("voice session device selection", () => {
  afterEach(() => {
    unstubMediaDevices();
  });

  it("passes the configured input device into media.prepare", async () => {
    const world = makeWorld();
    world.options.request.inputDeviceId = "mic_x";
    const client = await started(world);
    expect(mediaPrepareOf(world)).toHaveBeenCalledWith(
      expect.objectContaining({ inputDeviceId: "mic_x" }),
    );
    client.dispose();
  });

  it("falls back to the default mic when the persisted device is gone", async () => {
    const world = makeWorld();
    world.options.request.inputDeviceId = "mic_gone";
    stubMediaDevices([{ deviceId: "mic_a", kind: "audioinput", label: "Mic A" }]);
    const client = await started(world);
    // The stale id was dropped pre-flight rather than hard-failing getUserMedia.
    expect(world.options.request.inputDeviceId).toBeUndefined();
    expect(mediaPrepareOf(world)).toHaveBeenCalledWith(
      expect.objectContaining({ inputDeviceId: undefined }),
    );
    client.dispose();
  });

  it("keeps the persisted device when enumeration is unavailable", async () => {
    const world = makeWorld();
    world.options.request.inputDeviceId = "mic_x"; // jsdom has no mediaDevices
    const client = await started(world);
    expect(mediaPrepareOf(world)).toHaveBeenCalledWith(
      expect.objectContaining({ inputDeviceId: "mic_x" }),
    );
    client.dispose();
  });

  it("lists bounded truthful audio devices and reports null when unsupported", async () => {
    const world = makeWorld();
    const client = await started(world);
    await expect(client.listDevices()).resolves.toBeNull();

    const inputs = Array.from({ length: 40 }, (_, index) => ({
      deviceId: `mic_${index}`, kind: "audioinput", label: index === 3 ? "" : `Mic ${index}`,
    }));
    stubMediaDevices([
      ...inputs,
      { deviceId: "spk_1", kind: "audiooutput", label: "Speaker" },
      { deviceId: "cam_1", kind: "videoinput", label: "Camera" },
      { deviceId: "", kind: "audioinput", label: "empty id" },
    ]);
    const devices = await client.listDevices();
    expect(devices).not.toBeNull();
    // Bounded at 32 inputs; empty pre-permission labels stay empty (never invented).
    expect(devices!.filter((device) => device.kind === "audioinput")).toHaveLength(32);
    expect(devices!.filter((device) => device.kind === "audiooutput")).toEqual([
      { deviceId: "spk_1", kind: "audiooutput", label: "Speaker" },
    ]);
    expect(devices!.find((device) => device.deviceId === "mic_3")?.label).toBe("");
    client.dispose();
  });

  it("rejects malformed device ids without storing them", async () => {
    const world = makeWorld();
    const client = await started(world);
    await expect(client.setInputDevice("bad id!")).resolves.toBe(false);
    await expect(client.setOutputDevice("bad id!")).resolves.toBe("unavailable");
    expect(world.options.request.inputDeviceId).toBeUndefined();
    expect(world.options.request.outputDeviceId).toBeUndefined();
    client.dispose();
  });

  it("hot-swaps a live capture turn and announces device.changed", async () => {
    const world = makeWorld({ turnMode: "hands_free" });
    const client = await started(world);
    const socket = world.sockets[0]!;
    socket.emitOpen();
    listen(world);
    expect(world.media.startedTurns).toEqual(["vturn_tid-2"]);

    await expect(client.setInputDevice("mic_b")).resolves.toBe(true);
    expect(world.media.switches).toEqual(["mic_b"]);
    expect(world.options.request.inputDeviceId).toBe("mic_b");
    const types = socket.sent.map((frame) => frame.type);
    // The interrupted turn closed honestly, the swap was announced, and
    // hands-free capture resumed on the new device as a fresh turn.
    expect(types).toContain("capture.stop");
    expect(types).toContain("device.changed");
    expect(socket.sent.at(-1)).toMatchObject({ type: "capture.start", turnId: "vturn_tid-3" });
    expect(world.media.startedTurns).toEqual(["vturn_tid-2", "vturn_tid-3"]);
    client.dispose();
  });

  it("ignores a superseded input failure after the newer microphone succeeds", async () => {
    const world = makeWorld({ turnMode: "hands_free" });
    const client = await started(world);
    world.sockets[0]!.emitOpen();
    listen(world);
    let rejectOld!: (error: Error) => void;
    world.media.switchImpl = device => device === "mic_a"
      ? new Promise<void>((_resolve, reject) => { rejectOld = reject; })
      : Promise.resolve();
    const old = client.setInputDevice("mic_a");
    await expect(client.setInputDevice("mic_b")).resolves.toBe(true);
    rejectOld(new Error("stale acquisition"));
    await expect(old).resolves.toBe(false);
    expect(client.getSnapshot()).toMatchObject({ phase: "active", error: null });
    expect(world.options.request.inputDeviceId).toBe("mic_b");
    expect(world.media.releases).toBe(0);
    expect(world.sockets[0]!.sent.filter(frame => frame.type === "device.changed"))
      .toEqual([expect.objectContaining({ inputDeviceId: "mic_b" })]);
    client.dispose();
  });

  it("routes output selection through the media session and stores it for next start", async () => {
    const world = makeWorld();
    const client = await started(world);
    await expect(client.setOutputDevice("spk_a")).resolves.toBe("applied");
    expect(world.media.outputs).toEqual(["spk_a"]);
    expect(world.options.request.outputDeviceId).toBe("spk_a");

    // A session without hot-swap support stores the selection truthfully.
    const idleWorld = makeWorld();
    const idleClient = createVoiceSessionClient(idleWorld.options);
    await expect(idleClient.setOutputDevice("spk_b")).resolves.toBe("applied");
    expect(idleWorld.options.request.outputDeviceId).toBe("spk_b");

    world.media.outputImpl = async () => "unsupported";
    await expect(client.setOutputDevice("spk_c")).resolves.toBe("unsupported");
    client.dispose();
    idleClient.dispose();
  });

  it("applies the persisted output device to a fresh session prepare", async () => {
    const world = makeWorld();
    world.options.request.outputDeviceId = "spk_a";
    const client = await started(world);
    expect(world.media.outputs).toEqual(["spk_a"]);
    client.dispose();
  });

  it("waits for persisted output routing before creating the remote session", async () => {
    const world = makeWorld();
    world.options.request.outputDeviceId = "spk_a";
    let resolveOutput!: () => void;
    world.media.outputImpl = () => new Promise<"applied">((resolve) => {
      resolveOutput = () => resolve("applied");
    });
    const client = createVoiceSessionClient(world.options);
    const starting = client.startVoice(CHAT_ID);
    await vi.waitFor(() => expect(world.media.outputs).toEqual(["spk_a"]));
    expect(world.calls.some((call) => call.method === "POST")).toBe(false);
    resolveOutput();
    await starting;
    expect(world.calls.some((call) => call.method === "POST")).toBe(true);
    client.dispose();
  });

  it("fails truthfully when an explicit persisted output route is unsupported", async () => {
    const world = makeWorld();
    world.options.request.outputDeviceId = "spk_a";
    world.media.outputImpl = async () => "unsupported";
    const client = createVoiceSessionClient(world.options);
    await client.startVoice(CHAT_ID);
    expect(client.getSnapshot()).toMatchObject({
      phase: "failed",
      error: { code: "output_unavailable" },
    });
    expect(world.calls.some((call) => call.method === "POST")).toBe(false);
    client.dispose();
  });

  it("fails the session truthfully when a live input switch fails", async () => {
    const world = makeWorld({ turnMode: "hands_free" });
    const client = await started(world);
    world.sockets[0]!.emitOpen();
    listen(world);
    world.media.switchImpl = async () => {
      throw new VoiceMediaError(voiceErrorForCode("input_unavailable"));
    };
    await expect(client.setInputDevice("mic_gone")).resolves.toBe(false);
    expect(client.getSnapshot()).toMatchObject({
      phase: "failed",
      error: { code: "input_unavailable", recovery: "choose_input" },
    });
    client.dispose();
  });
});

function mediaPrepareOf(world: World) {
  return world.media.session.prepare;
}

function stubMediaDevices(list: { deviceId: string; kind: string; label: string }[]) {
  Object.defineProperty(window.navigator, "mediaDevices", {
    configurable: true,
    value: { enumerateDevices: vi.fn(async () => list) },
  });
}

function unstubMediaDevices() {
  delete (window.navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
}

function scheduledRun(world: World) {
  const pending = [...world.scheduled];
  world.scheduled.length = 0;
  for (const callback of pending) callback();
}
