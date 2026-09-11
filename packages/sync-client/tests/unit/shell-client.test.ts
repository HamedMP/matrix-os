import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createShellClient,
  SHELL_ATTACH_LIVE_TAIL_FROM_SEQ,
} from "../../src/cli/shell-client.js";

const TERMINAL_REF = {
  workspaceId: `tws_${"6".repeat(32)}`,
  tabId: `tt_${"7".repeat(32)}`,
};
const TERMINAL_REF_KEY = `${TERMINAL_REF.workspaceId}:${TERMINAL_REF.tabId}`;

function serverFrame(
  type: "attached" | "output" | "exit",
  fields: Record<string, unknown> = {},
): string {
  const defaults = type === "attached"
    ? { canonicalSize: { cols: 80, rows: 24 }, nextSeq: 0 }
    : type === "exit"
      ? { exitCode: null }
      : {};
  return JSON.stringify({
    type,
    terminalRef: TERMINAL_REF,
    revision: 1,
    ...defaults,
    ...fields,
  });
}

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

describe("createShellClient attachTab", () => {
  beforeEach(() => {
    FakeWebSocket.last = null;
    FakeWebSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
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

    const attach = client.attachTab(TERMINAL_REF, {
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

    expect(result).toEqual({ status: "settled", value: { detached: true, exitCode: null } });
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

    const attach = client.attachTab(TERMINAL_REF, {
      input,
      output,
      WebSocketImpl: FakeWebSocket as never,
    });

    FakeWebSocket.last?.emit("message", serverFrame("attached"));
    input.write("\u0003");

    expect(FakeWebSocket.last?.closed).toBe(false);
    expect(FakeWebSocket.last?.sent).toContain(JSON.stringify({ type: "input", terminalRef: TERMINAL_REF, data: "\u0003" }));

    FakeWebSocket.last?.emit("message", serverFrame("exit"));
    await expect(attach).resolves.toEqual({ detached: false, exitCode: null });
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

    const attach = client.attachTab(TERMINAL_REF, {
      input,
      output,
      WebSocketImpl: FakeWebSocket as never,
      richPaste: { rewriter, statusMinVisibleMs: 0 },
    });

    FakeWebSocket.last?.emit("message", serverFrame("attached"));
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
      sessionName: TERMINAL_REF_KEY,
      text: '"/var/folders/t5/Screenshot 2026-07-08 at 10.31.00.png" what about this?',
      observablePaste: false,
    });
    expect(FakeWebSocket.last?.sent).toContain(JSON.stringify({
      type: "input",
      terminalRef: TERMINAL_REF,
      data: '"/home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/upload.png" what about this?',
    }));
    expect(FakeWebSocket.last?.sent.join("\n")).not.toContain("/var/folders/t5");

    FakeWebSocket.last?.emit("message", serverFrame("exit"));
    await expect(attach).resolves.toEqual({ detached: false, exitCode: null });
  });

  it("keeps rich paste progress visible before printing completion and sending rewritten input", async () => {
    vi.useFakeTimers();
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
        outgoingText: "/home/matrix/home/projects/.matrix-terminal-pastes/2026-07-10/upload.png",
        assets: [],
      })),
    };
    const client = createShellClient({
      gatewayUrl: "https://matrix.example",
      token: "token-123",
      timeoutMs: 10_000,
    });
    const attach = client.attachTab(TERMINAL_REF, {
      input,
      output: new PassThrough(),
      errorOutput: errorOutput as NodeJS.WriteStream,
      WebSocketImpl: FakeWebSocket as never,
      richPaste: { rewriter },
    });

    FakeWebSocket.last?.emit("message", serverFrame("attached"));
    input.write("/var/folders/t5/screen.png");
    await Promise.resolve();

    expect(errors.join("")).toContain("Image paste: reading/uploading...");
    expect(errors.join("")).not.toContain("Image paste: inserted.");
    expect(sentInputData()).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_199);
    expect(errors.join("")).not.toContain("Image paste: inserted.");
    expect(sentInputData()).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(errors.join("")).toContain("Image paste: inserted.");
    expect(sentInputData()).toEqual([
      "/home/matrix/home/projects/.matrix-terminal-pastes/2026-07-10/upload.png",
    ]);

    FakeWebSocket.last?.emit("message", serverFrame("exit"));
    await expect(attach).resolves.toEqual({ detached: false, exitCode: null });
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
    const attach = client.attachTab(TERMINAL_REF, {
      input,
      output: new PassThrough(),
      WebSocketImpl: FakeWebSocket as never,
      richPaste: { rewriter, statusMinVisibleMs: 0 },
    });

    FakeWebSocket.last?.emit("message", serverFrame("attached"));
    input.write("\u001b[200~/var/folders/t5/screen.png what about this?\u001b[201~");

    const deadline = Date.now() + 250;
    while (!FakeWebSocket.last?.sent.some((frame) => frame.includes("remote paste text"))) {
      if (Date.now() > deadline) break;
      await new Promise((resolve) => {
        setTimeout(resolve, 1);
      });
    }

    expect(rewriter.rewrite).toHaveBeenCalledWith({
      sessionName: TERMINAL_REF_KEY,
      text: "/var/folders/t5/screen.png what about this?",
      observablePaste: true,
    });
    expect(FakeWebSocket.last?.sent).toContain(JSON.stringify({
      type: "input",
      terminalRef: TERMINAL_REF,
      data: "remote paste text",
    }));

    FakeWebSocket.last?.emit("message", serverFrame("exit"));
    await expect(attach).resolves.toEqual({ detached: false, exitCode: null });
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
    const attach = client.attachTab(TERMINAL_REF, {
      input,
      output: new PassThrough(),
      WebSocketImpl: FakeWebSocket as never,
      richPaste: { rewriter, statusMinVisibleMs: 0 },
    });

    FakeWebSocket.last?.emit("message", serverFrame("attached"));
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

    FakeWebSocket.last?.emit("message", serverFrame("exit"));
    await expect(attach).resolves.toEqual({ detached: false, exitCode: null });
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
    const attach = client.attachTab(TERMINAL_REF, {
      input,
      output: new PassThrough(),
      WebSocketImpl: FakeWebSocket as never,
      richPaste: { rewriter, statusMinVisibleMs: 0 },
    });

    FakeWebSocket.last?.emit("message", serverFrame("attached"));
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
      sessionName: TERMINAL_REF_KEY,
      text: "/var/folders/t5/screen.png what about this?",
      observablePaste: true,
    });
    expect(sentInputData()).toEqual(["remote paste text"]);
    expect(FakeWebSocket.last?.sent.join("\n")).not.toContain("\u001b[200~");
    expect(FakeWebSocket.last?.sent.join("\n")).not.toContain("\u001b[201~");

    FakeWebSocket.last?.emit("message", serverFrame("exit"));
    await expect(attach).resolves.toEqual({ detached: false, exitCode: null });
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
      const attach = client.attachTab(TERMINAL_REF, {
        input,
        output: new PassThrough(),
        errorOutput: errorOutput as NodeJS.WriteStream,
        WebSocketImpl: FakeWebSocket as never,
        richPaste: { rewriter, statusMinVisibleMs: 0 },
      });

      FakeWebSocket.last?.emit("message", serverFrame("attached"));
      input.write("\u001b[200~/var/folders/t5/screen.png\u001b[201");
      await vi.advanceTimersByTimeAsync(300);
      input.write("~pwd\r");

      expect(errors.join("")).toContain("Image paste failed: paste did not complete.");
      expect(rewriter.rewrite).not.toHaveBeenCalled();
      expect(sentInputData()).toEqual(["pwd\r"]);
      expect(FakeWebSocket.last?.sent.join("\n")).not.toContain("\u001b[200~");
      expect(FakeWebSocket.last?.sent.join("\n")).not.toContain("/var/folders/t5");

      FakeWebSocket.last?.emit("message", serverFrame("exit"));
      await expect(attach).resolves.toEqual({ detached: false, exitCode: null });
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
    const attach = client.attachTab(TERMINAL_REF, {
      input,
      output: new PassThrough(),
      WebSocketImpl: FakeWebSocket as never,
      richPaste: { rewriter, statusMinVisibleMs: 0 },
    });

    FakeWebSocket.last?.emit("message", serverFrame("attached"));
    input.write("\u001b[200~\u001b[201~");

    const deadline = Date.now() + 250;
    while (!FakeWebSocket.last?.sent.some((frame) => frame.includes("Please inspect this image"))) {
      if (Date.now() > deadline) break;
      await new Promise((resolve) => {
        setTimeout(resolve, 1);
      });
    }

    expect(rewriter.rewrite).toHaveBeenCalledWith({
      sessionName: TERMINAL_REF_KEY,
      text: "",
      observablePaste: true,
    });
    expect(FakeWebSocket.last?.sent).toContain(JSON.stringify({
      type: "input",
      terminalRef: TERMINAL_REF,
      data: "Please inspect this image: /home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/clipboard.png",
    }));

    FakeWebSocket.last?.emit("message", serverFrame("exit"));
    await expect(attach).resolves.toEqual({ detached: false, exitCode: null });
  });

  it("uses Ctrl-backslash v as an explicit clipboard image paste command", async () => {
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
    const attach = client.attachTab(TERMINAL_REF, {
      input,
      output: new PassThrough(),
      WebSocketImpl: FakeWebSocket as never,
      richPaste: { rewriter, statusMinVisibleMs: 0 },
    });

    FakeWebSocket.last?.emit("message", serverFrame("attached"));
    input.write("\u001cv");

    const deadline = Date.now() + 250;
    while (!FakeWebSocket.last?.sent.some((frame) => frame.includes("Please inspect this image"))) {
      if (Date.now() > deadline) break;
      await new Promise((resolve) => {
        setTimeout(resolve, 1);
      });
    }

    expect(rewriter.rewrite).toHaveBeenCalledWith({
      sessionName: TERMINAL_REF_KEY,
      text: "",
      observablePaste: true,
    });
    expect(sentInputData()).toEqual([
      "Please inspect this image: /home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/clipboard.png",
    ]);

    FakeWebSocket.last?.emit("message", serverFrame("exit"));
    await expect(attach).resolves.toEqual({ detached: false, exitCode: null });
  });

  it("prints local feedback when the explicit clipboard image paste command is unavailable", async () => {
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
        failureCode: "unsupported_paste_event" as const,
        localMessage: "Image paste is not supported by this terminal paste event.",
      })),
    };
    const client = createShellClient({
      gatewayUrl: "https://matrix.example",
      token: "token-123",
      timeoutMs: 100,
    });
    const attach = client.attachTab(TERMINAL_REF, {
      input,
      output: new PassThrough(),
      errorOutput: errorOutput as NodeJS.WriteStream,
      WebSocketImpl: FakeWebSocket as never,
      richPaste: { rewriter, statusMinVisibleMs: 0 },
    });

    FakeWebSocket.last?.emit("message", serverFrame("attached"));
    input.write("\u001cv");

    const deadline = Date.now() + 250;
    while (!errors.join("").includes("Image paste is not supported")) {
      if (Date.now() > deadline) break;
      await new Promise((resolve) => {
        setTimeout(resolve, 1);
      });
    }

    expect(rewriter.rewrite).toHaveBeenCalledWith({
      sessionName: TERMINAL_REF_KEY,
      text: "",
      observablePaste: true,
    });
    expect(errors.join("")).toContain("Image paste is not supported by this terminal paste event.");
    expect(sentInputData()).toEqual([]);

    FakeWebSocket.last?.emit("message", serverFrame("exit"));
    await expect(attach).resolves.toEqual({ detached: false, exitCode: null });
  });

  it("forwards raw Ctrl-V so readline quoted-insert keeps working", async () => {
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
        outgoingText: "unexpected clipboard paste",
        assets: [],
      })),
    };
    const client = createShellClient({
      gatewayUrl: "https://matrix.example",
      token: "token-123",
      timeoutMs: 100,
    });
    const attach = client.attachTab(TERMINAL_REF, {
      input,
      output: new PassThrough(),
      WebSocketImpl: FakeWebSocket as never,
      richPaste: { rewriter, statusMinVisibleMs: 0 },
    });

    FakeWebSocket.last?.emit("message", serverFrame("attached"));
    input.write("\u0016");

    expect(rewriter.rewrite).not.toHaveBeenCalled();
    expect(sentInputData()).toEqual(["\u0016"]);

    FakeWebSocket.last?.emit("message", serverFrame("exit"));
    await expect(attach).resolves.toEqual({ detached: false, exitCode: null });
  });

  it("keeps same-chunk input behind an explicit clipboard image paste command", async () => {
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
    const attach = client.attachTab(TERMINAL_REF, {
      input,
      output: new PassThrough(),
      WebSocketImpl: FakeWebSocket as never,
      richPaste: { rewriter, statusMinVisibleMs: 0 },
    });

    FakeWebSocket.last?.emit("message", serverFrame("attached"));
    input.write("\u001cv\t");
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });

    expect(sentInputData()).toEqual([]);

    finishRewrite({
      status: "rewritten",
      outgoingText: "/home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/clipboard.png",
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
      "/home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/clipboard.png",
      "\t",
    ]);

    FakeWebSocket.last?.emit("message", serverFrame("exit"));
    await expect(attach).resolves.toEqual({ detached: false, exitCode: null });
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
    const attach = client.attachTab(TERMINAL_REF, {
      input,
      output: new PassThrough(),
      errorOutput: errorOutput as NodeJS.WriteStream,
      WebSocketImpl: FakeWebSocket as never,
      richPaste: { rewriter, statusMinVisibleMs: 0 },
    });

    FakeWebSocket.last?.emit("message", serverFrame("attached"));
    input.write("/var/folders/t5/screen.png what about this?");

    const deadline = Date.now() + 250;
    while (!errors.join("").includes("Image paste failed")) {
      if (Date.now() > deadline) break;
      await new Promise((resolve) => {
        setTimeout(resolve, 1);
      });
    }

    expect(errors.join("")).toContain("Image paste: reading/uploading...");
    expect(errors.join("")).toContain("Image paste failed: upload did not complete.");
    expect(FakeWebSocket.last?.sent.join("\n")).not.toContain("/var/folders/t5");

    FakeWebSocket.last?.emit("message", serverFrame("exit"));
    await expect(attach).resolves.toEqual({ detached: false, exitCode: null });
  });

  it("does not print inserted feedback when rich paste passes text through", async () => {
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
        status: "passthrough" as const,
        outgoingText: "/tmp/not-uploaded.png",
        assets: [],
      })),
    };
    const client = createShellClient({
      gatewayUrl: "https://matrix.example",
      token: "token-123",
      timeoutMs: 100,
    });
    const attach = client.attachTab(TERMINAL_REF, {
      input,
      output: new PassThrough(),
      errorOutput: errorOutput as NodeJS.WriteStream,
      WebSocketImpl: FakeWebSocket as never,
      richPaste: { rewriter, statusMinVisibleMs: 0 },
    });

    FakeWebSocket.last?.emit("message", serverFrame("attached"));
    input.write("/tmp/not-uploaded.png");

    const deadline = Date.now() + 250;
    while (sentInputData().length < 1) {
      if (Date.now() > deadline) break;
      await new Promise((resolve) => {
        setTimeout(resolve, 1);
      });
    }

    expect(errors.join("")).toContain("Image paste: reading/uploading...");
    expect(errors.join("")).not.toContain("Image paste: inserted.");
    expect(sentInputData()).toEqual(["/tmp/not-uploaded.png"]);

    FakeWebSocket.last?.emit("message", serverFrame("exit"));
    await expect(attach).resolves.toEqual({ detached: false, exitCode: null });
  });

  it("uses live tail by default so attach does not replay stale full-screen frames", async () => {
    const client = createShellClient({
      gatewayUrl: "https://matrix.example",
      token: "token-123",
      timeoutMs: 100,
    });

    const attach = client.attachTab(TERMINAL_REF, {
      input: new PassThrough() as NodeJS.ReadStream,
      output: new PassThrough() as NodeJS.WriteStream,
      WebSocketImpl: FakeWebSocket as never,
    });

    expect(FakeWebSocket.last?.url).toContain(`fromSeq=${SHELL_ATTACH_LIVE_TAIL_FROM_SEQ}`);

    FakeWebSocket.last?.emit("message", serverFrame("attached"));
    FakeWebSocket.last?.emit("message", serverFrame("exit"));
    await expect(attach).resolves.toEqual({ detached: false, exitCode: null });
  });

  it("reconnects on unexpected close after attach instead of resolving detached", async () => {
    const client = createShellClient({
      gatewayUrl: "https://matrix.example",
      token: "token-123",
      timeoutMs: 100,
    });

    const attach = client.attachTab(TERMINAL_REF, {
      input: new PassThrough() as NodeJS.ReadStream,
      output: new PassThrough() as NodeJS.WriteStream,
      errorOutput: new PassThrough() as NodeJS.WriteStream,
      WebSocketImpl: FakeWebSocket as never,
      heartbeatIntervalMs: 0,
      reconnectBaseDelayMs: 1,
      reconnectMaxDelayMs: 1,
    });

    const firstSocket = FakeWebSocket.last;
    firstSocket?.emit("message", serverFrame("attached"));
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

    FakeWebSocket.last?.emit("message", serverFrame("attached"));
    FakeWebSocket.last?.emit("message", serverFrame("exit"));
    await expect(attach).resolves.toEqual({ detached: false, exitCode: null });
  });

  it("backs off the remote attach until a backgrounded local terminal drains", async () => {
    const output = Object.assign(new EventEmitter(), {
      columns: 80,
      rows: 24,
      write: vi.fn(() => false),
    }) as unknown as NodeJS.WriteStream;
    const client = createShellClient({
      gatewayUrl: "https://matrix.example",
      token: "token-123",
      timeoutMs: 100,
    });

    const attach = client.attachTab(TERMINAL_REF, {
      input: new PassThrough() as NodeJS.ReadStream,
      output,
      errorOutput: new PassThrough() as NodeJS.WriteStream,
      WebSocketImpl: FakeWebSocket as never,
      heartbeatIntervalMs: 0,
      reconnectBaseDelayMs: 1,
      reconnectMaxDelayMs: 1,
    });

    const firstSocket = FakeWebSocket.last;
    firstSocket?.emit("message", serverFrame("attached"));
    firstSocket?.emit("message", serverFrame("output", { seq: 41, data: "download progress" }));

    expect(firstSocket?.closed).toBe(true);
    firstSocket?.emit("close");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(FakeWebSocket.instances).toHaveLength(1);

    output.write = vi.fn(() => true) as never;
    output.emit("drain");
    await waitForFakeSocketCount(2);
    expect(FakeWebSocket.last?.url).toContain("fromSeq=42");

    FakeWebSocket.last?.emit("message", serverFrame("attached"));
    FakeWebSocket.last?.emit("message", serverFrame("exit"));
    await expect(attach).resolves.toEqual({ detached: false, exitCode: null });
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

    const attach = client.attachTab(TERMINAL_REF, {
      input,
      output,
      WebSocketImpl: FakeWebSocket as never,
    });

    FakeWebSocket.last?.emit("message", serverFrame("attached"));
    process.emit("SIGINT", "SIGINT");
    process.emit("SIGINT", "SIGINT");

    expect(FakeWebSocket.last?.closed).toBe(false);
    expect(FakeWebSocket.last?.sent.filter((frame) => frame === JSON.stringify({ type: "input", terminalRef: TERMINAL_REF, data: "\u0003" }))).toHaveLength(2);

    FakeWebSocket.last?.emit("message", serverFrame("exit"));
    await expect(attach).resolves.toEqual({ detached: false, exitCode: null });
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

    const attach = client.attachTab(TERMINAL_REF, {
      input,
      output,
      WebSocketImpl: FakeWebSocket as never,
    });

    FakeWebSocket.last?.emit("message", serverFrame("attached"));
    process.emit("SIGTERM", "SIGTERM");

    await expect(attach).resolves.toEqual({ detached: true, exitCode: null });
    expect(FakeWebSocket.last?.sent).toContain(JSON.stringify({ type: "detach", terminalRef: TERMINAL_REF }));
    expect(FakeWebSocket.last?.sent).not.toContain(JSON.stringify({ type: "input", terminalRef: TERMINAL_REF, data: "\u0003" }));
    expect(FakeWebSocket.last?.closed).toBe(true);
    expect(input.setRawMode).toHaveBeenCalledWith(false);
    expect(input.pause).toHaveBeenCalled();
  });

  it("builds a one-shot websocket URL for the selected tab", () => {
    const client = createShellClient({
      gatewayUrl: "https://matrix.example",
      token: "token-123",
      timeoutMs: 100,
    });

    expect(client.createAttachUrl(TERMINAL_REF, { token: "token-123" })).toBe(
      `wss://matrix.example/ws/terminal/tab?workspaceId=${TERMINAL_REF.workspaceId}&tabId=${TERMINAL_REF.tabId}&client=cli&token=token-123`,
    );
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

});
