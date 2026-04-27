import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createShellClient } from "../../packages/sync-client/src/cli/shell-client.js";

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
      "http://gateway/api/sessions",
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

  it("builds authenticated terminal websocket URLs for attach", () => {
    const client = createShellClient({
      gatewayUrl: "https://gateway.example",
      token: "tok",
    });

    expect(client.createAttachUrl("main", { fromSeq: 7 })).toBe(
      "wss://gateway.example/ws/terminal?session=main&fromSeq=7",
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
    class ControlledWebSocket {
      static last: ControlledWebSocket | null = null;
      listeners = new Map<string, (...args: unknown[]) => void>();
      sent: string[] = [];

      constructor() {
        ControlledWebSocket.last = this;
      }

      send(data: string) {
        this.sent.push(data);
      }

      close() {
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
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 5 });
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
    ControlledWebSocket.last?.emit("close");

    await expect(attached).resolves.toEqual({ detached: true });
  });

  it("queues stdin frames until the websocket is open", async () => {
    class ControlledWebSocket {
      static last: ControlledWebSocket | null = null;
      listeners = new Map<string, (...args: unknown[]) => void>();
      sent: string[] = [];

      constructor() {
        ControlledWebSocket.last = this;
      }

      send(data: string) {
        this.sent.push(data);
      }

      close() {
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
    ControlledWebSocket.last?.emit("close");
    await expect(attached).resolves.toEqual({ detached: true });
  });
});
