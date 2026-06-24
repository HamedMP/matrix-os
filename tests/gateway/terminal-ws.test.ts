import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import {
  ClientMessageSchema,
  AttachNewSchema,
  AttachExistingSchema,
  InputSchema,
  ResizeSchema,
  DetachSchema,
  DestroySchema,
} from "../../packages/gateway/src/session-registry.js";
import {
  dispatchLegacyTerminalHandleMessage,
  resetVolatilePtySessionList,
  registerTerminalSessionRoutes,
  TERMINAL_SESSION_DELETE_BODY_LIMIT_BYTES,
  type TerminalSessionRouteRegistry,
} from "../../packages/gateway/src/server.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

function appWithTerminalRegistry(registry: TerminalSessionRouteRegistry, homePath = "/home/matrix/home") {
  const app = new Hono();
  registerTerminalSessionRoutes(app, { homePath, sessionRegistry: registry });
  return app;
}

describe("Terminal WebSocket Protocol — Zod Schemas", () => {
  describe("AttachNewSchema", () => {
    it("accepts valid attach-new message", () => {
      const msg = { type: "attach", cwd: "/home/matrixos/home/projects/myapp" };
      expect(AttachNewSchema.parse(msg)).toEqual(msg);
    });

    it("accepts attach-new with optional shell", () => {
      const msg = { type: "attach", cwd: "/home", shell: "/bin/zsh" };
      expect(AttachNewSchema.parse(msg)).toEqual(msg);
    });

    it("rejects empty cwd", () => {
      expect(() => AttachNewSchema.parse({ type: "attach", cwd: "" })).toThrow();
    });

    it("rejects cwd exceeding 4096 chars", () => {
      expect(() => AttachNewSchema.parse({ type: "attach", cwd: "a".repeat(4097) })).toThrow();
    });
  });

  describe("AttachExistingSchema", () => {
    it("accepts valid attach-existing message", () => {
      const msg = { type: "attach", sessionId: "550e8400-e29b-41d4-a716-446655440000" };
      expect(AttachExistingSchema.parse(msg)).toEqual(msg);
    });

    it("accepts attach-existing with fromSeq", () => {
      const msg = { type: "attach", sessionId: "550e8400-e29b-41d4-a716-446655440000", fromSeq: 42 };
      expect(AttachExistingSchema.parse(msg)).toEqual(msg);
    });

    it("rejects invalid UUID", () => {
      expect(() => AttachExistingSchema.parse({ type: "attach", sessionId: "not-a-uuid" })).toThrow();
    });

    it("rejects negative fromSeq", () => {
      expect(() =>
        AttachExistingSchema.parse({ type: "attach", sessionId: "550e8400-e29b-41d4-a716-446655440000", fromSeq: -1 }),
      ).toThrow();
    });

    it("accepts fromSeq of 0", () => {
      const msg = { type: "attach", sessionId: "550e8400-e29b-41d4-a716-446655440000", fromSeq: 0 };
      expect(AttachExistingSchema.parse(msg)).toEqual(msg);
    });
  });

  describe("InputSchema", () => {
    it("accepts valid input", () => {
      const msg = { type: "input", data: "ls -la\r" };
      expect(InputSchema.parse(msg)).toEqual(msg);
    });

    it("rejects data exceeding 64KB", () => {
      expect(() => InputSchema.parse({ type: "input", data: "x".repeat(65537) })).toThrow();
    });

    it("accepts empty string data", () => {
      const msg = { type: "input", data: "" };
      expect(InputSchema.parse(msg)).toEqual(msg);
    });
  });

  describe("ResizeSchema", () => {
    it("accepts valid resize", () => {
      const msg = { type: "resize", cols: 120, rows: 40 };
      expect(ResizeSchema.parse(msg)).toEqual(msg);
    });

    it("rejects cols below 1", () => {
      expect(() => ResizeSchema.parse({ type: "resize", cols: 0, rows: 40 })).toThrow();
    });

    it("rejects cols above 500", () => {
      expect(() => ResizeSchema.parse({ type: "resize", cols: 501, rows: 40 })).toThrow();
    });

    it("rejects rows below 1", () => {
      expect(() => ResizeSchema.parse({ type: "resize", cols: 80, rows: 0 })).toThrow();
    });

    it("rejects rows above 200", () => {
      expect(() => ResizeSchema.parse({ type: "resize", cols: 80, rows: 201 })).toThrow();
    });

    it("rejects non-integer cols", () => {
      expect(() => ResizeSchema.parse({ type: "resize", cols: 80.5, rows: 40 })).toThrow();
    });
  });

  describe("DetachSchema", () => {
    it("accepts valid detach", () => {
      const msg = { type: "detach" };
      expect(DetachSchema.parse(msg)).toEqual(msg);
    });
  });

  describe("DestroySchema", () => {
    it("accepts valid destroy", () => {
      const msg = { type: "destroy" };
      expect(DestroySchema.parse(msg)).toEqual(msg);
    });
  });

  describe("ClientMessageSchema (union)", () => {
    it("parses attach-new", () => {
      const result = ClientMessageSchema.parse({ type: "attach", cwd: "/home" });
      expect(result.type).toBe("attach");
    });

    it("parses attach-existing", () => {
      const result = ClientMessageSchema.parse({ type: "attach", sessionId: "550e8400-e29b-41d4-a716-446655440000" });
      expect(result.type).toBe("attach");
    });

    it("parses input", () => {
      const result = ClientMessageSchema.parse({ type: "input", data: "hello" });
      expect(result).toEqual({ type: "input", data: "hello" });
    });

    it("parses resize", () => {
      const result = ClientMessageSchema.parse({ type: "resize", cols: 80, rows: 24 });
      expect(result).toEqual({ type: "resize", cols: 80, rows: 24 });
    });

    it("parses detach", () => {
      const result = ClientMessageSchema.parse({ type: "detach" });
      expect(result).toEqual({ type: "detach" });
    });

    it("parses destroy", () => {
      const result = ClientMessageSchema.parse({ type: "destroy" });
      expect(result).toEqual({ type: "destroy" });
    });

    it("parses the mobile attach/input/resize/detach/destroy flow", () => {
      const frames = [
        { type: "attach", cwd: "projects" },
        { type: "input", data: "pwd\r" },
        { type: "resize", cols: 42, rows: 24 },
        { type: "detach" },
        { type: "attach", sessionId: SESSION_ID, fromSeq: 0 },
        { type: "destroy" },
      ];

      expect(frames.map((frame) => ClientMessageSchema.parse(frame))).toEqual(frames);
    });

    it("rejects unknown type", () => {
      expect(() => ClientMessageSchema.parse({ type: "unknown" })).toThrow();
    });

    it("rejects missing type", () => {
      expect(() => ClientMessageSchema.parse({ data: "hello" })).toThrow();
    });
  });
});

