import { EventEmitter } from "node:events";
import { fakeCore } from "./fixtures/fake-herdr-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectHc, HcCallError, HcProtocolError, HcVersionMismatchError } from "@desktop/main/local-terminals/hc-client";
import { encodeFrame, HC_FRAME, HcFrameDecoder, HC_MAX_PAYLOAD } from "@desktop/main/local-terminals/hc-protocol";

describe("herdr-core frame codec", () => {
  it("round-trips frames split at arbitrary byte boundaries", () => {
    const bytes = Buffer.concat([encodeFrame(0, 0, Buffer.from("{}")), encodeFrame(7, 0, Buffer.from("héllo")), encodeFrame(7, 2, Buffer.alloc(0))]);
    const decoder = new HcFrameDecoder();
    const frames = [...bytes].flatMap((byte) => decoder.push(Buffer.from([byte])));
    expect(frames.map((frame) => [frame.channel, frame.kind, frame.payload.toString("utf8")])).toEqual([[0, 0, "{}"], [7, 0, "héllo"], [7, 2, ""]]);
  });

  it("rejects a frame that claims more than the protocol cap", () => {
    const header = Buffer.alloc(9);
    header.writeUInt32LE(HC_MAX_PAYLOAD + 1, 5);
    expect(() => new HcFrameDecoder().push(header)).toThrow("frame too large");
  });
});

