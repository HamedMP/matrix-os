import { describe, expect, it, vi } from "vitest";
import {
  VoiceTransport,
  type VoiceTransportSocket,
} from "../../packages/ui/src/voice-session/transport";
import type { VoiceServerFrame } from "../../packages/contracts/src/voice-session";

const SESSION_ID = "vs_test_transport";

class FakeSocket implements VoiceTransportSocket {
  readyState = 0;
  bufferedAmount = 0;
  readonly sent: (string | ArrayBuffer | ArrayBufferView)[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closedWith = { code, reason };
    this.onclose?.({ code: code ?? 1000, reason: reason ?? "", wasClean: true });
  }

  /** Test-side event helpers. */
  emitOpen(): void {
    this.readyState = 1;
    this.onopen?.({ type: "open" });
  }

  emitMessage(data: unknown): void {
    this.onmessage?.({ data });
  }

  emitFrame(sequence: number, body: Record<string, unknown>, epoch = 1): void {
    this.emitMessage(JSON.stringify({
      contractVersion: 1,
      sessionId: SESSION_ID,
      epoch,
      sequence,
      ...body,
    }));
  }

  emitClose(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code, reason: "", wasClean: false });
  }
}

interface Harness {
  transport: VoiceTransport;
  sockets: FakeSocket[];
  urls: string[];
  frames: VoiceServerFrame[];
  lost: { code: number | null; reconnectable: boolean; reason: string }[];
  backpressure: number[];
  invalid: string[];
  tickHeartbeat: () => void;
  setNow: (value: number) => void;
}