describe("Terminal session REST routes", () => {
  it("resets volatile persisted pty session lists during canonical shell startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-os-terminal-list-"));
    const persistPath = join(root, "system", "terminal-sessions.json");
    await mkdir(join(root, "system"), { recursive: true });
    await writeFile(persistPath, JSON.stringify([{ sessionId: SESSION_ID }]), { flag: "w" });

    await resetVolatilePtySessionList(persistPath);

    await expect(readFile(persistPath, "utf-8")).resolves.toBe("[]\n");
    await rm(root, { recursive: true, force: true });
  });

  it("lists terminal sessions with home-relative cwd values", async () => {
    const registry = {
      list: () => [{
        sessionId: SESSION_ID,
        cwd: "/home/matrix/home/projects/matrix-os",
        shell: "/bin/bash",
        state: "running" as const,
        createdAt: 1,
        lastAttachedAt: 2,
        attachedClients: 1,
      }],
      getSession: () => null,
      destroy: () => undefined,
    };
    const app = appWithTerminalRegistry(registry);

    const res = await app.request("/api/terminal/pty-sessions");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{
      sessionId: SESSION_ID,
      cwd: "projects/matrix-os",
      state: "running",
      createdAt: 1,
      lastAttachedAt: 2,
      attachedClients: 1,
    }]);
  });

  it("rejects invalid terminal session delete IDs before touching the registry", async () => {
    const registry = {
      list: () => [],
      getSession: vi.fn(),
      destroy: vi.fn(),
    };
    const app = appWithTerminalRegistry(registry);

    const res = await app.request("/api/terminal/pty-sessions/not-a-uuid", { method: "DELETE" });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid session ID" });
    expect(registry.getSession).not.toHaveBeenCalled();
    expect(registry.destroy).not.toHaveBeenCalled();
  });

  it("treats repeated terminal session deletes as idempotent success", async () => {
    const registry = {
      list: () => [],
      getSession: vi.fn(() => null),
      destroy: vi.fn(),
    };
    const app = appWithTerminalRegistry(registry);

    const res = await app.request(`/api/terminal/pty-sessions/${SESSION_ID}`, { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(registry.destroy).not.toHaveBeenCalled();
  });

  it("caps ignored terminal delete request bodies before registry access", async () => {
    const registry = {
      list: () => [],
      getSession: vi.fn(() => ({ sessionId: SESSION_ID })),
      destroy: vi.fn(),
    };
    const app = appWithTerminalRegistry(registry);

    const res = await app.request(`/api/terminal/pty-sessions/${SESSION_ID}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "text/plain",
        "Content-Length": String(TERMINAL_SESSION_DELETE_BODY_LIMIT_BYTES + 1),
      },
      body: "x".repeat(TERMINAL_SESSION_DELETE_BODY_LIMIT_BYTES + 1),
    });

    expect(res.status).toBe(413);
    expect(registry.getSession).not.toHaveBeenCalled();
    expect(registry.destroy).not.toHaveBeenCalled();
  });
});

describe("legacy terminal websocket handle dispatch", () => {
  it("keeps live terminal pings eligible for pong responses", () => {
    const sent: unknown[] = [];
    const handle = {
      sessionId: SESSION_ID,
      send: vi.fn(() => true),
      replay: vi.fn(),
      subscribe: vi.fn(),
      detach: vi.fn(),
    };
    const closed = vi.fn();

    const alive = dispatchLegacyTerminalHandleMessage({
      handle,
      msg: { type: "ping" },
      sendJson: (message) => sent.push(message),
      close: closed,
    });

    if (alive) {
      sent.push({ type: "pong" });
    }

    expect(alive).toBe(true);
    expect(handle.send).toHaveBeenCalledWith({ type: "ping" });
    expect(handle.detach).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    expect(sent).toEqual([{ type: "pong" }]);
  });

  it("sends a generic error and closes instead of ponging stale-pruned terminal pings", () => {
    const sent: unknown[] = [];
    const onDeadHandle = vi.fn();
    const handle = {
      sessionId: SESSION_ID,
      send: vi.fn(() => false),
      replay: vi.fn(),
      subscribe: vi.fn(),
      detach: vi.fn(),
    };
    const closed = vi.fn();

    const alive = dispatchLegacyTerminalHandleMessage({
      handle,
      msg: { type: "ping" },
      sendJson: (message) => sent.push(message),
      close: closed,
      onDeadHandle,
    });

    if (alive) {
      sent.push({ type: "pong" });
    }

    expect(alive).toBe(false);
    expect(handle.send).toHaveBeenCalledWith({ type: "ping" });
    expect(handle.detach).toHaveBeenCalledTimes(1);
    expect(onDeadHandle).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([{ type: "error", message: "Terminal session unavailable" }]);
  });

  it("sends a generic error and closes instead of silently dropping stale-pruned terminal input", () => {
    const sent: unknown[] = [];
    const onDeadHandle = vi.fn();
    const handle = {
      sessionId: SESSION_ID,
      send: vi.fn(() => false),
      replay: vi.fn(),
      subscribe: vi.fn(),
      detach: vi.fn(),
    };
    const closed = vi.fn();

    const alive = dispatchLegacyTerminalHandleMessage({
      handle,
      msg: { type: "input", data: "pwd\r" },
      sendJson: (message) => sent.push(message),
      close: closed,
      onDeadHandle,
    });

    expect(alive).toBe(false);
    expect(handle.send).toHaveBeenCalledWith({ type: "input", data: "pwd\r" });
    expect(handle.detach).toHaveBeenCalledTimes(1);
    expect(onDeadHandle).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([{ type: "error", message: "Terminal session unavailable" }]);
  });
});