describe("herdr-core client", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  async function connected() {
    const core = fakeCore();
    const connection = await connectHc({ open: () => core.socket, expectedVersion: "0.1.19" });
    return { core, connection };
  }

  it("handshakes in framed mode and reports the core version", async () => {
    const { core, connection } = await connected();
    expect(JSON.parse(core.sent.plain[0]!)).toMatchObject({ method: "hello", params: { framed: true } });
    expect(connection.version).toBe("0.1.19");
  });

  it("refuses a core of another version or generation without sending any other call", async () => {
    for (const options of [{ version: "0.1.20" }, { generation: 2 }]) {
      const core = fakeCore(options);
      await expect(connectHc({ open: () => core.socket, expectedVersion: "0.1.19" })).rejects.toBeInstanceOf(HcVersionMismatchError);
      expect(core.sent.calls).toEqual([]);
      expect(core.socket.destroyed).toBe(true);
    }
  });

  it("times out a silent core during the handshake", async () => {
    const socket = new EventEmitter() as never as { write(): void; destroy(): void; on: EventEmitter["on"] };
    socket.write = () => undefined; socket.destroy = () => undefined;
    const attempt = connectHc({ open: () => socket as never, expectedVersion: "0.1.19", timeoutMs: 1_000 });
    const failure = expect(attempt).rejects.toThrow("did not answer");
    await vi.advanceTimersByTimeAsync(1_000);
    await failure;
  });

  it("matches replies to calls and reduces core errors to their stable kind", async () => {
    const { core, connection } = await connected();
    core.onCall((call) => {
      if (call.method === "terminal.list") core.reply(call.id, { result: { terminals: [] } });
      else core.reply(call.id, { error: { code: -32000, message: "no terminal \"/Users/x/secret\"", data: { kind: "not_found", hint: "…" } } });
    });
    await expect(connection.call("terminal.list", {})).resolves.toEqual({ terminals: [] });
    const failure = await connection.call("terminal.get", { terminal: "t9" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HcCallError);
    expect((failure as HcCallError).kind).toBe("not_found");
    expect((failure as Error).message).not.toContain("secret");
  });

  it("times out an unanswered call and bounds calls in flight", async () => {
    const { connection } = await connected();
    const slow = expect(connection.call("terminal.list", {}, 500)).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(500);
    await slow;
    const flood = Array.from({ length: 64 }, () => connection.call("terminal.list", {}).catch(() => undefined));
    await expect(connection.call("terminal.list", {})).rejects.toThrow("busy");
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.all(flood);
  });

  it("streams terminal bytes with credit, forwards input and resize, and closes cleanly", async () => {
    const { core, connection } = await connected();
    core.onCall((call) => core.reply(call.id, { result: { channel: 3, terminal: {} } }));
    const onData = vi.fn();
    const onClose = vi.fn();
    const stream = await connection.attach({ terminal: "t1", cols: 100, rows: 30 }, { onData, onClose });
    expect(core.sent.calls.at(-1)).toMatchObject({ method: "terminal.attach", params: { terminal: "t1", cols: 100, rows: 30 } });

    core.stream(3, HC_FRAME.DATA, Buffer.from("hello"));
    expect(onData).toHaveBeenCalledWith(Buffer.from("hello"), expect.any(Function));
    // No credit until the reader says it consumed the bytes; then exactly once.
    expect(core.sent.frames).toEqual([]);
    const consumed = onData.mock.calls[0]![1] as () => void;
    consumed();
    consumed();
    expect(core.sent.frames).toHaveLength(1);
    expect(core.sent.frames.at(-1)).toMatchObject({ channel: 3, kind: HC_FRAME.CREDIT });
    expect(core.sent.frames.at(-1)!.payload.readUInt32LE(0)).toBe(5);

    stream.write(Buffer.from("ls\r"));
    stream.resize(120, 40);
    expect(core.sent.frames.at(-2)).toMatchObject({ channel: 3, kind: HC_FRAME.DATA, payload: Buffer.from("ls\r") });
    expect([core.sent.frames.at(-1)!.payload.readUInt16LE(0), core.sent.frames.at(-1)!.payload.readUInt16LE(2)]).toEqual([120, 40]);

    stream.close();
    expect(core.sent.frames.at(-1)).toMatchObject({ channel: 3, kind: HC_FRAME.CLOSE });
    core.stream(3, HC_FRAME.DATA, Buffer.from("late"));
    expect(onData).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("delivers output and the end of a terminal that arrive in the same read as the attach reply", async () => {
    const { core, connection } = await connected();
    core.onCall((call) => core.socket.emit("data", Buffer.concat([
      core.replyBytes(call.id, { result: { channel: 6 } }),
      encodeFrame(6, HC_FRAME.DATA, Buffer.from("history")),
      encodeFrame(6, HC_FRAME.CLOSE, Buffer.alloc(0)),
    ])));
    const onData = vi.fn();
    const onClose = vi.fn();
    await connection.attach({ terminal: "t1", cols: 80, rows: 24 }, { onData, onClose });
    expect(onData).toHaveBeenCalledWith(Buffer.from("history"), expect.any(Function));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("drops the connection when the core reuses an open channel or names one outside the protocol", async () => {
    const reused = await connected();
    reused.core.onCall((call) => reused.core.reply(call.id, { result: { channel: 3 } }));
    await reused.connection.attach({ terminal: "t1", cols: 80, rows: 24 }, { onData: vi.fn(), onClose: vi.fn() });
    await expect(reused.connection.attach({ terminal: "t2", cols: 80, rows: 24 }, { onData: vi.fn(), onClose: vi.fn() }))
      .rejects.toBeInstanceOf(HcProtocolError);
    expect(reused.core.socket.destroyed).toBe(true);

    const wide = await connected();
    wide.core.onCall((call) => wide.core.reply(call.id, { result: { channel: 2 ** 32 } }));
    await expect(wide.connection.attach({ terminal: "t1", cols: 80, rows: 24 }, { onData: vi.fn(), onClose: vi.fn() })).rejects.toThrow();
    expect(wide.core.sent.frames).toEqual([]);
  });

  it("closes the channel of an attach that answered after its call timed out", async () => {
    const { core, connection } = await connected();
    const attempt = expect(connection.attach({ terminal: "t1", cols: 80, rows: 24 }, { onData: vi.fn(), onClose: vi.fn() }))
      .rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(5_000);
    await attempt;
    core.reply(core.sent.calls.at(-1)!.id, { result: { channel: 9 } });
    expect(core.sent.frames.at(-1)).toMatchObject({ channel: 9, kind: HC_FRAME.CLOSE });
  });

  it("tells an unreadable handshake apart from a core of another version", async () => {
    for (const hello of [{ error: { code: -32601, message: "no" } }, { result: { version: 7 } }]) {
      const core = fakeCore({ hello });
      const failure = await connectHc({ open: () => core.socket, expectedVersion: "0.1.19" }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(HcProtocolError);
      expect(failure).not.toBeInstanceOf(HcVersionMismatchError);
    }
  });

  it("fails every pending call and closes every stream when the core disconnects", async () => {
    const { core, connection } = await connected();
    core.onCall((call) => { if (call.method === "terminal.attach") core.reply(call.id, { result: { channel: 4 } }); });
    const onClose = vi.fn();
    await connection.attach({ terminal: "t1", cols: 80, rows: 24 }, { onData: vi.fn(), onClose });
    const disconnected = vi.fn();
    connection.onDisconnect(disconnected);
    const pending = connection.call("terminal.list", {});
    core.socket.emit("close");
    await expect(pending).rejects.toThrow("disconnected");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(disconnected).toHaveBeenCalledTimes(1);
    await expect(connection.call("terminal.list", {})).rejects.toThrow("disconnected");
    expect(vi.getTimerCount()).toBe(0);
  });
});
