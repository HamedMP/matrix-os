// Local terminal output over one MessagePort per attachment (spec 2701 layer
// 6): the real client, sessions, main-process streams and preload bridge,
// with Node MessagePorts standing in for Electron's.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectHc } from "@matrix-os/herdr-core-client/client";
import { HC_FRAME } from "@matrix-os/herdr-core-client/protocol";
import { createHcSessions } from "@matrix-os/herdr-core-client/sessions";
import { createOperatorBridge } from "@desktop/shared/operator-bridge";
import { fakeCore } from "./fixtures/fake-herdr-core";
import { LOCAL_TERMINAL_VERSION } from "@desktop/shared/local-terminals";
import { localTerminalPorts } from "./fixtures/local-terminal-ports";

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const bytes = (value: string) => new TextEncoder().encode(value);

describe("local terminal streams", () => {
  let ports: ReturnType<typeof localTerminalPorts>;
  beforeEach(() => { ports = localTerminalPorts(); vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { ports.dispose(); vi.restoreAllMocks(); });

  function window(attachId: number) {
    const output: Uint8Array[] = [];
    const closed = vi.fn();
    const stream = ports.bridge(attachId, { output: (data) => output.push(data), closed })!;
    return { output, closed, stream, text: () => new TextDecoder().decode(Buffer.concat(output)) };
  }

  it("carries the core's bytes to the window unchanged, and returns credit only once the window acknowledges", async () => {
    const core = fakeCore();
    core.onCall((call) => { if (call.method === "terminal.attach") core.reply(call.id, { result: { channel: 3 } }); });
    const connection = await connectHc({ open: () => core.socket, expectedVersion: LOCAL_TERMINAL_VERSION });
    const sessions = createHcSessions({ ensure: async () => connection }, ports.streams.sink);
    ports.streams.bind(sessions);
    const attachId = await sessions.attach("t1", { cols: 80, rows: 24 });
    expect(ports.streams.open(attachId)).toBe(true);
    const view = window(attachId);
    // "é" is two bytes; the core may cut between them.
    const encoded = bytes("café \u{1F600}\r\n");
    core.stream(3, HC_FRAME.DATA, Buffer.from(encoded.subarray(0, 4)));
    core.stream(3, HC_FRAME.DATA, Buffer.from(encoded.subarray(4)));
    await vi.waitFor(() => expect(view.output).toHaveLength(2));
    expect(view.text()).toBe("café \u{1F600}\r\n");
    const credits = () => core.sent.frames.filter((frame) => frame.kind === HC_FRAME.CREDIT).map((frame) => frame.payload.readUInt32LE(0));
    expect(credits()).toEqual([]);
    view.stream.ack(2);
    await vi.waitFor(() => expect(credits()).toEqual([4, encoded.length - 4]));

    view.stream.input("ls\r", false);
    await vi.waitFor(() => expect(core.sent.frames.some((frame) => frame.kind === HC_FRAME.DATA && frame.payload.toString() === "ls\r")).toBe(true));
    connection.close();
  });

  // herdr-core passes focus to programs that asked for focus reports, and
  // answers colour and cell-size queries from the viewer's display facts.
  it("sends the core FOCUS and FACTS frames for the attachment", async () => {
    const core = fakeCore();
    core.onCall((call) => { if (call.method === "terminal.attach") core.reply(call.id, { result: { channel: 5 } }); });
    const connection = await connectHc({ open: () => core.socket, expectedVersion: LOCAL_TERMINAL_VERSION });
    const sessions = createHcSessions({ ensure: async () => connection }, ports.streams.sink);
    ports.streams.bind(sessions);
    const attachId = await sessions.attach("t1", { cols: 80, rows: 24 });
    ports.streams.open(attachId);
    const view = window(attachId);
    view.stream.focus(true);
    view.stream.facts({ fg: "#eeeeee", bg: "#123456", cursor: "#ff0000", cell: [9, 18] });
    view.stream.focus(false);
    const sent = () => core.sent.frames.filter((frame) => frame.channel === 5 && (frame.kind === HC_FRAME.FOCUS || frame.kind === HC_FRAME.FACTS));
    await vi.waitFor(() => expect(sent()).toHaveLength(3));
    expect(sent().map((frame) => [frame.kind, frame.kind === HC_FRAME.FOCUS ? frame.payload[0] : JSON.parse(frame.payload.toString())])).toEqual([
      [HC_FRAME.FOCUS, 1],
      [HC_FRAME.FACTS, { fg: "#eeeeee", bg: "#123456", cursor: "#ff0000", cell: [9, 18] }],
      [HC_FRAME.FOCUS, 0],
    ]);
    connection.close();
  });

  it("drops display facts that are not plain colours and sizes", async () => {
    ports.streams.open(4);
    for (const message of [
      { type: "facts", bg: "red" }, { type: "facts", fg: "#12345" }, { type: "facts", cell: [0, 18] },
      { type: "facts", cell: [9, 18, 1] }, { type: "facts", bg: "#000000", argv: ["x"] }, { type: "focus", focused: "yes" },
    ]) ports.raw(4, message);
    ports.raw(4, { type: "facts", bg: "#000000" });
    await vi.waitFor(() => expect(ports.host.facts).toHaveBeenCalledWith(4, { bg: "#000000" }));
    expect(ports.host.facts).toHaveBeenCalledTimes(1);
    expect(ports.host.focus).not.toHaveBeenCalled();
  });

  it("validates what the window sends before it reaches the core", async () => {
    ports.streams.open(4);
    const view = window(4);
    view.stream.input("x".repeat(70_000), false);
    view.stream.input("€", true);
    view.stream.ack(0);
    view.stream.ack(5_000);
    view.stream.input("\u0000ÿ", true);
    await vi.waitFor(() => expect(ports.host.input).toHaveBeenCalled());
    await tick();
    expect(ports.host.input.mock.calls).toEqual([[4, "\u0000ÿ", true]]);
    expect(ports.host.acknowledge).not.toHaveBeenCalled();
  });

  it("checks in main what arrives on a port, whatever the preload let through", async () => {
    ports.streams.open(5);
    for (const message of [
      { type: "input", data: "x".repeat(70_000) }, { type: "input", data: "\u20ac", binary: true }, { type: "ack", count: 0 },
      { type: "ack", count: 1, extra: true }, { type: "exec", argv: ["rm"] }, "ls\r", null,
    ]) ports.raw(5, message);
    ports.raw(5, { type: "input", data: "ok" });
    await vi.waitFor(() => expect(ports.host.input).toHaveBeenCalledWith(5, "ok", false));
    expect(ports.host.input).toHaveBeenCalledTimes(1);
    expect(ports.host.acknowledge).not.toHaveBeenCalled();
  });

  it("tells the window when it types into an attachment the core no longer holds", async () => {
    ports.host.input.mockReturnValue(false);
    ports.streams.open(6);
    const view = window(6);
    view.stream.input("ls\r", false);
    await vi.waitFor(() => expect(view.closed).toHaveBeenCalledTimes(1));
    expect(ports.streams.size()).toBe(0);
  });

  it("keeps the order of output and the end of a terminal that exited before the window took its port", async () => {
    ports.output(7, "bye\r\n");
    ports.closed(7);
    const view = window(7);
    await vi.waitFor(() => expect(view.closed).toHaveBeenCalled());
    expect(view.text()).toBe("bye\r\n");
  });

  it("sends the window only the output's own bytes, not the socket read around them", async () => {
    ports.streams.open(3);
    const view = window(3);
    // Socket reads arrive as Node Buffers, whose slice() is a view, not a copy.
    const read = Buffer.alloc(64 * 1024, 0x61);
    ports.output(3, read.subarray(100, 116));
    await vi.waitFor(() => expect(view.output).toHaveLength(1));
    expect(view.output[0]!.byteLength).toBe(16);
    expect(view.output[0]!.buffer.byteLength).toBe(16);
  });

  it("does not stall a program while no window can show its output", () => {
    ports.closeWindow();
    ports.output(8, "unseen");
    expect(ports.host.acknowledge).toHaveBeenCalledWith(8, 1);
    expect(ports.streams.size()).toBe(0);
  });

  it("closes every port when the window goes", () => {
    ports.streams.open(1);
    ports.streams.open(2);
    ports.streams.releaseAll();
    expect(ports.streams.size()).toBe(0);
  });
});

describe("local terminal stream bridge", () => {
  it("is offered to the Terminal window only", () => {
    const ipc = { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
    expect("localTerminalStream" in createOperatorBridge(ipc, "main")).toBe(false);
    expect(ipc.on).not.toHaveBeenCalled();
    expect(typeof (createOperatorBridge(ipc, "terminal") as { localTerminalStream?: unknown }).localTerminalStream).toBe("function");
  });

  it("connects a window that asked for its port before the port arrived, and sends what it typed meanwhile", async () => {
    const ports = localTerminalPorts();
    try {
      const output: Uint8Array[] = [];
      const stream = ports.bridge(9, { output: (data) => output.push(data), closed: () => undefined })!;
      stream.input("early", false);
      ports.output(9, "hello");
      await vi.waitFor(() => expect(output).toHaveLength(1));
      await vi.waitFor(() => expect(ports.host.input).toHaveBeenCalledWith(9, "early", false));
    } finally { ports.dispose(); }
  });

  it("refuses a handle for an id that is not an attachment", () => {
    const ports = localTerminalPorts();
    try {
      expect(ports.bridge(0, { output: () => undefined, closed: () => undefined })).toBeNull();
      expect(ports.bridge("1" as unknown as number, { output: () => undefined, closed: () => undefined })).toBeNull();
    } finally { ports.dispose(); }
  });
});
