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

function sentInputData(): string[] {
  return FakeWebSocket.last?.sent
    .map((frame) => JSON.parse(frame) as { type?: unknown; data?: unknown })
    .filter((frame) => frame.type === "input" && typeof frame.data === "string")
    .map((frame) => frame.data as string) ?? [];
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

  it("rewrites rich paste text before sending terminal input frames", async () => {
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
    const rewriter = {
      rewrite: vi.fn(async () => ({
        status: "rewritten" as const,
        outgoingText: '"/home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/upload.png" what about this?',
        assets: [],
      })),
    };
    const client = createShellClient({
      gatewayUrl: "https://matrix.example",
      token: "token-123",
      timeoutMs: 100,
    });

    const attach = client.attachSession("main", {
      input,
      output,
      WebSocketImpl: FakeWebSocket as never,
      richPaste: { rewriter },
    });

    FakeWebSocket.last?.emit("message", JSON.stringify({ type: "attached" }));
    input.write('"/var/folders/t5/Screenshot 2026-07-08 at 10.31.00.png" what about this?');

    const deadline = Date.now() + 250;
    while (!FakeWebSocket.last?.sent.some((frame) => frame.includes(".matrix-terminal-pastes"))) {
      if (Date.now() > deadline) {
        break;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 1);
      });
    }

    expect(rewriter.rewrite).toHaveBeenCalledWith({
      sessionName: "main",
      text: '"/var/folders/t5/Screenshot 2026-07-08 at 10.31.00.png" what about this?',
      observablePaste: false,
    });
    expect(FakeWebSocket.last?.sent).toContain(JSON.stringify({
      type: "input",
      data: '"/home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/upload.png" what about this?',
    }));
    expect(FakeWebSocket.last?.sent.join("\n")).not.toContain("/var/folders/t5");

    FakeWebSocket.last?.emit("message", JSON.stringify({ type: "exit" }));
    await expect(attach).resolves.toEqual({ detached: false });
  });

  it("treats bracketed paste text as one observable rich paste transaction", async () => {
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

    const rewriter = {
      rewrite: vi.fn(async () => ({
        status: "rewritten" as const,
        outgoingText: "remote paste text",
        assets: [],
      })),
    };
    const client = createShellClient({
      gatewayUrl: "https://matrix.example",
      token: "token-123",
      timeoutMs: 100,
    });
    const attach = client.attachSession("main", {
      input,
      output: new PassThrough(),
      WebSocketImpl: FakeWebSocket as never,
      richPaste: { rewriter },
    });

    FakeWebSocket.last?.emit("message", JSON.stringify({ type: "attached" }));
    input.write("\u001b[200~/var/folders/t5/screen.png what about this?\u001b[201~");

    const deadline = Date.now() + 250;
    while (!FakeWebSocket.last?.sent.some((frame) => frame.includes("remote paste text"))) {
      if (Date.now() > deadline) break;
      await new Promise((resolve) => {
        setTimeout(resolve, 1);
      });
    }

    expect(rewriter.rewrite).toHaveBeenCalledWith({
      sessionName: "main",
      text: "/var/folders/t5/screen.png what about this?",
      observablePaste: true,
    });
    expect(FakeWebSocket.last?.sent).toContain(JSON.stringify({
      type: "input",
      data: "remote paste text",
    }));

    FakeWebSocket.last?.emit("message", JSON.stringify({ type: "exit" }));
    await expect(attach).resolves.toEqual({ detached: false });
  });

  it("keeps later input queued behind an in-flight rich paste rewrite", async () => {
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

    let finishRewrite!: (value: {
      status: "rewritten";
      outgoingText: string;
      assets: [];
    }) => void;
    const rewritePromise = new Promise<{
      status: "rewritten";
      outgoingText: string;
      assets: [];
    }>((resolve) => {
      finishRewrite = resolve;
    });
    const rewriter = {
      rewrite: vi.fn(() => rewritePromise),
    };
    const client = createShellClient({
      gatewayUrl: "https://matrix.example",
      token: "token-123",
      timeoutMs: 100,
    });
    const attach = client.attachSession("main", {
      input,
      output: new PassThrough(),
      WebSocketImpl: FakeWebSocket as never,
      richPaste: { rewriter },
    });

    FakeWebSocket.last?.emit("message", JSON.stringify({ type: "attached" }));
    input.write("/var/folders/t5/screen.png");
    input.write("\r");
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });

    expect(sentInputData()).toEqual([]);

    finishRewrite({
      status: "rewritten",
      outgoingText: "/home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/screen.png",
      assets: [],
    });
    const deadline = Date.now() + 250;
    while (sentInputData().length < 2) {
      if (Date.now() > deadline) break;
      await new Promise((resolve) => {
        setTimeout(resolve, 1);
      });
    }

    expect(sentInputData()).toEqual([
      "/home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/screen.png",
      "\r",
    ]);

    FakeWebSocket.last?.emit("message", JSON.stringify({ type: "exit" }));
    await expect(attach).resolves.toEqual({ detached: false });
  });

  it("buffers bracketed paste markers split across stdin chunks", async () => {
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

    const rewriter = {
      rewrite: vi.fn(async () => ({
        status: "rewritten" as const,
        outgoingText: "remote paste text",
        assets: [],
      })),
    };
    const client = createShellClient({
      gatewayUrl: "https://matrix.example",
      token: "token-123",
      timeoutMs: 100,
    });
    const attach = client.attachSession("main", {
      input,
      output: new PassThrough(),
      WebSocketImpl: FakeWebSocket as never,
      richPaste: { rewriter },
    });

    FakeWebSocket.last?.emit("message", JSON.stringify({ type: "attached" }));
    input.write("\u001b[200~");
    input.write("/var/folders/t5/screen.png");
    input.write(" what about this?\u001b[201~");

    const deadline = Date.now() + 250;
    while (!FakeWebSocket.last?.sent.some((frame) => frame.includes("remote paste text"))) {
      if (Date.now() > deadline) break;
      await new Promise((resolve) => {
        setTimeout(resolve, 1);
      });
    }

    expect(rewriter.rewrite).toHaveBeenCalledWith({
      sessionName: "main",
      text: "/var/folders/t5/screen.png what about this?",
      observablePaste: true,
    });
    expect(sentInputData()).toEqual(["remote paste text"]);
    expect(FakeWebSocket.last?.sent.join("\n")).not.toContain("\u001b[200~");
    expect(FakeWebSocket.last?.sent.join("\n")).not.toContain("\u001b[201~");

    FakeWebSocket.last?.emit("message", JSON.stringify({ type: "exit" }));
    await expect(attach).resolves.toEqual({ detached: false });
  });

  it("recovers after an incomplete bracketed paste without forwarding paste control bytes", async () => {
    vi.useFakeTimers();
    try {
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
      const errorOutput = new PassThrough();
      const errors: string[] = [];
      errorOutput.on("data", (chunk) => errors.push(String(chunk)));

      const rewriter = {
        rewrite: vi.fn(async () => ({
          status: "rewritten" as const,
          outgoingText: "remote paste text",
          assets: [],
        })),
      };
      const client = createShellClient({
        gatewayUrl: "https://matrix.example",
        token: "token-123",
        timeoutMs: 100,
      });
      const attach = client.attachSession("main", {
        input,
        output: new PassThrough(),
        errorOutput: errorOutput as NodeJS.WriteStream,
        WebSocketImpl: FakeWebSocket as never,
        richPaste: { rewriter },
      });

      FakeWebSocket.last?.emit("message", JSON.stringify({ type: "attached" }));
      input.write("\u001b[200~/var/folders/t5/screen.png\u001b[201");
      await vi.advanceTimersByTimeAsync(300);
      input.write("~pwd\r");

      expect(errors.join("")).toContain("Image paste failed: paste did not complete.");
      expect(rewriter.rewrite).not.toHaveBeenCalled();
      expect(sentInputData()).toEqual(["pwd\r"]);
      expect(FakeWebSocket.last?.sent.join("\n")).not.toContain("\u001b[200~");
      expect(FakeWebSocket.last?.sent.join("\n")).not.toContain("/var/folders/t5");

      FakeWebSocket.last?.emit("message", JSON.stringify({ type: "exit" }));
      await expect(attach).resolves.toEqual({ detached: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses observable empty bracketed paste events for image-only clipboard fallback", async () => {
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

    const rewriter = {
      rewrite: vi.fn(async () => ({
        status: "rewritten" as const,
        outgoingText: "Please inspect this image: /home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/clipboard.png",
        assets: [],
      })),
    };
    const client = createShellClient({
      gatewayUrl: "https://matrix.example",
      token: "token-123",
      timeoutMs: 100,
    });
    const attach = client.attachSession("main", {
      input,
      output: new PassThrough(),
      WebSocketImpl: FakeWebSocket as never,
      richPaste: { rewriter },
    });

    FakeWebSocket.last?.emit("message", JSON.stringify({ type: "attached" }));
    input.write("\u001b[200~\u001b[201~");

    const deadline = Date.now() + 250;
    while (!FakeWebSocket.last?.sent.some((frame) => frame.includes("Please inspect this image"))) {
      if (Date.now() > deadline) break;
      await new Promise((resolve) => {
        setTimeout(resolve, 1);
      });
    }

    expect(rewriter.rewrite).toHaveBeenCalledWith({
      sessionName: "main",
      text: "",
      observablePaste: true,
    });
    expect(FakeWebSocket.last?.sent).toContain(JSON.stringify({
      type: "input",
      data: "Please inspect this image: /home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/clipboard.png",
    }));

    FakeWebSocket.last?.emit("message", JSON.stringify({ type: "exit" }));
    await expect(attach).resolves.toEqual({ detached: false });
  });

  it("prints safe local feedback and sends no local image path when rich paste fails", async () => {
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
    const errorOutput = new PassThrough();
    const errors: string[] = [];
    errorOutput.on("data", (chunk) => errors.push(String(chunk)));
    const rewriter = {
      rewrite: vi.fn(async () => ({
        status: "failed" as const,
        assets: [],
        failureCode: "upload_failed" as const,
        localMessage: "Image paste failed: upload did not complete.",
      })),
    };
    const client = createShellClient({
      gatewayUrl: "https://matrix.example",
      token: "token-123",
      timeoutMs: 100,
    });
    const attach = client.attachSession("main", {
      input,
      output: new PassThrough(),
      errorOutput: errorOutput as NodeJS.WriteStream,
      WebSocketImpl: FakeWebSocket as never,
      richPaste: { rewriter },
    });

    FakeWebSocket.last?.emit("message", JSON.stringify({ type: "attached" }));
    input.write("/var/folders/t5/screen.png what about this?");

    const deadline = Date.now() + 250;
    while (!errors.join("").includes("Image paste failed")) {
      if (Date.now() > deadline) break;
      await new Promise((resolve) => {
        setTimeout(resolve, 1);
      });
    }

    expect(errors.join("")).toContain("Image paste failed: upload did not complete.");
    expect(FakeWebSocket.last?.sent.join("\n")).not.toContain("/var/folders/t5");

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

  it("sends one-shot input over HTTP without opening a websocket attach", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    const client = createShellClient({
      gatewayUrl: "https://matrix.example",
      token: "token-123",
      fetch: fetchImpl,
      timeoutMs: 100,
    });

    await expect(client.sendInput("main", "\x1b[200~~/data/terminal-paste/paste.png\x1b[201~")).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://matrix.example/api/terminal/sessions/main/input",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer token-123",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ data: "\x1b[200~~/data/terminal-paste/paste.png\x1b[201~" }),
      }),
    );
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

});
