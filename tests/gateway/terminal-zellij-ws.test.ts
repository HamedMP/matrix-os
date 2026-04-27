import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import {
  createShellWsHandler,
  type ShellWsSocket,
} from "../../packages/gateway/src/shell/ws.js";

class FakeStream extends EventEmitter {
  writes: string[] = [];

  write(data: string): boolean {
    this.writes.push(data);
    return true;
  }
}

class FakeChild extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  stdin = new FakeStream();
  killed = false;

  kill(): boolean {
    this.killed = true;
    this.emit("close", 0);
    return true;
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
  it("attaches to a named session, replays from seq, forwards input, and cleans up", async () => {
    const child = new FakeChild();
    const ws = socket();
    const handler = createShellWsHandler({
      registry: {
        list: vi.fn(async () => [{ name: "main", status: "active" }]),
      },
      adapter: {
        attachSession: vi.fn(() => child as never),
      },
      maxReplayBytes: 4096,
    });

    const session = await handler.open({
      ws,
      session: "main",
      fromSeq: 0,
    });

    child.stdout.emit("data", Buffer.from("hello"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    session.onMessage(JSON.stringify({ type: "input", data: "pwd\r" }));
    session.onClose();

    expect(ws.sent).toContainEqual({ type: "attached", session: "main", state: "running", fromSeq: 0 });
    expect(ws.sent).toContainEqual({ type: "output", seq: 0, data: "hello" });
    expect(child.stdin.writes).toEqual(["pwd\r"]);
    expect(child.killed).toBe(true);
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
