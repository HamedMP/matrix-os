import { describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import {
  createShellWsHandler,
  SHELL_ATTACH_LIVE_TAIL_FROM_SEQ,
  SHELL_ATTACH_RECENT_REPLAY_EVENTS,
  shellWsMessageDataToString,
  type ShellWsSocket,
} from "../../packages/gateway/src/shell/ws.js";

class FakePty {
  writes: string[] = [];
  resizes: Array<{ cols: number; rows: number }> = [];
  killed = false;
  private dataListeners = new Set<(data: string) => void>();
  private exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  kill(): void {
    this.killed = true;
    this.emitExit({ exitCode: 0 });
  }

  onData(listener: (data: string) => void) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  emitExit(event: { exitCode: number; signal?: number }): void {
    for (const listener of this.exitListeners) {
      listener(event);
    }
  }
}

function socket(): ShellWsSocket & { sent: unknown[]; closed: boolean } {
  return {
    sent: [],
    closed: false,
    send(data: string) {
      this.sent.push(JSON.parse(data));
    },
    close() {
      this.closed = true;
    },
  };
}

describe("zellij terminal WebSocket", () => {
  it("rewrites detected Codex TUI reverse-video output before send and replay persistence", async () => {
    const pty = new FakePty();
    const secondPty = new FakePty();
    const ws = socket();
    const append = vi.fn(async () => undefined);
    const handler = createShellWsHandler({
      registry: {
        list: vi.fn(async () => [{ name: "main", status: "active" }]),
      },
      adapter: {
        attachSession: vi.fn()
          .mockReturnValueOnce(pty)
          .mockReturnValueOnce(secondPty),
      },
      scrollbackStore: {
        latestSeq: vi.fn(async () => null),
        readSince: vi.fn(async () => []),
        append,
        cleanup: vi.fn(async () => undefined),
        pathForSession: vi.fn(() => ""),
      },
      maxReplayBytes: 4096,
    });
    const raw = "OpenAI Codex (v0.142.5)\n\x1b[7mprompt\x1b[27m";
    const readable = "OpenAI Codex (v0.142.5)\n\x1b[38;2;214;216;221;48;2;48;54;61mprompt\x1b[39;49m";

    const first = await handler.open({ ws, session: "main", fromSeq: 0 });
    pty.emitData(raw);
    await new Promise((resolve) => setTimeout(resolve, 0));
    first.onClose();

    expect(ws.sent).toContainEqual({ type: "output", seq: 0, data: readable });
    expect(append).toHaveBeenCalledWith("main", [{ type: "output", seq: 0, data: readable }]);

    const replayWs = socket();
    const second = await handler.open({ ws: replayWs, session: "main", fromSeq: 0 });
    second.onClose();

    expect(replayWs.sent).toContainEqual({ type: "output", seq: 0, data: readable });
    expect(replayWs.sent).not.toContainEqual({ type: "output", seq: 0, data: raw });
  });

  it("rewrites detected Codex explicit prompt background before send and replay persistence", async () => {
    const pty = new FakePty();
    const secondPty = new FakePty();
    const ws = socket();
    const append = vi.fn(async () => undefined);
    const handler = createShellWsHandler({
      registry: {
        list: vi.fn(async () => [{ name: "main", status: "active" }]),
      },
      adapter: {
        attachSession: vi.fn()
          .mockReturnValueOnce(pty)
          .mockReturnValueOnce(secondPty),
      },
      scrollbackStore: {
        latestSeq: vi.fn(async () => null),
        readSince: vi.fn(async () => []),
        append,
        cleanup: vi.fn(async () => undefined),
        pathForSession: vi.fn(() => ""),
      },
      maxReplayBytes: 4096,
    });
    const raw = "OpenAI Codex (v0.142.5)\n\x1b[39m\x1b[48;2;240;240;239mprompt\x1b[39;49m";
    const readable = "OpenAI Codex (v0.142.5)\n\x1b[39m\x1b[38;2;214;216;221;48;2;48;54;61mprompt\x1b[38;2;214;216;221;49m";

    const first = await handler.open({ ws, session: "main", fromSeq: 0 });
    pty.emitData(raw);
    await new Promise((resolve) => setTimeout(resolve, 0));
    first.onClose();

    expect(ws.sent).toContainEqual({ type: "output", seq: 0, data: readable });
    expect(append).toHaveBeenCalledWith("main", [{ type: "output", seq: 0, data: readable }]);

    const replayWs = socket();
    const second = await handler.open({ ws: replayWs, session: "main", fromSeq: 0 });
    second.onClose();

    expect(replayWs.sent).toContainEqual({ type: "output", seq: 0, data: readable });
    expect(replayWs.sent).not.toContainEqual({ type: "output", seq: 0, data: raw });
  });

  it("rewrites persisted Codex replay and keeps detection active for later live output", async () => {
    const pty = new FakePty();
    const ws = socket();
    const append = vi.fn(async () => undefined);
    const banner = "OpenAI Codex (v0.142.5)\n";
    const rawReplayPrompt = "\x1b[7mold prompt\x1b[27m";
    const rawLivePrompt = "\x1b[7mlive prompt\x1b[27m";
    const readableReplayPrompt = "\x1b[38;2;214;216;221;48;2;48;54;61mold prompt\x1b[39;49m";
    const readableLivePrompt = "\x1b[38;2;214;216;221;48;2;48;54;61mlive prompt\x1b[39;49m";
    const handler = createShellWsHandler({
      registry: {
        list: vi.fn(async () => [{ name: "main", status: "active" }]),
      },
      adapter: {
        attachSession: vi.fn(() => pty),
      },
      scrollbackStore: {
        latestSeq: vi.fn(async () => 41),
        readSince: vi.fn(async () => [
          { type: "output", seq: 40, data: banner },
          { type: "output", seq: 41, data: rawReplayPrompt },
        ]),
        append,
        cleanup: vi.fn(async () => undefined),
        pathForSession: vi.fn(() => ""),
      },
      maxReplayBytes: 4096,
    });

    await handler.open({ ws, session: "main", fromSeq: 40 });
    pty.emitData(rawLivePrompt);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ws.sent).toContainEqual({ type: "output", seq: 40, data: banner });
    expect(ws.sent).toContainEqual({ type: "output", seq: 41, data: readableReplayPrompt });
    expect(ws.sent).not.toContainEqual({ type: "output", seq: 41, data: rawReplayPrompt });
    expect(ws.sent).toContainEqual({ type: "output", seq: 42, data: readableLivePrompt });
    expect(append).toHaveBeenCalledWith("main", [{ type: "output", seq: 42, data: readableLivePrompt }]);
  });

  it("keeps non-Codex reverse-video output unchanged", async () => {
    const pty = new FakePty();
    const ws = socket();
    const handler = createShellWsHandler({
      registry: {
        list: vi.fn(async () => [{ name: "main", status: "active" }]),
      },
      adapter: {
        attachSession: vi.fn(() => pty),
      },
      maxReplayBytes: 4096,
    });
    const raw = "plain \x1b[7mselected\x1b[27m";

    await handler.open({ ws, session: "main", fromSeq: 0 });
    pty.emitData(raw);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ws.sent).toContainEqual({ type: "output", seq: 0, data: raw });
  });

  it("flushes partial Codex compatibility escape bytes before attach close", async () => {
    const pty = new FakePty();
    const ws: ShellWsSocket & { sent: unknown[]; closed: boolean } = {
      sent: [],
      closed: false,
      send(data: string) {
        this.sent.push(JSON.parse(data));
      },
      close() {
        this.closed = true;
        this.sent.push({ type: "closed" });
      },
    };
    const handler = createShellWsHandler({
      registry: {
        list: vi.fn(async () => [{ name: "codex-main", status: "active" }]),
      },
      adapter: {
        attachSession: vi.fn(() => pty),
      },
      maxReplayBytes: 4096,
    });

    const session = await handler.open({ ws, session: "codex-main", fromSeq: 0 });
    pty.emitData("prompt\x1b[");
    await new Promise((resolve) => setTimeout(resolve, 0));
    session.onMessage(JSON.stringify({ type: "detach" }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ws.sent).toContainEqual({ type: "output", seq: 0, data: "prompt" });
    expect(ws.sent).toContainEqual({ type: "output", seq: 1, data: "\x1b[" });
    const flushedIndex = ws.sent.findIndex((event) => JSON.stringify(event) === JSON.stringify({ type: "output", seq: 1, data: "\x1b[" }));
    const closedIndex = ws.sent.findIndex((event) => JSON.stringify(event) === JSON.stringify({ type: "closed" }));
    expect(flushedIndex).toBeGreaterThan(-1);
    expect(closedIndex).toBeGreaterThan(-1);
    expect(flushedIndex).toBeLessThan(closedIndex);
  });

  it("attaches to a named session, replays from seq, forwards input, and cleans up", async () => {
    const pty = new FakePty();
    const ws = socket();
    const handler = createShellWsHandler({
      registry: {
        list: vi.fn(async () => [{ name: "main", status: "active" }]),
      },
      adapter: {
        attachSession: vi.fn(() => pty),
      },
      maxReplayBytes: 4096,
    });

    const session = await handler.open({
      ws,
      session: "main",
      fromSeq: 0,
    });

    pty.emitData("hello");
    await new Promise((resolve) => setTimeout(resolve, 0));
    session.onMessage(JSON.stringify({ type: "input", data: "pwd\r" }));
    session.onMessage(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    session.onClose();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ws.sent).toContainEqual({ type: "attached", session: "main", state: "running", fromSeq: 0 });
    expect(ws.sent).toContainEqual({ type: "output", seq: 0, data: "hello" });
    expect(pty.writes).toEqual(["pwd\r"]);
    expect(pty.resizes).toEqual([{ cols: 100, rows: 30 }]);
    expect(pty.killed).toBe(true);
  });

  it("sends the existing exit frame when the PTY exits", async () => {
    const pty = new FakePty();
    const ws = socket();
    const handler = createShellWsHandler({
      registry: {
        list: vi.fn(async () => [{ name: "main", status: "active" }]),
      },
      adapter: {
        attachSession: vi.fn(() => pty),
      },
    });

    await handler.open({ ws, session: "main", fromSeq: 0 });
    pty.emitExit({ exitCode: 101 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ws.sent).toContainEqual({ type: "exit", code: 101 });
  });

  it("answers heartbeat pings without forwarding them to zellij", async () => {
    const pty = new FakePty();
    const ws = socket();
    const handler = createShellWsHandler({
      registry: {
        list: vi.fn(async () => [{ name: "main", status: "active" }]),
      },
      adapter: {
        attachSession: vi.fn(() => pty),
      },
    });

    const session = await handler.open({ ws, session: "main", fromSeq: 0 });
    session.onMessage(JSON.stringify({ type: "ping" }));

    expect(ws.sent).toContainEqual({ type: "pong" });
    expect(pty.writes).toEqual([]);
  });

  it("accepts explicit destroy frames for scoped terminal pane close", async () => {
    const pty = new FakePty();
    const ws = socket();
    const handler = createShellWsHandler({
      registry: {
        list: vi.fn(async () => [{ name: "main", status: "active" }]),
      },
      adapter: {
        attachSession: vi.fn(() => pty),
      },
    });

    const session = await handler.open({ ws, session: "main", fromSeq: 0 });
    session.onMessage(JSON.stringify({ type: "destroy" }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pty.killed).toBe(true);
    expect(ws.closed).toBe(true);
    expect(ws.sent).not.toContainEqual({ type: "error", code: "invalid_message", message: "Invalid message" });
  });

  it("normalizes binary websocket frames before protocol parsing", async () => {
    const pty = new FakePty();
    const ws = socket();
    const handler = createShellWsHandler({
      registry: {
        list: vi.fn(async () => [{ name: "main", status: "active" }]),
      },
      adapter: {
        attachSession: vi.fn(() => pty),
      },
    });

    const session = await handler.open({ ws, session: "main", fromSeq: 0 });
    const rawPing = shellWsMessageDataToString(Buffer.from(JSON.stringify({ type: "ping" })));
    expect(rawPing).toBe(JSON.stringify({ type: "ping" }));
    session.onMessage(rawPing!);

    expect(ws.sent).toContainEqual({ type: "pong" });
    expect(pty.writes).toEqual([]);
  });

  it("normalizes websocket BufferSource frame variants", () => {
    const json = JSON.stringify({ type: "ping" });
    const arrayBuffer = new TextEncoder().encode(json).buffer;
    const uint8 = new Uint8Array(arrayBuffer);

    expect(shellWsMessageDataToString(json)).toBe(json);
    expect(shellWsMessageDataToString(Buffer.from(json))).toBe(json);
    expect(shellWsMessageDataToString(arrayBuffer)).toBe(json);
    expect(shellWsMessageDataToString(uint8)).toBe(json);
    expect(shellWsMessageDataToString({})).toBeNull();
  });

  it("maps live-tail attach to a bounded recent replay window", async () => {
    const pty = new FakePty();
    const secondPty = new FakePty();
    const ws = socket();
    const handler = createShellWsHandler({
      registry: {
        list: vi.fn(async () => [{ name: "main", status: "active" }]),
      },
      adapter: {
        attachSession: vi.fn()
          .mockReturnValueOnce(pty)
          .mockReturnValueOnce(secondPty),
      },
      maxReplayBytes: 4096,
    });

    const first = await handler.open({ ws, session: "main", fromSeq: 0 });
    for (let index = 0; index < SHELL_ATTACH_RECENT_REPLAY_EVENTS + 10; index += 1) {
      pty.emitData(`frame-${index}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    first.onClose();

    const secondWs = socket();
    const secondHandler = await handler.open({
      ws: secondWs,
      session: "main",
      fromSeq: SHELL_ATTACH_LIVE_TAIL_FROM_SEQ,
    });
    secondHandler.onClose();

    expect(secondWs.sent).toContainEqual({
      type: "attached",
      session: "main",
      state: "running",
      fromSeq: 10,
    });
    expect(secondWs.sent).not.toContainEqual({ type: "output", seq: 0, data: "frame-0" });
    expect(secondWs.sent).toContainEqual({ type: "output", seq: 10, data: "frame-10" });
  });

  it("maps cold-start live-tail attach from persisted scrollback instead of replaying from zero", async () => {
    const pty = new FakePty();
    const ws = socket();
    const readSince = vi.fn(async () => []);
    const handler = createShellWsHandler({
      registry: {
        list: vi.fn(async () => [{ name: "main", status: "active" }]),
      },
      adapter: {
        attachSession: vi.fn(() => pty),
      },
      scrollbackStore: {
        latestSeq: vi.fn(async () => 99),
        readSince,
        append: vi.fn(async () => undefined),
        cleanup: vi.fn(async () => undefined),
        pathForSession: vi.fn(() => ""),
      },
      maxReplayBytes: 4096,
    });

    const session = await handler.open({
      ws,
      session: "main",
      fromSeq: SHELL_ATTACH_LIVE_TAIL_FROM_SEQ,
    });
    session.onClose();

    expect(ws.sent).toContainEqual({
      type: "attached",
      session: "main",
      state: "running",
      fromSeq: 50,
    });
    expect(readSince).toHaveBeenCalledWith("main", 50);
  });

  it("returns a stable error frame if PTY attach throws before listeners are registered", async () => {
    const ws = socket();
    const handler = createShellWsHandler({
      registry: {
        list: vi.fn(async () => [{ name: "main", status: "active" }]),
      },
      adapter: {
        attachSession: vi.fn(() => {
          throw new Error("spawn failed");
        }),
      },
    });

    await handler.open({ ws, session: "main", fromSeq: 0 });

    expect(ws.sent).toEqual([
      { type: "error", code: "attach_failed", message: "Shell attach failed" },
    ]);
    expect(ws.closed).toBe(true);
  });

  it("rejects missing sessions with a stable error", async () => {
    const ws = socket();
    const handler = createShellWsHandler({
      registry: {
        list: vi.fn(async () => []),
      },
      adapter: {
        attachSession: vi.fn(),
      },
    });

    await handler.open({ ws, session: "missing", fromSeq: 0 });

    expect(ws.sent).toEqual([
      { type: "error", code: "session_not_found", message: "Session not found" },
    ]);
    expect(ws.closed).toBe(true);
  });

  it("accepts terminal query token and bearer auth through constant-time auth middleware", async () => {
    const next = vi.fn();
    const makeContext = (url: string, authorization?: string) => ({
      req: {
        path: "/ws/terminal",
        url,
        header: (name: string) => (
          name.toLowerCase() === "authorization" ? authorization : undefined
        ),
      },
      json: vi.fn((body: unknown, status: number) => ({ body, status })),
      set: vi.fn(),
    });
    const middleware = authMiddleware("secret-token");

    await middleware(makeContext("http://localhost/ws/terminal?token=secret-token") as never, next);
    await middleware(makeContext("http://localhost/ws/terminal", "Bearer secret-token") as never, next);
    const rejected = await middleware(
      makeContext("http://localhost/ws/terminal?token=secret-token-extra") as never,
      next,
    );

    expect(next).toHaveBeenCalledTimes(2);
    expect(rejected).toEqual({ body: { error: "Unauthorized" }, status: 401 });
  });
});
