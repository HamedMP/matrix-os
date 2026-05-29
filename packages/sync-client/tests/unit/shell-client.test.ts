import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createShellClient } from "../../src/cli/shell-client.js";

class FakeWebSocket extends EventEmitter {
  static last: FakeWebSocket | null = null;

  url: string;
  sent: string[] = [];
  closed = false;

  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.last = this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }
}

describe("createShellClient attachSession", () => {
  it("detaches on raw Ctrl-C before the websocket has attached", async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY: true;
      rows: number;
      columns: number;
      setRawMode: ReturnType<typeof vi.fn>;
      pause: ReturnType<typeof vi.fn>;
    };
    input.isTTY = true;
    input.rows = 24;
    input.columns = 80;
    input.setRawMode = vi.fn();
    input.pause = vi.fn();

    const output = new PassThrough();
    const client = createShellClient({
      gatewayUrl: "https://matrix.example",
      token: "token-123",
      timeoutMs: 100,
    });

    const attach = client.attachSession("main", {
      input,
      output,
      WebSocketImpl: FakeWebSocket as never,
    });

    input.write("\u0003");

    const result = await Promise.race([
      attach.then((value) => ({ status: "settled" as const, value })),
      new Promise<{ status: "pending" }>((resolve) => {
        setTimeout(() => resolve({ status: "pending" }), 25);
      }),
    ]);

    expect(result).toEqual({ status: "settled", value: { detached: true } });
    expect(FakeWebSocket.last?.closed).toBe(true);
    expect(input.setRawMode).toHaveBeenCalledWith(false);
    expect(input.pause).toHaveBeenCalled();
  });

  it("forwards raw Ctrl-C after attach so remote programs can handle interrupts", async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY: true;
      rows: number;
      columns: number;
      setRawMode: ReturnType<typeof vi.fn>;
      pause: ReturnType<typeof vi.fn>;
    };
    input.isTTY = true;
    input.rows = 24;
    input.columns = 80;
    input.setRawMode = vi.fn();
    input.pause = vi.fn();

    const output = new PassThrough();
    const client = createShellClient({
      gatewayUrl: "https://matrix.example",
      token: "token-123",
      timeoutMs: 100,
    });

    const attach = client.attachSession("main", {
      input,
      output,
      WebSocketImpl: FakeWebSocket as never,
    });

    FakeWebSocket.last?.emit("message", JSON.stringify({ type: "attached" }));
    input.write("\u0003");

    expect(FakeWebSocket.last?.closed).toBe(false);
    expect(FakeWebSocket.last?.sent).toContain(JSON.stringify({ type: "input", data: "\u0003" }));

    FakeWebSocket.last?.emit("close");
    await attach;
  });

  it("uses live tail by default so attach does not replay stale full-screen frames", async () => {
    const client = createShellClient({
      gatewayUrl: "https://matrix.example",
      token: "token-123",
      timeoutMs: 100,
    });

    const attach = client.attachSession("main", {
      input: new PassThrough() as NodeJS.ReadStream,
      output: new PassThrough() as NodeJS.WriteStream,
      WebSocketImpl: FakeWebSocket as never,
    });

    FakeWebSocket.last?.emit("close");
    await attach;

    expect(FakeWebSocket.last?.url).toContain(`fromSeq=${Number.MAX_SAFE_INTEGER}`);
  });

  it("forwards SIGINT after attach so terminals that still emit signals can interrupt remote programs", async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY: true;
      rows: number;
      columns: number;
      setRawMode: ReturnType<typeof vi.fn>;
      pause: ReturnType<typeof vi.fn>;
    };
    input.isTTY = true;
    input.rows = 24;
    input.columns = 80;
    input.setRawMode = vi.fn();
    input.pause = vi.fn();

    const output = new PassThrough();
    const client = createShellClient({
      gatewayUrl: "https://matrix.example",
      token: "token-123",
      timeoutMs: 100,
    });

    const attach = client.attachSession("main", {
      input,
      output,
      WebSocketImpl: FakeWebSocket as never,
    });

    FakeWebSocket.last?.emit("message", JSON.stringify({ type: "attached" }));
    process.emit("SIGINT", "SIGINT");

    expect(FakeWebSocket.last?.closed).toBe(false);
    expect(FakeWebSocket.last?.sent).toContain(JSON.stringify({ type: "input", data: "\u0003" }));

    FakeWebSocket.last?.emit("close");
    await attach;
  });
});
