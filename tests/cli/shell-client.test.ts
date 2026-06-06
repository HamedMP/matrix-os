import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  createShellClient,
  SHELL_ATTACH_LIVE_TAIL_FROM_SEQ,
  SHELL_ATTACH_MAX_QUEUED_BYTES,
} from "../../packages/sync-client/src/cli/shell-client.js";

const LOCAL_TERMINAL_INPUT_RESET = "\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1006l\u001b[?1015l\u001b[?1004l\u001b[?2004l\u001b[>4;0m\u001b[<1u";

class ControlledWebSocket {
  static last: ControlledWebSocket | null = null;
  static lastUrl: string | null = null;
  static lastOptions: unknown = null;
  closed = false;
  listeners = new Map<string, (...args: unknown[]) => void>();
  sent: string[] = [];

  constructor(url: string, options?: unknown) {
    ControlledWebSocket.last = this;
    ControlledWebSocket.lastUrl = url;
    ControlledWebSocket.lastOptions = options;
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.listeners.get("close")?.();
  }

  on(event: "open" | "message" | "close" | "error", listener: (...args: unknown[]) => void) {
    this.listeners.set(event, listener);
    return this;
  }

  off(event: "open" | "message" | "close" | "error") {
    this.listeners.delete(event);
    return this;
  }

  emit(event: "open" | "message" | "close" | "error", value?: unknown) {
    this.listeners.get(event)?.(value);
  }
}

class FakeTtyInput extends EventEmitter {
  isTTY = true;
  columns = 100;
  rows = 30;
  rawModes: boolean[] = [];
  resumed = false;

  setRawMode(enabled: boolean) {
    this.rawModes.push(enabled);
    return this;
  }

  resume() {
    this.resumed = true;
    return this;
  }
}