function harness(options: {
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  maxOutboundQueue?: number;
  decodeBinaryFrame?: (data: ArrayBuffer) => unknown;
  binaryAudio?: boolean;
} = {}): Harness {
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const frames: VoiceServerFrame[] = [];
  const lost: Harness["lost"] = [];
  const backpressure: number[] = [];
  const invalid: string[] = [];
  let now = 1_000;
  let heartbeatTick: (() => void) | null = null;
  const transport = new VoiceTransport({
    sessionId: SESSION_ID,
    webSocketFactory: (url) => {
      urls.push(url);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs,
    maxOutboundQueue: options.maxOutboundQueue,
    binaryAudio: options.binaryAudio,
    decodeBinaryFrame: options.decodeBinaryFrame,
    now: () => now,
    setIntervalFn: (callback) => {
      heartbeatTick = callback;
      return heartbeatTick;
    },
    clearIntervalFn: () => {
      heartbeatTick = null;
    },
    events: {
      onFrame: (frame) => frames.push(frame),
      onConnectionLost: (info) => lost.push(info),
      onBackpressure: (dropped) => backpressure.push(dropped),
      onInvalidFrame: (direction) => invalid.push(direction),
    },
  });
  return {
    transport,
    sockets,
    urls,
    frames,
    lost,
    backpressure,
    invalid,
    tickHeartbeat: () => heartbeatTick?.(),
    setNow: (value) => {
      now = value;
    },
  };
}

function sentFrames(socket: FakeSocket): Record<string, unknown>[] {
  return socket.sent.map((data) => JSON.parse(String(data)) as Record<string, unknown>);
}

describe("VoiceTransport", () => {
  it("connects with a single-use ?ticket= query credential on the ws URL", () => {
    const { transport, urls } = harness();
    transport.connect({ url: "https://gw.example/ws/chats/chat_1/voice/vs_test_transport", ticket: "tk abc/==", epoch: 1 });
    expect(urls).toHaveLength(1);
    const url = new URL(urls[0]!);
    expect(url.protocol).toBe("wss:");
    expect(url.pathname).toBe("/ws/chats/chat_1/voice/vs_test_transport");
    expect(url.searchParams.get("ticket")).toBe("tk abc/==");
    expect(url.searchParams.get("token")).toBeNull();
  });

  it("stamps outbound frames with monotonic sequence per epoch and resets on session.resumed", () => {
    const { transport, sockets, frames } = harness();
    transport.connect({ url: "wss://gw/ws/voice", ticket: "t1", epoch: 3 });
    const socket = sockets[0]!;
    socket.emitOpen();

    transport.send({ type: "session.pause" });
    transport.send({ type: "session.resume" });
    let sent = sentFrames(socket);
    expect(sent.map((frame) => frame.sequence)).toEqual([1, 2]);
    expect(sent[0]).toMatchObject({ contractVersion: 1, sessionId: SESSION_ID, epoch: 3, type: "session.pause" });

    // The server elects epoch 4: outbound sequencing restarts for it.
    socket.emitFrame(1, { type: "session.resumed", state: "listening", reason: "restored" }, 4);
    expect(frames).toHaveLength(1);
    expect(transport.currentEpoch).toBe(4);
    transport.send({ type: "session.pause" });
    sent = sentFrames(socket);
    expect(sent[2]).toMatchObject({ epoch: 4, sequence: 1, type: "session.pause" });
  });

  it("resets outbound sequence on explicit reconnect to a new epoch and drops stale queued frames", () => {
    const { transport, sockets } = harness();
    transport.connect({ url: "wss://gw/ws/voice", ticket: "t1", epoch: 1 });
    // Never opened: frames pile into the queue for epoch 1.
    transport.send({ type: "session.pause" });
    transport.send({ type: "session.resume" });

    transport.connect({ url: "wss://gw/ws/voice", ticket: "t2", epoch: 2 });
    const socket = sockets[1]!;
    socket.emitOpen();
    transport.send({ type: "session.pause" });
    const sent = sentFrames(socket);
    // Stale epoch-1 queued frames were dropped; only the new epoch's frame is sent.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ epoch: 2, sequence: 1 });
  });

  it("drops and counts malformed inbound frames while delivering valid ones", () => {
    const { transport, sockets, frames, invalid } = harness();
    transport.connect({ url: "wss://gw/ws/voice", ticket: "t1", epoch: 1 });
    const socket = sockets[0]!;
    socket.emitOpen();

    socket.emitMessage("not json");
    socket.emitMessage(JSON.stringify({ type: "session.state", state: "listening" })); // missing envelope
    socket.emitFrame(1, { type: "session.state", state: "listening" }, 1);
    // Wrong session binding is dropped, not delivered.
    socket.emitMessage(JSON.stringify({
      contractVersion: 1, sessionId: "vs_other", epoch: 1, sequence: 1, type: "session.state", state: "failed",
    }));

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "session.state", state: "listening" });
    expect(transport.snapshot().invalidInbound).toBe(3);
    expect(invalid).toEqual(["inbound", "inbound", "inbound"]);
  });

  it("decodes inbound binary frames only when a decoder is negotiated", () => {
    const plain = harness();
    plain.transport.connect({ url: "wss://gw/ws/voice", ticket: "t1", epoch: 1 });
    const socket = plain.sockets[0]!;
    socket.emitOpen();
    socket.emitMessage(new Uint8Array([1, 2, 3]).buffer);
    expect(plain.transport.snapshot().binaryInbound).toBe(1);
    expect(plain.transport.snapshot().invalidInbound).toBe(1);

    const decodeBinaryFrame = vi.fn((data: ArrayBuffer) => ({
      contractVersion: 1,
      sessionId: SESSION_ID,
      epoch: 1,
      sequence: 7,
      type: "heartbeat.ack",
      timestampMs: new DataView(data).getUint8(0),
    }));
    const decoded = harness({ decodeBinaryFrame });
    decoded.transport.connect({ url: "wss://gw/ws/voice", ticket: "t1", epoch: 1 });
    const socket2 = decoded.sockets[0]!;
    socket2.emitOpen();
    socket2.emitMessage(new Uint8Array([42]).buffer);
    expect(decodeBinaryFrame).toHaveBeenCalledOnce();
    expect(decoded.frames).toEqual([
      expect.objectContaining({ type: "heartbeat.ack", timestampMs: 42 }),
    ]);
  });

  it("sends heartbeats on the bounded interval and reports heartbeat_timeout on silence", () => {
    const { transport, sockets, lost, tickHeartbeat, setNow } = harness({
      heartbeatIntervalMs: 250,
      heartbeatTimeoutMs: 700,
    });
    transport.connect({ url: "wss://gw/ws/voice", ticket: "t1", epoch: 1 });
    const socket = sockets[0]!;
    socket.emitOpen();
    transport.send({ type: "session.pause" });

    tickHeartbeat();
    const sent = sentFrames(socket);
    expect(sent[1]).toMatchObject({ type: "heartbeat", sequence: 2 });
    expect(lost).toHaveLength(0);

    // Ack arrives: the silence window resets.
    socket.emitFrame(1, { type: "heartbeat.ack", timestampMs: 1_000 }, 1);
    setNow(1_600);
    tickHeartbeat();
    expect(lost).toHaveLength(0);

    // No inbound at all for longer than the timeout: the socket is dead even
    // without a close frame.
    setNow(2_400);
    tickHeartbeat();
    expect(lost).toEqual([{ code: null, reconnectable: true, reason: "heartbeat_timeout" }]);
    expect(socket.closedWith?.code).toBe(1_001);
    expect(transport.connected).toBe(false);
  });

  it("flags unexpected closes reconnectable except for policy/terminal codes", () => {
    const { transport, sockets, lost } = harness();
    transport.connect({ url: "wss://gw/ws/voice", ticket: "t1", epoch: 1 });
    sockets[0]!.emitOpen();
    sockets[0]!.emitClose(1_006);
    expect(lost.at(-1)).toMatchObject({ reconnectable: true, reason: "closed" });

    transport.connect({ url: "wss://gw/ws/voice", ticket: "t2", epoch: 2 });
    sockets[1]!.emitClose(1_008);
    expect(lost.at(-1)).toMatchObject({ code: 1_008, reconnectable: false });

    // Clean client close never reports a loss.
    transport.connect({ url: "wss://gw/ws/voice", ticket: "t3", epoch: 3 });
    const count = lost.length;
    transport.close();
    expect(lost).toHaveLength(count);
    expect(sockets[2]!.closedWith?.code).toBe(1_000);
  });

  it("bounds the outbound queue with drop-oldest and surfaces backpressure", () => {
    const { transport, sockets, backpressure } = harness({ maxOutboundQueue: 3 });
    transport.connect({ url: "wss://gw/ws/voice", ticket: "t1", epoch: 1 });
    const socket = sockets[0]!;
    // Socket still CONNECTING: everything queues.
    for (let index = 0; index < 5; index += 1) {
      transport.send({ type: "heartbeat", timestampMs: index });
    }
    expect(backpressure.length).toBeGreaterThan(0);
    expect(transport.snapshot().droppedOutbound).toBe(2);

    socket.emitOpen();
    const sent = sentFrames(socket);
    // Drop-oldest kept the newest three queued frames (timestamps 2, 3, 4).
    expect(sent.map((frame) => frame.timestampMs)).toEqual([2, 3, 4]);
  });

  it("queues outbound frames while the socket write buffer is saturated and drains on the next tick", () => {
    const { transport, sockets, tickHeartbeat } = harness();
    transport.connect({ url: "wss://gw/ws/voice", ticket: "t1", epoch: 1 });
    const socket = sockets[0]!;
    socket.emitOpen();
    socket.bufferedAmount = 2 * 1024 * 1024;
    transport.send({ type: "session.pause" });
    expect(sentFrames(socket)).toHaveLength(0);
    socket.bufferedAmount = 0;
    // The heartbeat tick doubles as the drain pump for the bounded queue.
    tickHeartbeat();
    const sent = sentFrames(socket);
    expect(sent.map((frame) => frame.type)).toEqual(["session.pause", "heartbeat"]);
    expect(sent[0]).toMatchObject({ sequence: 1 });
  });

  it("rejects outbound frames that fail contract validation instead of sending", () => {
    const { transport, sockets, invalid } = harness();
    transport.connect({ url: "wss://gw/ws/voice", ticket: "t1", epoch: 1 });
    const socket = sockets[0]!;
    socket.emitOpen();
    const accepted = transport.send({ type: "capture.start", turnId: "bad turn id!", mode: "hands_free" });
    expect(accepted).toBe(false);
    expect(sentFrames(socket)).toHaveLength(0);
    expect(transport.snapshot().invalidOutbound).toBe(1);
    expect(invalid).toEqual(["outbound"]);
  });

  it("does not send after dispose", () => {
    const { transport, sockets } = harness();
    transport.connect({ url: "wss://gw/ws/voice", ticket: "t1", epoch: 1 });
    sockets[0]!.emitOpen();
    transport.dispose();
    expect(transport.send({ type: "session.pause" })).toBe(false);
    expect(sockets[0]!.closedWith?.code).toBe(1_000);
    // A late close from the retired socket cannot report a loss.
    sockets[0]!.emitClose(1_006);
  });
});
