import { describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import {
  createShellWsHandler,
  SHELL_ATTACH_LIVE_TAIL_FROM_SEQ,
  shellWsMessageDataToString,
  type ShellWsSocket,
} from "../../packages/gateway/src/shell/ws.js";

class FakePty {
  writes: string[] = [];
  resizes: Array<{ cols: number; rows: number }> = [];
  killed = false;
  pauseCount = 0;
  resumeCount = 0;
  paused = false;
  private dataListeners = new Set<(data: string) => void>();
  private exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();

  pause(): void {
    this.paused = true;
    this.pauseCount += 1;
  }

  resume(): void {
    this.paused = false;
    this.resumeCount += 1;
  }

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
      persistFlushIntervalMs: 0,
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
      persistFlushIntervalMs: 0,
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
      persistFlushIntervalMs: 0,
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
      idleAttachGraceMs: 0,
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
      idleAttachGraceMs: 0,
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
      idleAttachGraceMs: 0,
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

  it("shares one zellij attach process across overlapping clients", async () => {
    const pty = new FakePty();
    const firstWs = socket();
    const secondWs = socket();
    const append = vi.fn(async () => undefined);
    const attachSession = vi.fn(() => pty);
    const handler = createShellWsHandler({
      registry: {
        list: vi.fn(async () => [{ name: "main", status: "active" }]),
      },
      adapter: { attachSession },
      scrollbackStore: {
        latestSeq: vi.fn(async () => null),
        readSince: vi.fn(async () => []),
        append,
        cleanup: vi.fn(async () => undefined),
        pathForSession: vi.fn(() => ""),
      },
      maxReplayBytes: 4096,
      persistFlushIntervalMs: 0,
      idleAttachGraceMs: 0,
    });

    const first = await handler.open({ ws: firstWs, session: "main", fromSeq: 0 });
    const second = await handler.open({ ws: secondWs, session: "main", fromSeq: 0 });
    pty.emitData("shared-output");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(attachSession).toHaveBeenCalledTimes(1);
    expect(firstWs.sent).toContainEqual({ type: "output", seq: 0, data: "shared-output" });
    expect(secondWs.sent).toContainEqual({ type: "output", seq: 0, data: "shared-output" });
    expect(append).toHaveBeenCalledWith("main", [{ type: "output", seq: 0, data: "shared-output" }]);

    second.onMessage(JSON.stringify({ type: "input", data: "pwd\r" }));
    expect(pty.writes).toEqual(["pwd\r"]);

    first.onClose();
    expect(pty.killed).toBe(false);
    second.onClose();
    expect(pty.killed).toBe(true);
  });

  it("keeps the zellij attach process through a short reconnect gap", async () => {
    vi.useFakeTimers();
    const pty = new FakePty();
    const attachSession = vi.fn(() => pty);
    const handler = createShellWsHandler({
      registry: {
        list: vi.fn(async () => [{ name: "main", status: "active" }]),
      },
      adapter: { attachSession },
      maxReplayBytes: 4096,
      idleAttachGraceMs: 50,
    });

    const first = await handler.open({ ws: socket(), session: "main", fromSeq: 0 });
    first.onClose();
    await vi.advanceTimersByTimeAsync(49);
    expect(pty.killed).toBe(false);

    const second = await handler.open({ ws: socket(), session: "main", fromSeq: 0 });
    expect(attachSession).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(pty.killed).toBe(false);

    second.onClose();
    await vi.advanceTimersByTimeAsync(50);
    expect(pty.killed).toBe(true);
    handler.dispose();
    vi.useRealTimers();
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
      idleAttachGraceMs: 0,
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
      idleAttachGraceMs: 0,
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
      idleAttachGraceMs: 0,
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

  it("maps live-tail attach to the next live sequence without replaying old TUI frames", async () => {
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
    for (let index = 0; index < 60; index += 1) {
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
      fromSeq: 60,
    });
    expect(secondWs.sent).not.toContainEqual({ type: "output", seq: 0, data: "frame-0" });
    expect(secondWs.sent).not.toContainEqual({ type: "output", seq: 59, data: "frame-59" });
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
      persistFlushIntervalMs: 0,
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
      fromSeq: 100,
    });
    expect(readSince).toHaveBeenCalledWith("main", 100);
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

  it("delivers live output before persistence completes (send-first)", async () => {
    const pty = new FakePty();
    const ws = socket();
    let appendStarted = 0;
    const handler = createShellWsHandler({
      registry: { list: vi.fn(async () => [{ name: "main", status: "active" }]) },
      adapter: { attachSession: vi.fn(() => pty) },
      scrollbackStore: {
        latestSeq: vi.fn(async () => null),
        readSince: vi.fn(async () => []),
        append: vi.fn(async () => {
          appendStarted += 1;
          await new Promise(() => undefined); // never resolves: dead disk
        }),
        cleanup: vi.fn(async () => undefined),
        pathForSession: vi.fn(() => ""),
      },
      maxReplayBytes: 4096,
      persistFlushIntervalMs: 0,
    });

    await handler.open({ ws, session: "main", fromSeq: 0 });
    pty.emitData("instant echo");
    // no timer advance needed: the frame must already be on the socket
    expect(ws.sent).toContainEqual({ type: "output", seq: 0, data: "instant echo" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(appendStarted).toBeGreaterThanOrEqual(1);
  });

  it("persists the shared attach stream exactly once when multiple clients attach", async () => {
    const pty = new FakePty();
    const append = vi.fn(async () => undefined);
    const attachSession = vi.fn(() => pty);
    const handler = createShellWsHandler({
      registry: { list: vi.fn(async () => [{ name: "main", status: "active" }]) },
      adapter: { attachSession },
      scrollbackStore: {
        latestSeq: vi.fn(async () => null),
        readSince: vi.fn(async () => []),
        append,
        cleanup: vi.fn(async () => undefined),
        pathForSession: vi.fn(() => ""),
      },
      maxReplayBytes: 4096,
      persistFlushIntervalMs: 0,
    });

    const firstWs = socket();
    const observerWs = socket();
    await handler.open({ ws: firstWs, session: "main", fromSeq: 0 });
    await handler.open({ ws: observerWs, session: "main", fromSeq: 0 });

    pty.emitData("from-shared");
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(attachSession).toHaveBeenCalledTimes(1);
    expect(firstWs.sent).toContainEqual({ type: "output", seq: 0, data: "from-shared" });
    expect(observerWs.sent).toContainEqual({ type: "output", seq: 0, data: "from-shared" });
    const persisted = append.mock.calls
      .flatMap((call) => call[1] as Array<{ type: string; data?: string }>)
      .filter((r) => r.type === "output")
      .map((r) => r.data);
    expect(persisted).toEqual(["from-shared"]);
  });

  it("keeps the shared attach alive when one of multiple clients detaches", async () => {
    const pty = new FakePty();
    const append = vi.fn(async () => undefined);
    const handler = createShellWsHandler({
      registry: { list: vi.fn(async () => [{ name: "main", status: "active" }]) },
      adapter: { attachSession: vi.fn(() => pty) },
      scrollbackStore: {
        latestSeq: vi.fn(async () => null),
        readSince: vi.fn(async () => []),
        append,
        cleanup: vi.fn(async () => undefined),
        pathForSession: vi.fn(() => ""),
      },
      maxReplayBytes: 4096,
      persistFlushIntervalMs: 0,
      idleAttachGraceMs: 0,
    });

    const firstConn = await handler.open({ ws: socket(), session: "main", fromSeq: 0 });
    const secondWs = socket();
    const secondConn = await handler.open({ ws: secondWs, session: "main", fromSeq: 0 });

    firstConn.onClose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    pty.emitData("post-detach");
    await new Promise((resolve) => setTimeout(resolve, 5));

    const persisted = append.mock.calls
      .flatMap((call) => call[1] as Array<{ type: string; data?: string }>)
      .filter((r) => r.type === "output")
      .map((r) => r.data);
    expect(persisted).toContain("post-detach");
    expect(secondWs.sent).toContainEqual({ type: "output", seq: 0, data: "post-detach" });
    expect(pty.killed).toBe(false);
    secondConn.onClose();
    expect(pty.killed).toBe(true);
  });

  it("skips delivery to a slow client without pausing the shared attach", async () => {
    const pty = new FakePty();
    const fastWs = socket();
    const handler = createShellWsHandler({
      registry: { list: vi.fn(async () => [{ name: "main", status: "active" }]) },
      adapter: { attachSession: vi.fn(() => pty) },
      maxReplayBytes: 4096,
      flowControl: { highWaterMark: 10, lowWaterMark: 5, drainIntervalMs: 5 },
    });

    await handler.open({ ws: fastWs, session: "main", fromSeq: 0 });
    const slowWs = Object.assign(socket(), { bufferedAmount: 1_000 });
    await handler.open({ ws: slowWs, session: "main", fromSeq: 0 });
    const slowSentBefore = slowWs.sent.length;

    pty.emitData("burst");
    expect(fastWs.sent).toContainEqual({ type: "output", seq: 0, data: "burst" });
    expect(slowWs.sent.length).toBe(slowSentBefore);
    expect(pty.pauseCount).toBe(0);
    expect(pty.resumeCount).toBe(0);
    handler.dispose();
  });

  it("never pauses a shared attach for a slow sole socket; delivery is skipped instead", async () => {
    const pty = new FakePty();
    const append = vi.fn(async () => undefined);
    const handler = createShellWsHandler({
      registry: { list: vi.fn(async () => [{ name: "main", status: "active" }]) },
      adapter: { attachSession: vi.fn(() => pty) },
      scrollbackStore: {
        latestSeq: vi.fn(async () => null),
        readSince: vi.fn(async () => []),
        append,
        cleanup: vi.fn(async () => undefined),
        pathForSession: vi.fn(() => ""),
      },
      maxReplayBytes: 4096,
      persistFlushIntervalMs: 0,
      flowControl: { highWaterMark: 10, lowWaterMark: 5, drainIntervalMs: 5 },
    });

    const slowWs = Object.assign(socket(), { bufferedAmount: 1_000 });
    await handler.open({ ws: slowWs, session: "main", fromSeq: 0 });
    const sentBefore = slowWs.sent.length;

    pty.emitData("still persists");
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(pty.pauseCount).toBe(0);
    expect(slowWs.sent.length).toBe(sentBefore); // frame skipped for the slow socket
    const persisted = append.mock.calls
      .flatMap((call) => call[1] as Array<{ type: string; data?: string }>)
      .filter((r) => r.type === "output")
      .map((r) => r.data);
    expect(persisted).toContain("still persists");
    handler.dispose();
  });

  it("caps attaches per session and evicts the stalest client first", async () => {
    const ptys = [new FakePty(), new FakePty(), new FakePty()];
    let next = 0;
    const handler = createShellWsHandler({
      registry: { list: vi.fn(async () => [{ name: "main", status: "active" }]) },
      adapter: { attachSession: vi.fn(() => ptys[next++]!) },
      maxReplayBytes: 4096,
      maxAttachedClients: 2,
      staleAttachTtlMs: 10,
    });

    const firstWs = socket();
    await handler.open({ ws: firstWs, session: "main", fromSeq: 0 });
    const second = await handler.open({ ws: socket(), session: "main", fromSeq: 0 });
    // keep the second connection fresh, let the first go stale
    await new Promise((resolve) => setTimeout(resolve, 20));
    second.onMessage(JSON.stringify({ type: "ping" }));

    const thirdWs = socket();
    await handler.open({ ws: thirdWs, session: "main", fromSeq: 0 });

    expect(firstWs.closed).toBe(true); // stalest evicted
    expect(thirdWs.sent).toContainEqual(
      expect.objectContaining({ type: "attached", session: "main" }),
    );
    handler.dispose();
  });

  it("rejects attaches over the cap when every client is fresh", async () => {
    const ptys = [new FakePty(), new FakePty()];
    let next = 0;
    const handler = createShellWsHandler({
      registry: { list: vi.fn(async () => [{ name: "main", status: "active" }]) },
      adapter: { attachSession: vi.fn(() => ptys[next++] ?? new FakePty()) },
      maxReplayBytes: 4096,
      maxAttachedClients: 2,
      staleAttachTtlMs: 60_000,
    });

    await handler.open({ ws: socket(), session: "main", fromSeq: 0 });
    await handler.open({ ws: socket(), session: "main", fromSeq: 0 });
    const thirdWs = socket();
    await handler.open({ ws: thirdWs, session: "main", fromSeq: 0 });

    expect(thirdWs.sent).toContainEqual({
      type: "error",
      code: "attach_limit",
      message: "Too many clients attached",
    });
    expect(thirdWs.closed).toBe(true);
    handler.dispose();
  });

  it("rejects new sessions at runtime capacity when every tracked session has live clients", async () => {
    const handler = createShellWsHandler({
      registry: {
        list: vi.fn(async () => [
          { name: "one", status: "active" },
          { name: "two", status: "active" },
          { name: "three", status: "active" },
        ]),
      },
      adapter: { attachSession: vi.fn(() => new FakePty()) },
      maxReplayBytes: 4096,
      maxBuffers: 2,
    });

    await handler.open({ ws: socket(), session: "one", fromSeq: 0 });
    await handler.open({ ws: socket(), session: "two", fromSeq: 0 });
    const thirdWs = socket();
    await handler.open({ ws: thirdWs, session: "three", fromSeq: 0 });

    expect(thirdWs.sent).toContainEqual({
      type: "error",
      code: "session_capacity",
      message: "Too many active sessions",
    });
    expect(thirdWs.closed).toBe(true);
    handler.dispose();
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