describe("shell REST client", () => {
  it("lists sessions with bearer auth, JSON parsing, and fetch timeout", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ sessions: [] })));
    const client = createShellClient({
      gatewayUrl: "http://gateway",
      token: "tok",
      fetch: fetchImpl,
    });

    await expect(client.listSessions()).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://gateway/api/terminal/sessions",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("returns stable generic errors", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error: { code: "session_not_found", message: "/home/alice" } }),
      { status: 404 },
    ));
    const client = createShellClient({
      gatewayUrl: "http://gateway",
      token: "tok",
      fetch: fetchImpl,
    });

    await expect(client.deleteSession("missing")).rejects.toMatchObject({
      code: "session_not_found",
      message: "Request failed",
    });
  });

  it("maps gateway auth rejection to an auth refresh error", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401 },
    ));
    const client = createShellClient({
      gatewayUrl: "http://gateway",
      token: "stale-token",
      fetch: fetchImpl,
    });

    await expect(client.listSessions()).rejects.toMatchObject({
      code: "auth_expired",
      message: "Request failed",
    });
  });

  it("maps gateway fetch failures to gateway_unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("connect ECONNREFUSED 127.0.0.1:4000");
    });
    const client = createShellClient({
      gatewayUrl: "http://gateway",
      token: "tok",
      fetch: fetchImpl,
    });

    await expect(client.listSessions()).rejects.toMatchObject({
      code: "gateway_unreachable",
      message: "Request failed",
    });
  });

  it("maps gateway fetch aborts to request_timeout", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    });
    const client = createShellClient({
      gatewayUrl: "http://gateway",
      token: "tok",
      fetch: fetchImpl,
    });

    await expect(client.listSessions()).rejects.toMatchObject({
      code: "request_timeout",
      message: "Request failed",
    });
  });

  it("keeps gateway forbidden responses generic", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error: "Forbidden" }),
      { status: 403 },
    ));
    const client = createShellClient({
      gatewayUrl: "http://gateway",
      token: "valid-but-forbidden-token",
      fetch: fetchImpl,
    });

    await expect(client.listSessions()).rejects.toMatchObject({
      code: "request_failed",
      message: "Request failed",
    });
  });

  it("builds terminal websocket URLs without leaking bearer auth by default", () => {
    const client = createShellClient({
      gatewayUrl: "https://gateway.example",
      token: "tok",
    });

    expect(client.createAttachUrl("main", { fromSeq: 7 })).toBe(
      "wss://gateway.example/ws/terminal/session?session=main&fromSeq=7",
    );
  });

  it("supports explicit terminal websocket query tokens for browser clients", () => {
    const client = createShellClient({
      gatewayUrl: "https://gateway.example",
      token: "bearer-token",
    });

    expect(client.createAttachUrl("main", { token: "query-token" })).toBe(
      "wss://gateway.example/ws/terminal/session?session=main&token=query-token",
    );
  });

  it("times out terminal websocket attach attempts", async () => {
    class HangingWebSocket {
      closed = false;
      listeners = new Map<string, (...args: unknown[]) => void>();

      send() {}

      close() {
        this.closed = true;
      }

      on(event: "open" | "message" | "close" | "error", listener: (...args: unknown[]) => void) {
        this.listeners.set(event, listener);
        return this;
      }

      off(event: "open" | "message" | "close" | "error") {
        this.listeners.delete(event);
        return this;
      }
    }

    const client = createShellClient({
      gatewayUrl: "http://gateway",
      timeoutMs: 5,
    });
    const input = { on: vi.fn(), off: vi.fn() } as unknown as NodeJS.ReadStream;
    const output = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    await expect(client.attachSession("main", {
      WebSocketImpl: HangingWebSocket,
      input,
      output,
      errorOutput,
    })).rejects.toMatchObject({ code: "attach_timeout" });
  });

  it("clears the attach timeout after the websocket opens", async () => {
    const client = createShellClient({ gatewayUrl: "http://gateway", token: "tok", timeoutMs: 5 });
    const input = new EventEmitter() as NodeJS.ReadStream;
    const output = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachSession("main", {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
    });
    ControlledWebSocket.last?.emit("open");
    await new Promise((resolve) => setTimeout(resolve, 10));
    ControlledWebSocket.last?.emit("message", JSON.stringify({ type: "attached" }));
    ControlledWebSocket.last?.emit("close");

    await expect(attached).resolves.toEqual({ detached: true });
    expect(ControlledWebSocket.lastUrl).toBe(
      `ws://gateway/ws/terminal/session?session=main&fromSeq=${SHELL_ATTACH_LIVE_TAIL_FROM_SEQ}`,
    );
    expect(ControlledWebSocket.lastOptions).toEqual({
      headers: { Authorization: "Bearer tok" },
    });
  });

  it("honors explicit replay cursors for terminal attach", async () => {
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new EventEmitter() as NodeJS.ReadStream;
    const output = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachSession("main", {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
      fromSeq: 0,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", JSON.stringify({ type: "attached" }));
    ControlledWebSocket.last?.emit("close");

    await expect(attached).resolves.toEqual({ detached: true });
    expect(ControlledWebSocket.lastUrl).toBe("ws://gateway/ws/terminal/session?session=main&fromSeq=0");
  });

  it("rejects attach when the websocket closes before an attached, error, or exit frame", async () => {
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new EventEmitter() as NodeJS.ReadStream;
    const output = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachSession("main", {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("close");

    await expect(attached).rejects.toMatchObject({ code: "attach_failed" });
  });

  it("distinguishes remote exit from explicit local detach", async () => {
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new EventEmitter() as NodeJS.ReadStream;
    const output = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachSession("main", {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", JSON.stringify({ type: "attached" }));
    ControlledWebSocket.last?.emit("message", JSON.stringify({ type: "exit", code: 0 }));

    await expect(attached).resolves.toEqual({ detached: false });
  });

  it("queues stdin frames until the websocket is open", async () => {
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new EventEmitter() as NodeJS.ReadStream;
    const output = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachSession("main", {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
    });
    input.emit("data", "pwd\r");
    expect(ControlledWebSocket.last?.sent).toEqual([]);

    ControlledWebSocket.last?.emit("open");
    expect(ControlledWebSocket.last?.sent).toEqual([
      JSON.stringify({ type: "input", data: "pwd\r" }),
    ]);
    ControlledWebSocket.last?.emit("message", JSON.stringify({ type: "attached" }));
    ControlledWebSocket.last?.emit("close");
    await expect(attached).resolves.toEqual({ detached: true });
  });

  it("rejects when pre-open stdin exceeds the queued frame cap", async () => {
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new EventEmitter() as NodeJS.ReadStream;
    const output = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachSession("main", {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
    });
    input.emit("data", "x".repeat(SHELL_ATTACH_MAX_QUEUED_BYTES));

    await expect(attached).rejects.toMatchObject({ code: "attach_failed" });
    expect(errorOutput.write).toHaveBeenCalledWith("Shell attach failed\n");
    expect(ControlledWebSocket.last?.closed).toBe(true);
    ControlledWebSocket.last?.emit("open");
    expect(ControlledWebSocket.last?.sent).toEqual([]);
  });

  it("puts local TTY stdin in raw mode, sends initial and changed size, and restores raw mode", async () => {
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new FakeTtyInput() as unknown as NodeJS.ReadStream;
    const output = { write: vi.fn(), columns: 120, rows: 40 } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachSession("setup", {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
    });

    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", JSON.stringify({ type: "attached" }));
    process.emit("SIGWINCH", "SIGWINCH");
    ControlledWebSocket.last?.emit("close");

    await expect(attached).resolves.toEqual({ detached: true });
    expect((input as unknown as FakeTtyInput).rawModes).toEqual([true, false]);
    expect((input as unknown as FakeTtyInput).resumed).toBe(true);
    expect(ControlledWebSocket.last?.sent.map((frame) => JSON.parse(frame))).toEqual([
      { type: "resize", cols: 120, rows: 40 },
      { type: "resize", cols: 120, rows: 40 },
    ]);
  });

  it("reserves ctrl-backslash ctrl-backslash for detach without forwarding it to the remote pane", async () => {
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new FakeTtyInput() as unknown as NodeJS.ReadStream;
    const output = { write: vi.fn(), columns: 80, rows: 24 } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachSession("setup", {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", JSON.stringify({ type: "attached" }));
    input.emit("data", "a");
    input.emit("data", "\u001c");
    input.emit("data", "b");
    input.emit("data", "\u001c");
    input.emit("data", "\u001c");

    await expect(attached).resolves.toEqual({ detached: true });
    expect(ControlledWebSocket.last?.closed).toBe(true);
    expect(ControlledWebSocket.last?.sent.map((frame) => JSON.parse(frame))).toEqual([
      { type: "resize", cols: 80, rows: 24 },
      { type: "input", data: "a" },
      { type: "input", data: "\u001cb" },
      { type: "detach" },
    ]);
  });

  it("resets local mouse and focus modes on websocket errors", async () => {
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new FakeTtyInput() as unknown as NodeJS.ReadStream;
    const output = { write: vi.fn(), columns: 80, rows: 24 } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachSession("setup", {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("error", new Error("boom"));

    await expect(attached).rejects.toMatchObject({ code: "attach_failed" });
    expect((input as unknown as FakeTtyInput).rawModes).toEqual([true, false]);
    expect(output.write).toHaveBeenCalledWith(LOCAL_TERMINAL_INPUT_RESET);
  });

  it("drops mouse escape sequences when no-mouse attach mode is enabled", async () => {
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new FakeTtyInput() as unknown as NodeJS.ReadStream;
    const output = { write: vi.fn(), columns: 80, rows: 24 } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachSession("setup", {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
      mouse: false,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", JSON.stringify({ type: "attached" }));
    input.emit("data", "a\u001b[<0;10;20M\u001b[Mabc\u001b[I\u001b[O");
    ControlledWebSocket.last?.emit("close");

    await expect(attached).resolves.toEqual({ detached: true });
    expect(ControlledWebSocket.last?.sent.map((frame) => JSON.parse(frame))).toEqual([
      { type: "resize", cols: 80, rows: 24 },
      { type: "input", data: "a" },
    ]);
  });

  it("drops focus reporting sequences while still dropping mouse input when unfocused", async () => {
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new FakeTtyInput() as unknown as NodeJS.ReadStream;
    const output = { write: vi.fn(), columns: 80, rows: 24 } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachSession("setup", {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", JSON.stringify({ type: "attached" }));
    input.emit("data", "\u001b[Ia\u001b[O\u001b[<0;10;20M");
    ControlledWebSocket.last?.emit("close");

    await expect(attached).resolves.toEqual({ detached: true });
    expect(ControlledWebSocket.last?.sent.map((frame) => JSON.parse(frame))).toEqual([
      { type: "resize", cols: 80, rows: 24 },
      { type: "input", data: "a" },
    ]);
  });

  it("resets stale local mouse modes and drops immediate mouse bytes after focus returns", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(0);
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new FakeTtyInput() as unknown as NodeJS.ReadStream;
    const output = { write: vi.fn(), columns: 80, rows: 24 } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachSession("setup", {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", JSON.stringify({ type: "attached" }));
    ControlledWebSocket.last?.emit("message", JSON.stringify({ type: "output", data: "ready" }));
    nowSpy.mockReturnValue(6_000);
    input.emit("data", "\u001b[I\u001b[<0;10;20M\u001b[Mabcx");
    ControlledWebSocket.last?.emit("close");

    await expect(attached).resolves.toEqual({ detached: true });
    expect(output.write).toHaveBeenCalledWith(LOCAL_TERMINAL_INPUT_RESET);
    expect(ControlledWebSocket.last?.sent.map((frame) => JSON.parse(frame))).toEqual([
      { type: "resize", cols: 80, rows: 24 },
      { type: "input", data: "x" },
    ]);
    nowSpy.mockRestore();
  });

  it("drops stale enhanced keyboard protocol bytes after focus returns", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(0);
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new FakeTtyInput() as unknown as NodeJS.ReadStream;
    const output = { write: vi.fn(), columns: 80, rows: 24 } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachSession("setup", {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", JSON.stringify({ type: "attached" }));
    ControlledWebSocket.last?.emit("message", JSON.stringify({ type: "output", data: "ready" }));
    nowSpy.mockReturnValue(6_000);
    input.emit("data", "\u001b[I\u001b[99;5u\u001b[100;5uok");
    ControlledWebSocket.last?.emit("close");

    await expect(attached).resolves.toEqual({ detached: true });
    expect(output.write).toHaveBeenCalledWith(LOCAL_TERMINAL_INPUT_RESET);
    expect(ControlledWebSocket.last?.sent.map((frame) => JSON.parse(frame))).toEqual([
      { type: "resize", cols: 80, rows: 24 },
      { type: "input", data: "ok" },
    ]);
    nowSpy.mockRestore();
  });

  it("keeps enhanced keyboard protocol bytes while focused", async () => {
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new FakeTtyInput() as unknown as NodeJS.ReadStream;
    const output = { write: vi.fn(), columns: 80, rows: 24 } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachSession("setup", {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", JSON.stringify({ type: "attached" }));
    input.emit("data", "\u001b[99;5u");
    ControlledWebSocket.last?.emit("close");

    await expect(attached).resolves.toEqual({ detached: true });
    expect(ControlledWebSocket.last?.sent.map((frame) => JSON.parse(frame))).toEqual([
      { type: "resize", cols: 80, rows: 24 },
      { type: "input", data: "\u001b[99;5u" },
    ]);
  });

  it("buffers fragmented enhanced keyboard protocol sequences", async () => {
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new FakeTtyInput() as unknown as NodeJS.ReadStream;
    const output = { write: vi.fn(), columns: 80, rows: 24 } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachSession("setup", {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", JSON.stringify({ type: "attached" }));
    input.emit("data", "a\u001b[99");
    input.emit("data", ";5ub");
    ControlledWebSocket.last?.emit("close");

    await expect(attached).resolves.toEqual({ detached: true });
    expect(ControlledWebSocket.last?.sent.map((frame) => JSON.parse(frame))).toEqual([
      { type: "resize", cols: 80, rows: 24 },
      { type: "input", data: "a" },
      { type: "input", data: "\u001b[99;5ub" },
    ]);
  });

  it("buffers fragmented SGR mouse sequences instead of forwarding partial escape bytes", async () => {
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new FakeTtyInput() as unknown as NodeJS.ReadStream;
    const output = { write: vi.fn(), columns: 80, rows: 24 } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachSession("setup", {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
      mouse: false,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", JSON.stringify({ type: "attached" }));
    input.emit("data", "a\u001b[<0;10;");
    input.emit("data", "20Mbc");
    ControlledWebSocket.last?.emit("close");

    await expect(attached).resolves.toEqual({ detached: true });
    expect(ControlledWebSocket.last?.sent.map((frame) => JSON.parse(frame))).toEqual([
      { type: "resize", cols: 80, rows: 24 },
      { type: "input", data: "a" },
      { type: "input", data: "bc" },
    ]);
  });
});
