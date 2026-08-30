import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createShellClient,
  SHELL_ATTACH_LIVE_TAIL_FROM_SEQ,
  SHELL_ATTACH_MAX_QUEUED_BYTES,
} from "../../packages/sync-client/src/cli/shell-client.js";

const LOCAL_TERMINAL_INPUT_RESET = "\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1006l\u001b[?1015l\u001b[?1004l\u001b[?2004l\u001b[>4;0m\u001b[<1u";
const TERMINAL_REF = {
  workspaceId: "tws_00000000000000000000000000000001",
  tabId: "tt_00000000000000000000000000000001",
} as const;
const WS_ATTACH_BASE = `ws://gateway/ws/terminal/tab?workspaceId=${TERMINAL_REF.workspaceId}&tabId=${TERMINAL_REF.tabId}&client=cli`;
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const roots: string[] = [];

function serverFrame(
  type: "attached" | "output" | "exit" | "pong" | "error",
  fields: Record<string, unknown> = {},
): string {
  if (type === "error") {
    return JSON.stringify({ type, terminalRef: TERMINAL_REF, code: "attach_failed", message: "Terminal unavailable", ...fields });
  }
  const defaults = type === "attached"
    ? { canonicalSize: { cols: 80, rows: 24 }, nextSeq: 0 }
    : type === "exit"
      ? { exitCode: null }
      : type === "output"
        ? { seq: 0, data: "output" }
        : {};
  return JSON.stringify({ type, terminalRef: TERMINAL_REF, revision: 1, ...defaults, ...fields });
}

class ControlledWebSocket {
  static last: ControlledWebSocket | null = null;
  static lastUrl: string | null = null;
  static lastOptions: unknown = null;
  static instances: ControlledWebSocket[] = [];
  closed = false;
  listeners = new Map<string, (...args: unknown[]) => void>();
  sent: string[] = [];

