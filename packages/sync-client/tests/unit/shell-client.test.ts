import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createShellClient,
  SHELL_ATTACH_LIVE_TAIL_FROM_SEQ,
} from "../../src/cli/shell-client.js";

class FakeWebSocket extends EventEmitter {
  static last: FakeWebSocket | null = null;
  static instances: FakeWebSocket[] = [];

  url: string;
  sent: string[] = [];
  closed = false;

  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.last = this;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }
}

async function waitForFakeSocketCount(expectedCount: number): Promise<void> {
  const deadline = Date.now() + 250;
  while (FakeWebSocket.instances.length < expectedCount) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${expectedCount} fake WebSocket instances; saw ${FakeWebSocket.instances.length}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 1);
    });
  }
}

describe("createShellClient attachSession", () => {
  beforeEach(() => {
    FakeWebSocket.last = null;
    FakeWebSocket.instances = [];
  });

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

    FakeWebSocket.last?.emit("message", JSON.stringify({ type: "exit" }));
    await expect(attach).resolves.toEqual({ detached: false });
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

    expect(FakeWebSocket.last?.url).toContain(`fromSeq=${SHELL_ATTACH_LIVE_TAIL_FROM_SEQ}`);

    FakeWebSocket.last?.emit("message", JSON.stringify({ type: "attached" }));
    FakeWebSocket.last?.emit("message", JSON.stringify({ type: "exit" }));
    await expect(attach).resolves.toEqual({ detached: false });
  });

  it("reconnects on unexpected close after attach instead of resolving detached", async () => {
    const client = createShellClient({
      gatewayUrl: "https://matrix.example",
      token: "token-123",
      timeoutMs: 100,
    });

    const attach = client.attachSession("main", {
      input: new PassThrough() as NodeJS.ReadStream,
      output: new PassThrough() as NodeJS.WriteStream,
      errorOutput: new PassThrough() as NodeJS.WriteStream,
      WebSocketImpl: FakeWebSocket as never,
      heartbeatIntervalMs: 0,
      reconnectBaseDelayMs: 1,
      reconnectMaxDelayMs: 1,
    });

    const firstSocket = FakeWebSocket.last;
    firstSocket?.emit("message", JSON.stringify({ type: "attached" }));
    firstSocket?.emit("close");

    await waitForFakeSocketCount(2);

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[0]).toBe(firstSocket);
    expect(FakeWebSocket.instances[1]?.url).toContain(`fromSeq=${SHELL_ATTACH_LIVE_TAIL_FROM_SEQ}`);

    const result = await Promise.race([
      attach.then((value) => ({ status: "settled" as const, value })),
      new Promise<{ status: "pending" }>((resolve) => {
        setTimeout(() => resolve({ status: "pending" }), 10);
      }),
    ]);
    expect(result).toEqual({ status: "pending" });

    FakeWebSocket.last?.emit("message", JSON.stringify({ type: "attached" }));
    FakeWebSocket.last?.emit("message", JSON.stringify({ type: "exit" }));
    await expect(attach).resolves.toEqual({ detached: false });
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
    process.emit("SIGINT", "SIGINT");

    expect(FakeWebSocket.last?.closed).toBe(false);
    expect(FakeWebSocket.last?.sent.filter((frame) => frame === JSON.stringify({ type: "input", data: "\u0003" }))).toHaveLength(2);

    FakeWebSocket.last?.emit("message", JSON.stringify({ type: "exit" }));
    await expect(attach).resolves.toEqual({ detached: false });
  });

  it("detaches cleanly on SIGTERM after attach", async () => {
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
    process.emit("SIGTERM", "SIGTERM");

    await expect(attach).resolves.toEqual({ detached: true });
    expect(FakeWebSocket.last?.sent).toContain(JSON.stringify({ type: "detach" }));
    expect(FakeWebSocket.last?.sent).not.toContain(JSON.stringify({ type: "input", data: "\u0003" }));
    expect(FakeWebSocket.last?.closed).toBe(true);
    expect(input.setRawMode).toHaveBeenCalledWith(false);
    expect(input.pause).toHaveBeenCalled();
  });

  it("sends one-shot input to an attached shell session", async () => {
    const client = createShellClient({
      gatewayUrl: "https://matrix.example",
      token: "token-123",
      timeoutMs: 100,
    });

    const sent = client.sendInput("main", "\x1b[200~~/data/terminal-paste/paste.png\x1b[201~", {
      WebSocketImpl: FakeWebSocket as never,
    });

    expect(FakeWebSocket.last?.url).toContain("/ws/terminal/session");
    expect(FakeWebSocket.last?.url).toContain("session=main");
    FakeWebSocket.last?.emit("message", JSON.stringify({ type: "attached" }));

    await expect(sent).resolves.toBeUndefined();
    expect(FakeWebSocket.last?.sent).toEqual([
      JSON.stringify({ type: "input", data: "\x1b[200~~/data/terminal-paste/paste.png\x1b[201~" }),
      JSON.stringify({ type: "detach" }),
    ]);
    expect(FakeWebSocket.last?.closed).toBe(true);
  });

});