  constructor(url: string, options?: unknown) {
    ControlledWebSocket.last = this;
    ControlledWebSocket.lastUrl = url;
    ControlledWebSocket.lastOptions = options;
    ControlledWebSocket.instances.push(this);
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

function comparableFrames(socket: ControlledWebSocket | null | undefined = ControlledWebSocket.last): Array<Record<string, unknown>> {
  return (socket?.sent ?? []).map((raw) => {
    const { terminalRef: _terminalRef, ...frame } = JSON.parse(raw) as Record<string, unknown>;
    if (frame.type === "resize" && frame.size && typeof frame.size === "object") {
      const size = frame.size as { cols?: unknown; rows?: unknown };
      return { type: "resize", cols: size.cols, rows: size.rows };
    }
    return frame;
  });
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
  beforeEach(() => {
    ControlledWebSocket.last = null;
    ControlledWebSocket.lastUrl = null;
    ControlledWebSocket.lastOptions = null;
    ControlledWebSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    return Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("lists workspaces with bearer auth, JSON parsing, and fetch timeout", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ workspaces: [] })));
    const client = createShellClient({
      gatewayUrl: "http://gateway",
      token: "tok",
      fetch: fetchImpl,
    });

    await expect(client.listWorkspaces()).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://gateway/api/terminal/workspaces",
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

    await expect(client.terminateTab(TERMINAL_REF)).rejects.toMatchObject({
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

    await expect(client.listWorkspaces()).rejects.toMatchObject({
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

    await expect(client.listWorkspaces()).rejects.toMatchObject({
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

    await expect(client.listWorkspaces()).rejects.toMatchObject({
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

    await expect(client.listWorkspaces()).rejects.toMatchObject({
      code: "request_failed",
      message: "Request failed",
    });
  });

  it("builds terminal websocket URLs without leaking bearer auth by default", () => {
    const client = createShellClient({
      gatewayUrl: "https://gateway.example",
      token: "tok",
    });

    expect(client.createAttachUrl(TERMINAL_REF, { fromSeq: 7 })).toBe(
      `wss://gateway.example/ws/terminal/tab?workspaceId=${TERMINAL_REF.workspaceId}&tabId=${TERMINAL_REF.tabId}&client=cli&fromSeq=7`,
    );
  });

  it("supports explicit terminal websocket query tokens for browser clients", () => {
    const client = createShellClient({
      gatewayUrl: "https://gateway.example",
      token: "bearer-token",
    });

    expect(client.createAttachUrl(TERMINAL_REF, { token: "query-token" })).toBe(
      `wss://gateway.example/ws/terminal/tab?workspaceId=${TERMINAL_REF.workspaceId}&tabId=${TERMINAL_REF.tabId}&client=cli&token=query-token`,
    );
  });

  it("terminates one tab without deleting its workspace", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    const client = createShellClient({
      gatewayUrl: "http://gateway",
      token: "tok",
      fetch: fetchImpl,
    });

    await expect(client.terminateTab(TERMINAL_REF)).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledWith(
      `http://gateway/api/terminal/workspaces/${TERMINAL_REF.workspaceId}/tabs/${TERMINAL_REF.tabId}`,
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          Authorization: "Bearer tok",
        }),
      }),
    );
    expect(ControlledWebSocket.instances).toHaveLength(0);
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

    await expect(client.attachTab(TERMINAL_REF, {
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

    const attached = client.attachTab(TERMINAL_REF, {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
    });
    ControlledWebSocket.last?.emit("open");
    await new Promise((resolve) => setTimeout(resolve, 10));
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));
    ControlledWebSocket.last?.emit("message", serverFrame("exit", { exitCode: 0 }));

    await expect(attached).resolves.toEqual({ detached: false, exitCode: 0 });
    expect(ControlledWebSocket.lastUrl).toBe(
      `${WS_ATTACH_BASE}&fromSeq=${SHELL_ATTACH_LIVE_TAIL_FROM_SEQ}`,
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

    const attached = client.attachTab(TERMINAL_REF, {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
      fromSeq: 0,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));
    ControlledWebSocket.last?.emit("message", serverFrame("exit", { exitCode: 0 }));

    await expect(attached).resolves.toEqual({ detached: false, exitCode: 0 });
    expect(ControlledWebSocket.lastUrl).toBe(`${WS_ATTACH_BASE}&fromSeq=0`);
  });

  it("rejects attach when the websocket closes before an attached, error, or exit frame", async () => {
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new EventEmitter() as NodeJS.ReadStream;
    const output = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachTab(TERMINAL_REF, {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("close");

    await expect(attached).rejects.toMatchObject({ code: "attach_failed" });
  });

  it("sends heartbeat pings and accepts pong frames while attached", async () => {
    vi.useFakeTimers();
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new EventEmitter() as NodeJS.ReadStream;
    const output = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachTab(TERMINAL_REF, {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
      heartbeatIntervalMs: 20,
      heartbeatTimeoutMs: 60,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));

    await vi.advanceTimersByTimeAsync(20);
    expect(comparableFrames()).toContainEqual({ type: "ping" });
    ControlledWebSocket.last?.emit("message", serverFrame("pong"));
    await vi.advanceTimersByTimeAsync(19);
    expect(ControlledWebSocket.instances).toHaveLength(1);

    ControlledWebSocket.last?.emit("message", serverFrame("exit", { exitCode: 0 }));
    await expect(attached).resolves.toEqual({ detached: false, exitCode: 0 });
  });

  it("keeps the socket open across repeated heartbeat pongs", async () => {
    vi.useFakeTimers();
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new EventEmitter() as NodeJS.ReadStream;
    const output = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachTab(TERMINAL_REF, {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
      heartbeatIntervalMs: 20,
      heartbeatTimeoutMs: 60,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));

    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(20);
      ControlledWebSocket.last?.emit("message", serverFrame("pong"));
    }
    await vi.advanceTimersByTimeAsync(59);

    expect(ControlledWebSocket.instances).toHaveLength(1);
    expect(ControlledWebSocket.last?.closed).toBe(false);
    ControlledWebSocket.last?.emit("message", serverFrame("exit", { exitCode: 0 }));
    await expect(attached).resolves.toEqual({ detached: false, exitCode: 0 });
  });

  it("closes and reconnects after consecutive missed heartbeat pongs or output", async () => {
    vi.useFakeTimers();
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new EventEmitter() as NodeJS.ReadStream;
    const output = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachTab(TERMINAL_REF, {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
      heartbeatIntervalMs: 20,
      heartbeatTimeoutMs: 60,
      reconnectBaseDelayMs: 5,
      reconnectMaxDelayMs: 5,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));
    const first = ControlledWebSocket.last!;

    await vi.advanceTimersByTimeAsync(80);
    expect(first.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(80);
    expect(first.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(5);

    expect(ControlledWebSocket.instances).toHaveLength(2);
    expect(errorOutput.write).not.toHaveBeenCalledWith("\r\nConnection lost. Reconnecting...\r\n");
    expect(output.write).not.toHaveBeenCalledWith(expect.stringContaining("Matrix shell disconnected"));
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));
    const second = ControlledWebSocket.last!;
    expect(errorOutput.write).not.toHaveBeenCalledWith("\r\nConnection restored.\r\n");
    expect(output.write).not.toHaveBeenCalledWith(expect.stringContaining("\u001b[1A"));
    expect(output.write).not.toHaveBeenCalledWith(expect.stringContaining("connection restored"));
    await vi.advanceTimersByTimeAsync(80);
    expect(second.closed).toBe(false);
    ControlledWebSocket.last?.emit("message", serverFrame("exit", { exitCode: 0 }));
    await expect(attached).resolves.toEqual({ detached: false, exitCode: 0 });
  });

  it("keeps reconnect lifecycle notices out of the terminal byte stream", async () => {
    vi.useFakeTimers();
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new EventEmitter() as NodeJS.ReadStream;
    const output = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachTab(TERMINAL_REF, {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
      reconnectBaseDelayMs: 5,
      reconnectMaxDelayMs: 5,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));
    ControlledWebSocket.last?.emit("close");
    await vi.advanceTimersByTimeAsync(5);

    expect(output.write).not.toHaveBeenCalledWith(expect.stringContaining("Matrix shell disconnected"));
    expect(errorOutput.write).not.toHaveBeenCalledWith("\r\nConnection lost. Reconnecting...\r\n");

    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));

    expect(output.write).not.toHaveBeenCalledWith("\r\u001b[2K\u001b[1A\r\u001b[2K\u001b[1A\r\u001b[2K");
    expect(errorOutput.write).not.toHaveBeenCalledWith("\r\nConnection restored.\r\n");
    ControlledWebSocket.last?.emit("message", serverFrame("exit", { exitCode: 0 }));
    await expect(attached).resolves.toEqual({ detached: false, exitCode: 0 });
  });

  it("ignores stale socket events after a reconnect owns the attach", async () => {
    vi.useFakeTimers();
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new EventEmitter() as NodeJS.ReadStream;
    const output = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachTab(TERMINAL_REF, {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
      reconnectBaseDelayMs: 5,
      reconnectMaxDelayMs: 5,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));
    ControlledWebSocket.last?.emit("message", serverFrame("output", { data: "ready", seq: 41 }));
    const first = ControlledWebSocket.last!;
    const staleMessage = first.listeners.get("message");
    const staleError = first.listeners.get("error");

    first.emit("close");
    await vi.advanceTimersByTimeAsync(5);
    const second = ControlledWebSocket.last!;
    second.emit("open");
    second.emit("message", serverFrame("attached"));

    staleMessage?.(serverFrame("output", { data: "stale", seq: 0 }));
    staleError?.(new Error("WebSocket was closed before the connection was established"));

    expect(output.write).toHaveBeenCalledWith("ready");
    expect(output.write).not.toHaveBeenCalledWith("stale");
    expect(second.closed).toBe(false);

    second.emit("close");
    await vi.advanceTimersByTimeAsync(5);
    expect(ControlledWebSocket.lastUrl).toBe(`${WS_ATTACH_BASE}&fromSeq=42`);

    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));
    ControlledWebSocket.last?.emit("message", serverFrame("exit", { exitCode: 0 }));
    await expect(attached).resolves.toEqual({ detached: false, exitCode: 0 });
  });

  it("reconnects instead of resolving detached after an unexpected close once attached", async () => {
    vi.useFakeTimers();
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new EventEmitter() as NodeJS.ReadStream;
    const output = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachTab(TERMINAL_REF, {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
      reconnectBaseDelayMs: 5,
      reconnectMaxDelayMs: 5,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));
    ControlledWebSocket.last?.emit("close");
    await vi.advanceTimersByTimeAsync(5);

    expect(ControlledWebSocket.instances).toHaveLength(2);
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));
    ControlledWebSocket.last?.emit("message", serverFrame("exit", { exitCode: 0 }));
    await expect(attached).resolves.toEqual({ detached: false, exitCode: 0 });
  });

  it("keeps retrying when a reconnect attempt times out", async () => {
    vi.useFakeTimers();
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new EventEmitter() as NodeJS.ReadStream;
    const output = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachTab(TERMINAL_REF, {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
      fromSeq: 0,
      reconnectBaseDelayMs: 5,
      reconnectMaxDelayMs: 5,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));
    ControlledWebSocket.last?.emit("close");
    await vi.advanceTimersByTimeAsync(5);
    const timedOutReconnect = ControlledWebSocket.last!;

    await vi.advanceTimersByTimeAsync(50);
    expect(timedOutReconnect.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(5);

    expect(ControlledWebSocket.instances).toHaveLength(3);
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));
    ControlledWebSocket.last?.emit("message", serverFrame("exit", { exitCode: 0 }));
    await expect(attached).resolves.toEqual({ detached: false, exitCode: 0 });
  });

  it("retries transient attach failures after a prior attach", async () => {
    vi.useFakeTimers();
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new EventEmitter() as NodeJS.ReadStream;
    const output = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachTab(TERMINAL_REF, {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
      reconnectBaseDelayMs: 5,
      reconnectMaxDelayMs: 5,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));
    ControlledWebSocket.last?.emit("close");
    await vi.advanceTimersByTimeAsync(5);

    const transientFailure = ControlledWebSocket.last!;
    transientFailure.emit("open");
    transientFailure.emit("message", serverFrame("error", { code: "attach_failed" }));
    expect(transientFailure.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(5);

    expect(ControlledWebSocket.instances).toHaveLength(3);
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));
    ControlledWebSocket.last?.emit("message", serverFrame("exit", { exitCode: 0 }));
    await expect(attached).resolves.toEqual({ detached: false, exitCode: 0 });
  });

  it("reconnects with fromSeq set after the last output sequence", async () => {
    vi.useFakeTimers();
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new EventEmitter() as NodeJS.ReadStream;
    const output = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachTab(TERMINAL_REF, {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
      reconnectBaseDelayMs: 5,
      reconnectMaxDelayMs: 5,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));
    ControlledWebSocket.last?.emit("message", serverFrame("output", { data: "ready", seq: 41 }));
    ControlledWebSocket.last?.emit("close");
    await vi.advanceTimersByTimeAsync(5);

    expect(ControlledWebSocket.lastUrl).toBe(`${WS_ATTACH_BASE}&fromSeq=42`);
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));
    ControlledWebSocket.last?.emit("message", serverFrame("exit", { exitCode: 0 }));
    await expect(attached).resolves.toEqual({ detached: false, exitCode: 0 });
  });

  it("accepts a lower tab revision after reconnecting from a workspace resize revision", async () => {
    vi.useFakeTimers();
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new EventEmitter() as NodeJS.ReadStream;
    const output = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachTab(TERMINAL_REF, {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
      reconnectBaseDelayMs: 5,
      reconnectMaxDelayMs: 5,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached", { revision: 2 }));
    ControlledWebSocket.last?.emit("message", JSON.stringify({
      type: "canonical-size",
      terminalRef: TERMINAL_REF,
      revision: 50,
      canonicalSize: { cols: 120, rows: 40 },
    }));
    ControlledWebSocket.last?.emit("close");
    await vi.advanceTimersByTimeAsync(5);

    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached", { revision: 3 }));
    ControlledWebSocket.last?.emit("message", serverFrame("output", {
      revision: 4,
      seq: 1,
      data: "reconnected",
    }));

    expect(output.write).toHaveBeenCalledWith("reconnected");
    ControlledWebSocket.last?.emit("message", serverFrame("exit", { revision: 51, exitCode: 0 }));
    await expect(attached).resolves.toEqual({ detached: false, exitCode: 0 });
  });

  it("clamps reconnect replay cursors at the maximum safe sequence", async () => {
    vi.useFakeTimers();
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new EventEmitter() as NodeJS.ReadStream;
    const output = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachTab(TERMINAL_REF, {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
      reconnectBaseDelayMs: 5,
      reconnectMaxDelayMs: 5,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));
    ControlledWebSocket.last?.emit("message", JSON.stringify({
      type: "output",
      data: "ready",
      seq: Number.MAX_SAFE_INTEGER,
    }));
    ControlledWebSocket.last?.emit("close");
    await vi.advanceTimersByTimeAsync(5);

    expect(ControlledWebSocket.lastUrl).toBe(
      `${WS_ATTACH_BASE}&fromSeq=${Number.MAX_SAFE_INTEGER}`,
    );
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));
    ControlledWebSocket.last?.emit("message", serverFrame("exit", { exitCode: 0 }));
    await expect(attached).resolves.toEqual({ detached: false, exitCode: 0 });
  });

  it("resends terminal resize after reconnect", async () => {
    vi.useFakeTimers();
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new FakeTtyInput() as unknown as NodeJS.ReadStream;
    const output = { write: vi.fn(), columns: 120, rows: 40 } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachTab(TERMINAL_REF, {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
      reconnectBaseDelayMs: 5,
      reconnectMaxDelayMs: 5,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));
    const first = ControlledWebSocket.last!;
    ControlledWebSocket.last?.emit("close");
    await vi.advanceTimersByTimeAsync(5);
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));

    expect(comparableFrames(first)).toContainEqual({ type: "resize", cols: 120, rows: 40 });
    expect(comparableFrames()).toContainEqual({ type: "resize", cols: 120, rows: 40 });
    ControlledWebSocket.last?.emit("message", serverFrame("exit", { exitCode: 0 }));
    await expect(attached).resolves.toEqual({ detached: false, exitCode: 0 });
  });

  it("allowlists terminal websocket error frame codes", async () => {
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new EventEmitter() as NodeJS.ReadStream;
    const output = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachTab(TERMINAL_REF, {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("error", { code: "internal_path_leak" }));

    await expect(attached).rejects.toMatchObject({ code: "attach_failed" });
  });

  it("distinguishes remote exit from explicit local detach", async () => {
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new EventEmitter() as NodeJS.ReadStream;
    const output = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachTab(TERMINAL_REF, {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));
    ControlledWebSocket.last?.emit("message", serverFrame("exit", { exitCode: 0 }));

    await expect(attached).resolves.toEqual({ detached: false, exitCode: 0 });
  });

  it("queues stdin frames until the websocket is open", async () => {
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new EventEmitter() as NodeJS.ReadStream;
    const output = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachTab(TERMINAL_REF, {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
    });
    input.emit("data", "pwd\r");
    expect(ControlledWebSocket.last?.sent).toEqual([]);

    ControlledWebSocket.last?.emit("open");
    expect(comparableFrames()).toEqual([
      { type: "input", data: "pwd\r" },
    ]);
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));
    ControlledWebSocket.last?.emit("message", serverFrame("exit", { exitCode: 0 }));
    await expect(attached).resolves.toEqual({ detached: false, exitCode: 0 });
  });

  it("uploads a pasted quoted macOS screenshot path and sends the VPS terminal path", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-shell-rich-paste-"));
    roots.push(root);
    const imagePath = join(root, "Screenshot 2026-07-07 at 6.50.39 PM.png");
    await writeFile(imagePath, PNG_BYTES, { flag: "wx" });
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === `http://gateway/api/terminal/workspaces/${TERMINAL_REF.workspaceId}/tabs/${TERMINAL_REF.tabId}/paste-assets`) {
        expect(init?.method).toBe("POST");
        expect(init?.headers).toEqual(expect.objectContaining({
          Authorization: "Bearer tok",
          "Content-Type": "application/json",
        }));
        expect(JSON.parse(String(init?.body))).toMatchObject({
          assets: [{ mimeType: "image/png", dataBase64: PNG_BYTES.toString("base64") }],
        });
        return new Response(JSON.stringify({
          assets: [{
            path: "projects/.matrix-terminal-pastes/2026-07-07/upload.png",
            terminalPath: "/home/matrix/home/projects/.matrix-terminal-pastes/2026-07-07/upload.png",
            size: PNG_BYTES.length,
            mimeType: "image/png",
          }],
        }));
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const client = createShellClient({
      gatewayUrl: "http://gateway",
      token: "tok",
      fetch: fetchImpl,
      timeoutMs: 50,
    });
    const input = new FakeTtyInput() as unknown as NodeJS.ReadStream;
    const output = { write: vi.fn(), columns: 80, rows: 24 } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachTab(TERMINAL_REF, {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
      cwd: "projects/app",
      richPaste: { statusMinVisibleMs: 0 },
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));
    input.emit("data", `"${imagePath}"`);
    await vi.waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(comparableFrames()).toContainEqual({
        type: "input",
        data: "\"/home/matrix/home/projects/.matrix-terminal-pastes/2026-07-07/upload.png\"",
      });
    });
    ControlledWebSocket.last?.emit("message", serverFrame("exit", { exitCode: 0 }));

    await expect(attached).resolves.toEqual({ detached: false, exitCode: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(comparableFrames()).toContainEqual({
      type: "input",
      data: "\"/home/matrix/home/projects/.matrix-terminal-pastes/2026-07-07/upload.png\"",
    });
    expect(ControlledWebSocket.last?.sent.join("")).not.toContain(imagePath);
  });

  it("does not intercept local image paths when rich paste is disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-shell-no-rich-paste-"));
    roots.push(root);
    const imagePath = join(root, "Screenshot 2026-07-07 at 6.50.39 PM.png");
    await writeFile(imagePath, PNG_BYTES, { flag: "wx" });
    const fetchImpl = vi.fn(async () => {
      throw new Error("rich paste upload should not run");
    });
    const client = createShellClient({
      gatewayUrl: "http://gateway",
      token: "tok",
      fetch: fetchImpl,
      timeoutMs: 50,
    });
    const input = new FakeTtyInput() as unknown as NodeJS.ReadStream;
    const output = { write: vi.fn(), columns: 80, rows: 24 } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachTab(TERMINAL_REF, {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
      noRichPaste: true,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));
    input.emit("data", `"${imagePath}"`);
    ControlledWebSocket.last?.emit("message", serverFrame("exit", { exitCode: 0 }));

    await expect(attached).resolves.toEqual({ detached: false, exitCode: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(comparableFrames()).toContainEqual({
      type: "input",
      data: `"${imagePath}"`,
    });
  });

  it("chunks oversized terminal input frames below the gateway input cap", async () => {
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new FakeTtyInput() as unknown as NodeJS.ReadStream;
    const output = { write: vi.fn(), columns: 80, rows: 24 } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const largeInput = "x".repeat(140_000);

    const attached = client.attachTab(TERMINAL_REF, {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));
    input.emit("data", largeInput);
    ControlledWebSocket.last?.emit("message", serverFrame("exit", { exitCode: 0 }));

    await expect(attached).resolves.toEqual({ detached: false, exitCode: 0 });
    const inputFrames = comparableFrames()
      .filter((frame) => frame.type === "input") as Array<{ data: string }>;
    expect(inputFrames.length).toBeGreaterThan(1);
    expect(inputFrames.every((frame) => frame.data.length < 65_536)).toBe(true);
    expect(inputFrames.map((frame) => frame.data).join("")).toBe(largeInput);
  });

  it("drops pasted OSC and APC image/control sequences instead of forwarding them as keystrokes", async () => {
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new FakeTtyInput() as unknown as NodeJS.ReadStream;
    const output = { write: vi.fn(), columns: 80, rows: 24 } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachTab(TERMINAL_REF, {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));
    input.emit("data", "a\u001b]1337;File=name=x.png;inline=1:AAAA\u0007b\u001b_Gf=100;AAAA\u001b\\c");
    ControlledWebSocket.last?.emit("message", serverFrame("exit", { exitCode: 0 }));

    await expect(attached).resolves.toEqual({ detached: false, exitCode: 0 });
    expect(comparableFrames()).toContainEqual({
      type: "input",
      data: "abc",
    });
    expect(ControlledWebSocket.last?.sent.join("")).not.toContain("1337;File");
    expect(ControlledWebSocket.last?.sent.join("")).not.toContain("_Gf=100");
  });

  it("rejects when pre-open stdin exceeds the queued frame cap", async () => {
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new EventEmitter() as NodeJS.ReadStream;
    const output = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachTab(TERMINAL_REF, {
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

    const attached = client.attachTab(TERMINAL_REF, {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
    });

    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));
    process.emit("SIGWINCH", "SIGWINCH");
    ControlledWebSocket.last?.emit("message", serverFrame("exit", { exitCode: 0 }));

    await expect(attached).resolves.toEqual({ detached: false, exitCode: 0 });
    expect((input as unknown as FakeTtyInput).rawModes).toEqual([true, false]);
    expect((input as unknown as FakeTtyInput).resumed).toBe(true);
    expect(comparableFrames()).toEqual([
      { type: "resize", cols: 120, rows: 40 },
      { type: "resize", cols: 120, rows: 40 },
    ]);
  });

  it("reserves ctrl-backslash ctrl-backslash for detach without forwarding it to the remote pane", async () => {
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new FakeTtyInput() as unknown as NodeJS.ReadStream;
    const output = { write: vi.fn(), columns: 80, rows: 24 } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachTab(TERMINAL_REF, {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));
    input.emit("data", "a");
    input.emit("data", "\u001c");
    input.emit("data", "b");
    input.emit("data", "\u001c");
    input.emit("data", "\u001c");

    await expect(attached).resolves.toEqual({ detached: true, exitCode: null });
    expect(ControlledWebSocket.last?.closed).toBe(true);
    expect(errorOutput.write).not.toHaveBeenCalledWith("\r\nConnection lost. Reconnecting...\r\n");
    expect(comparableFrames()).toEqual([
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

    const attached = client.attachTab(TERMINAL_REF, {
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

    const attached = client.attachTab(TERMINAL_REF, {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
      mouse: false,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));
    input.emit("data", "a\u001b[<0;10;20M\u001b[Mabc\u001b[I\u001b[O");
    ControlledWebSocket.last?.emit("message", serverFrame("exit", { exitCode: 0 }));

    await expect(attached).resolves.toEqual({ detached: false, exitCode: 0 });
    expect(comparableFrames()).toEqual([
      { type: "resize", cols: 80, rows: 24 },
      { type: "input", data: "a" },
    ]);
  });

  it("drops focus reporting sequences while still dropping mouse input when unfocused", async () => {
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new FakeTtyInput() as unknown as NodeJS.ReadStream;
    const output = { write: vi.fn(), columns: 80, rows: 24 } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachTab(TERMINAL_REF, {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));
    input.emit("data", "\u001b[Ia\u001b[O\u001b[<0;10;20M");
    ControlledWebSocket.last?.emit("message", serverFrame("exit", { exitCode: 0 }));

    await expect(attached).resolves.toEqual({ detached: false, exitCode: 0 });
    expect(comparableFrames()).toEqual([
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

    const attached = client.attachTab(TERMINAL_REF, {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));
    ControlledWebSocket.last?.emit("message", serverFrame("output", { data: "ready" }));
    nowSpy.mockReturnValue(6_000);
    input.emit("data", "\u001b[I\u001b[<0;10;20M\u001b[Mabcx");
    ControlledWebSocket.last?.emit("message", serverFrame("exit", { exitCode: 0 }));

    await expect(attached).resolves.toEqual({ detached: false, exitCode: 0 });
    expect(output.write).toHaveBeenCalledWith(LOCAL_TERMINAL_INPUT_RESET);
    expect(comparableFrames()).toEqual([
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

    const attached = client.attachTab(TERMINAL_REF, {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));
    ControlledWebSocket.last?.emit("message", serverFrame("output", { data: "ready" }));
    nowSpy.mockReturnValue(6_000);
    input.emit("data", "\u001b[I\u001b[99;5u\u001b[100;5uok");
    ControlledWebSocket.last?.emit("message", serverFrame("exit", { exitCode: 0 }));

    await expect(attached).resolves.toEqual({ detached: false, exitCode: 0 });
    expect(output.write).toHaveBeenCalledWith(LOCAL_TERMINAL_INPUT_RESET);
    expect(comparableFrames()).toEqual([
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

    const attached = client.attachTab(TERMINAL_REF, {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));
    input.emit("data", "\u001b[99;5u");
    ControlledWebSocket.last?.emit("message", serverFrame("exit", { exitCode: 0 }));

    await expect(attached).resolves.toEqual({ detached: false, exitCode: 0 });
    expect(comparableFrames()).toEqual([
      { type: "resize", cols: 80, rows: 24 },
      { type: "input", data: "\u001b[99;5u" },
    ]);
  });

  it("buffers fragmented enhanced keyboard protocol sequences", async () => {
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new FakeTtyInput() as unknown as NodeJS.ReadStream;
    const output = { write: vi.fn(), columns: 80, rows: 24 } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachTab(TERMINAL_REF, {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));
    input.emit("data", "a\u001b[99");
    input.emit("data", ";5ub");
    ControlledWebSocket.last?.emit("message", serverFrame("exit", { exitCode: 0 }));

    await expect(attached).resolves.toEqual({ detached: false, exitCode: 0 });
    expect(comparableFrames()).toEqual([
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

    const attached = client.attachTab(TERMINAL_REF, {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
      mouse: false,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));
    input.emit("data", "a\u001b[<0;10;");
    input.emit("data", "20Mbc");
    ControlledWebSocket.last?.emit("message", serverFrame("exit", { exitCode: 0 }));

    await expect(attached).resolves.toEqual({ detached: false, exitCode: 0 });
    expect(comparableFrames()).toEqual([
      { type: "resize", cols: 80, rows: 24 },
      { type: "input", data: "a" },
      { type: "input", data: "bc" },
    ]);
  });

  it("detaches cleanly when attach output hits EPIPE", async () => {
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new EventEmitter() as NodeJS.ReadStream;
    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    const output = {
      write: vi.fn(() => {
        throw epipe;
      }),
    } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachTab(TERMINAL_REF, {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));
    ControlledWebSocket.last?.emit("message", serverFrame("output", { data: "ready", seq: 0 }));

    await expect(attached).resolves.toEqual({ detached: true, exitCode: null });
    expect(ControlledWebSocket.last?.closed).toBe(true);
    expect(errorOutput.write).not.toHaveBeenCalledWith("Shell attach failed\n");
  });

  it("writes local terminal input reset when attach exits", async () => {
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new FakeTtyInput() as unknown as NodeJS.ReadStream;
    const output = { write: vi.fn(), columns: 80, rows: 24 } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachTab(TERMINAL_REF, {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));
    ControlledWebSocket.last?.emit("message", serverFrame("exit", { exitCode: 0 }));

    await expect(attached).resolves.toEqual({ detached: false, exitCode: 0 });
    const resetWrites = vi.mocked(output.write).mock.calls.filter(([data]) => data === LOCAL_TERMINAL_INPUT_RESET);
    expect(resetWrites).toHaveLength(2);
  });

  it("fails attach when local output hits a non-EPIPE stream error", async () => {
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 50 });
    const input = new EventEmitter() as NodeJS.ReadStream;
    const output = {
      write: vi.fn(() => {
        throw Object.assign(new Error("stream failed"), { code: "ERR_STREAM_DESTROYED" });
      }),
    } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const attached = client.attachTab(TERMINAL_REF, {
      WebSocketImpl: ControlledWebSocket,
      input,
      output,
      errorOutput,
    });
    ControlledWebSocket.last?.emit("open");
    ControlledWebSocket.last?.emit("message", serverFrame("attached"));
    ControlledWebSocket.last?.emit("message", serverFrame("output", { data: "ready", seq: 0 }));

    await expect(attached).rejects.toMatchObject({ code: "attach_failed" });
    expect(ControlledWebSocket.last?.closed).toBe(true);
  });
});
