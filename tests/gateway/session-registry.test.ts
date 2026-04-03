import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  SessionRegistry,
  type SessionHandle,
  type PtyServerMessage,
  type SessionRegistryOptions,
} from "../../packages/gateway/src/session-registry.js";

function createMockPty() {
  return {
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    pid: 12345,
  };
}

type MockPty = ReturnType<typeof createMockPty>;

function createMockSpawn(mockPty?: MockPty) {
  const factory = vi.fn(() => mockPty ?? createMockPty());
  return factory;
}

function createRegistry(
  opts: Partial<SessionRegistryOptions> = {},
  spawnFn?: ReturnType<typeof createMockSpawn>,
) {
  const homePath = "/tmp/test-home";
  return new SessionRegistry(homePath, {
    maxSessions: opts.maxSessions ?? 20,
    bufferSize: opts.bufferSize ?? 1024,
    persistPath: opts.persistPath ?? "/tmp/test-home/system/terminal-sessions.json",
    ...opts,
  }, spawnFn ?? createMockSpawn());
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("SessionRegistry", () => {
  describe("create", () => {
    it("returns a UUID string", () => {
      const registry = createRegistry();
      const id = registry.create("/home");
      expect(id).toMatch(UUID_REGEX);
    });

    it("spawns a PTY process", () => {
      const mockSpawn = createMockSpawn();
      const registry = createRegistry({}, mockSpawn);
      registry.create("/home");
      expect(mockSpawn).toHaveBeenCalledOnce();
    });

    it("passes resolved cwd to spawn function (falls back to homePath if dir does not exist)", () => {
      const mockSpawn = createMockSpawn();
      const registry = createRegistry({}, mockSpawn);
      registry.create("projects/myapp");

      const call = mockSpawn.mock.calls[0];
      // /tmp/test-home/projects/myapp doesn't exist, so falls back to homePath
      expect(call[2]).toMatchObject({ cwd: "/tmp/test-home" });
    });

    it("validates cwd against home path", () => {
      const mockSpawn = createMockSpawn();
      const registry = createRegistry({}, mockSpawn);
      const id = registry.create("../../etc/passwd");
      // Should still create a session but with homePath as fallback cwd
      expect(id).toMatch(UUID_REGEX);
      const call = mockSpawn.mock.calls[0];
      expect(call[2].cwd).toBe("/tmp/test-home");
    });

    it("rejects shell not in allowlist and falls back to default", () => {
      const mockSpawn = createMockSpawn();
      const registry = createRegistry({}, mockSpawn);
      registry.create("/home", "/usr/bin/python3");
      const call = mockSpawn.mock.calls[0];
      expect(call[0]).not.toBe("/usr/bin/python3");
    });

    it("accepts shell in allowlist", () => {
      const mockSpawn = createMockSpawn();
      const registry = createRegistry({}, mockSpawn);
      registry.create("/home", "/bin/zsh");
      const call = mockSpawn.mock.calls[0];
      expect(call[0]).toBe("/bin/zsh");
    });
  });

  describe("attach", () => {
    it("returns a SessionHandle for an existing session", () => {
      const registry = createRegistry();
      const id = registry.create("/home");
      const handle = registry.attach(id);
      expect(handle).not.toBeNull();
      expect(handle!.sessionId).toBe(id);
    });

    it("returns null for nonexistent session id", () => {
      const registry = createRegistry();
      const handle = registry.attach("550e8400-e29b-41d4-a716-446655440000");
      expect(handle).toBeNull();
    });

    it("increments attached client count after subscribe succeeds", () => {
      const registry = createRegistry();
      const id = registry.create("/home");
      const handle1 = registry.attach(id)!;
      const handle2 = registry.attach(id)!;
      handle1.subscribe(() => {});
      handle2.subscribe(() => {});

      const info = registry.getSession(id);
      expect(info!.attachedClients).toBe(2);
    });

    it("does not increment attached client count when subscribe throws", () => {
      const registry = createRegistry();
      const id = registry.create("/home");

      const handles = Array.from({ length: 10 }, () => {
        const handle = registry.attach(id)!;
        handle.subscribe(() => {});
        return handle;
      });

      const overflowHandle = registry.attach(id)!;
      expect(() => overflowHandle.subscribe(() => {})).toThrow("Too many subscribers");
      expect(registry.getSession(id)!.attachedClients).toBe(10);

      overflowHandle.detach();
      expect(registry.getSession(id)!.attachedClients).toBe(10);

      handles.forEach((handle) => handle.detach());
    });
  });

  describe("handle.detach", () => {
    it("decrements attached client count", () => {
      const registry = createRegistry();
      const id = registry.create("/home");
      const handle1 = registry.attach(id)!;
      const handle2 = registry.attach(id)!;
      handle1.subscribe(() => {});
      handle2.subscribe(() => {});

      expect(registry.getSession(id)!.attachedClients).toBe(2);
      handle1.detach();
      expect(registry.getSession(id)!.attachedClients).toBe(1);
    });

    it("does not go below 0 on double detach", () => {
      const registry = createRegistry();
      const id = registry.create("/home");
      const handle = registry.attach(id)!;
      handle.subscribe(() => {});
      handle.detach();
      handle.detach(); // second detach is a no-op
      expect(registry.getSession(id)!.attachedClients).toBe(0);
    });
  });

  describe("destroy", () => {
    it("kills PTY and removes session", () => {
      const mockPty = createMockPty();
      const mockSpawn = createMockSpawn(mockPty);
      const registry = createRegistry({}, mockSpawn);
      const id = registry.create("/home");

      registry.destroy(id);
      expect(mockPty.kill).toHaveBeenCalledOnce();
      expect(registry.getSession(id)).toBeNull();
    });

    it("clears subscribers after destroy", () => {
      const mockPty = createMockPty();
      const mockSpawn = createMockSpawn(mockPty);
      const registry = createRegistry({}, mockSpawn);
      const id = registry.create("/home");
      const handle = registry.attach(id)!;
      handle.subscribe(() => {});

      const sessionMap = (registry as unknown as { sessions: Map<string, { subscribers: Set<unknown> }> }).sessions;
      const session = sessionMap.get(id)!;
      expect(session.subscribers.size).toBe(1);

      registry.destroy(id);

      expect(session.subscribers.size).toBe(0);
      expect(registry.getSession(id)).toBeNull();
    });

    it("removes session even if PTY kill throws", () => {
      const mockPty = createMockPty();
      mockPty.kill.mockImplementation(() => {
        throw new Error("already dead");
      });
      const mockSpawn = createMockSpawn(mockPty);
      const registry = createRegistry({}, mockSpawn);
      const id = registry.create("/home");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      expect(() => registry.destroy(id)).not.toThrow();

      expect(registry.getSession(id)).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith("Failed to kill terminal session:", "already dead");
      warnSpy.mockRestore();
    });

    it("does nothing for nonexistent session", () => {
      const registry = createRegistry();
      // Should not throw
      registry.destroy("550e8400-e29b-41d4-a716-446655440000");
    });
  });

  describe("session cap and eviction", () => {
    it("evicts oldest orphaned session when hitting max", () => {
      const registry = createRegistry({ maxSessions: 3 });

      const id1 = registry.create("/home");
      const id2 = registry.create("/home");
      const id3 = registry.create("/home");

      // All 3 sessions exist, none attached -- creating 4th should evict id1
      const id4 = registry.create("/home");

      expect(registry.getSession(id1)).toBeNull();
      expect(registry.getSession(id2)).not.toBeNull();
      expect(registry.getSession(id3)).not.toBeNull();
      expect(registry.getSession(id4)).not.toBeNull();
    });

    it("eviction skips sessions with attached clients", () => {
      const registry = createRegistry({ maxSessions: 3 });

      const id1 = registry.create("/home");
      const id2 = registry.create("/home");
      const id3 = registry.create("/home");

      // Attach to id1, making it non-evictable
      registry.attach(id1)!.subscribe(() => {});

      // Creating 4th should skip id1 and evict id2
      const id4 = registry.create("/home");

      expect(registry.getSession(id1)).not.toBeNull();
      expect(registry.getSession(id2)).toBeNull();
      expect(registry.getSession(id3)).not.toBeNull();
      expect(registry.getSession(id4)).not.toBeNull();
    });

    it("throws when all sessions have attached clients and cap is reached", () => {
      const registry = createRegistry({ maxSessions: 2 });

      const id1 = registry.create("/home");
      const id2 = registry.create("/home");
      registry.attach(id1)!.subscribe(() => {});
      registry.attach(id2)!.subscribe(() => {});

      // All attached -- 3rd session should throw (no eviction candidate)
      expect(() => registry.create("/home")).toThrow("Session limit reached");
      expect(registry.list()).toHaveLength(2);
    });
  });

  describe("list", () => {
    it("returns all sessions with correct state info", () => {
      const registry = createRegistry();
      const id1 = registry.create("/home");
      const id2 = registry.create("projects");

      const sessions = registry.list();
      expect(sessions).toHaveLength(2);

      const s1 = sessions.find((s) => s.sessionId === id1);
      expect(s1).toBeDefined();
      expect(s1!.state).toBe("running");
      expect(s1!.attachedClients).toBe(0);
      expect(s1!.createdAt).toBeGreaterThan(0);
    });

    it("returns empty array when no sessions exist", () => {
      const registry = createRegistry();
      expect(registry.list()).toEqual([]);
    });
  });

  describe("PTY exit", () => {
    it("sets state to exited with exitCode when PTY exits", () => {
      const mockPty = createMockPty();
      const mockSpawn = createMockSpawn(mockPty);
      const registry = createRegistry({}, mockSpawn);
      const id = registry.create("/home");

      // Trigger the onExit callback
      const exitCb = mockPty.onExit.mock.calls[0][0];
      exitCb({ exitCode: 0, signal: 0 });

      const info = registry.getSession(id);
      expect(info!.state).toBe("exited");
      expect(info!.exitCode).toBe(0);
    });

    it("notifies attached clients of exit", () => {
      const mockPty = createMockPty();
      const mockSpawn = createMockSpawn(mockPty);
      const registry = createRegistry({}, mockSpawn);
      const id = registry.create("/home");

      const handle = registry.attach(id)!;
      const received: PtyServerMessage[] = [];
      handle.subscribe((msg) => received.push(msg));

      const exitCb = mockPty.onExit.mock.calls[0][0];
      exitCb({ exitCode: 42, signal: 0 });

      expect(received).toContainEqual({ type: "exit", code: 42 });
    });
  });

  describe("handle.replay", () => {
    it("sends replay-start, chunks, replay-end via subscribe callback", () => {
      const mockPty = createMockPty();
      const mockSpawn = createMockSpawn(mockPty);
      const registry = createRegistry({}, mockSpawn);
      const id = registry.create("/home");

      // Simulate PTY output to fill buffer
      const dataCb = mockPty.onData.mock.calls[0][0];
      dataCb("line1\r\n");
      dataCb("line2\r\n");
      dataCb("line3\r\n");

      const handle = registry.attach(id)!;
      const received: PtyServerMessage[] = [];
      handle.subscribe((msg) => received.push(msg));
      handle.replay(0);

      expect(received[0]).toEqual({ type: "replay-start", fromSeq: 0 });
      expect(received[1]).toEqual({ type: "output", data: "line1\r\n", seq: 0 });
      expect(received[2]).toEqual({ type: "output", data: "line2\r\n", seq: 1 });
      expect(received[3]).toEqual({ type: "output", data: "line3\r\n", seq: 2 });
      expect(received[4]).toEqual({ type: "replay-end", toSeq: 3 });
    });

    it("replays from a specific sequence number", () => {
      const mockPty = createMockPty();
      const mockSpawn = createMockSpawn(mockPty);
      const registry = createRegistry({}, mockSpawn);
      const id = registry.create("/home");

      const dataCb = mockPty.onData.mock.calls[0][0];
      dataCb("a");
      dataCb("b");
      dataCb("c");

      const handle = registry.attach(id)!;
      const received: PtyServerMessage[] = [];
      handle.subscribe((msg) => received.push(msg));
      handle.replay(2);

      expect(received[0]).toEqual({ type: "replay-start", fromSeq: 2 });
      expect(received[1]).toEqual({ type: "output", data: "c", seq: 2 });
      expect(received[2]).toEqual({ type: "replay-end", toSeq: 3 });
    });

    it("replays empty buffer with just start and end", () => {
      const registry = createRegistry();
      const id = registry.create("/home");

      const handle = registry.attach(id)!;
      const received: PtyServerMessage[] = [];
      handle.subscribe((msg) => received.push(msg));
      handle.replay(0);

      expect(received).toHaveLength(2);
      expect(received[0]).toEqual({ type: "replay-start", fromSeq: 0 });
      expect(received[1]).toEqual({ type: "replay-end", toSeq: 0 });
    });
  });

  describe("handle.send", () => {
    it("forwards input to PTY write", () => {
      const mockPty = createMockPty();
      const mockSpawn = createMockSpawn(mockPty);
      const registry = createRegistry({}, mockSpawn);
      const id = registry.create("/home");
      const handle = registry.attach(id)!;

      handle.send({ type: "input", data: "hello" });
      expect(mockPty.write).toHaveBeenCalledWith("hello");
    });

    it("forwards resize to PTY resize", () => {
      const mockPty = createMockPty();
      const mockSpawn = createMockSpawn(mockPty);
      const registry = createRegistry({}, mockSpawn);
      const id = registry.create("/home");
      const handle = registry.attach(id)!;

      handle.send({ type: "resize", cols: 120, rows: 40 });
      expect(mockPty.resize).toHaveBeenCalledWith(120, 40);
    });
  });

  describe("output from PTY is sent to subscribed clients", () => {
    it("sends output with seq numbers to subscribers", () => {
      const mockPty = createMockPty();
      const mockSpawn = createMockSpawn(mockPty);
      const registry = createRegistry({}, mockSpawn);
      const id = registry.create("/home");

      const handle = registry.attach(id)!;
      const received: PtyServerMessage[] = [];
      handle.subscribe((msg) => received.push(msg));

      const dataCb = mockPty.onData.mock.calls[0][0];
      dataCb("output1");
      dataCb("output2");

      const outputs = received.filter((m) => m.type === "output");
      expect(outputs).toHaveLength(2);
      expect(outputs[0]).toEqual({ type: "output", data: "output1", seq: 0 });
      expect(outputs[1]).toEqual({ type: "output", data: "output2", seq: 1 });
    });

    it("sends output to multiple subscribers", () => {
      const mockPty = createMockPty();
      const mockSpawn = createMockSpawn(mockPty);
      const registry = createRegistry({}, mockSpawn);
      const id = registry.create("/home");

      const handle1 = registry.attach(id)!;
      const handle2 = registry.attach(id)!;
      const received1: PtyServerMessage[] = [];
      const received2: PtyServerMessage[] = [];
      handle1.subscribe((msg) => received1.push(msg));
      handle2.subscribe((msg) => received2.push(msg));

      const dataCb = mockPty.onData.mock.calls[0][0];
      dataCb("hello");

      expect(received1).toContainEqual({ type: "output", data: "hello", seq: 0 });
      expect(received2).toContainEqual({ type: "output", data: "hello", seq: 0 });
    });

    it("stops sending output after detach", () => {
      const mockPty = createMockPty();
      const mockSpawn = createMockSpawn(mockPty);
      const registry = createRegistry({}, mockSpawn);
      const id = registry.create("/home");

      const handle = registry.attach(id)!;
      const received: PtyServerMessage[] = [];
      handle.subscribe((msg) => received.push(msg));

      const dataCb = mockPty.onData.mock.calls[0][0];
      dataCb("before");

      handle.detach();
      dataCb("after");

      const outputs = received.filter((m) => m.type === "output");
      expect(outputs).toHaveLength(1);
      expect(outputs[0].type === "output" && outputs[0].data).toBe("before");
    });
  });

  describe("shutdown", () => {
    it("kills all PTY processes", () => {
      const ptys: MockPty[] = [];
      const mockSpawn = vi.fn(() => {
        const pty = createMockPty();
        ptys.push(pty);
        return pty;
      });

      const registry = createRegistry({}, mockSpawn);
      registry.create("/home");
      registry.create("/home");
      registry.create("/home");

      registry.shutdown();

      for (const pty of ptys) {
        expect(pty.kill).toHaveBeenCalledOnce();
      }

      expect(registry.list()).toEqual([]);
    });
  });

  describe("persistence", () => {
    it("creates sessions that are visible in list after create", () => {
      const registry = createRegistry();
      registry.create("/home");
      expect(registry.list()).toHaveLength(1);
    });

    it("sessions are removed from list after destroy", () => {
      const registry = createRegistry();
      const id = registry.create("/home");
      expect(registry.list()).toHaveLength(1);
      registry.destroy(id);
      expect(registry.list()).toHaveLength(0);
    });

    it("ignores corrupt persisted session files", () => {
      const homePath = mkdtempSync(join(tmpdir(), "matrix-os-session-registry-"));
      const persistPath = join(homePath, "system", "terminal-sessions.json");
      mkdirSync(join(homePath, "system"), { recursive: true });
      writeFileSync(persistPath, "{}");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      expect(() => new SessionRegistry(homePath, { persistPath }, createMockSpawn())).not.toThrow();

      warnSpy.mockRestore();
      rmSync(homePath, { recursive: true, force: true });
    });

    it("ignores persisted session arrays with invalid entries", () => {
      const homePath = mkdtempSync(join(tmpdir(), "matrix-os-session-registry-"));
      const persistPath = join(homePath, "system", "terminal-sessions.json");
      mkdirSync(join(homePath, "system"), { recursive: true });
      writeFileSync(persistPath, JSON.stringify([{ sessionId: "bad", cwd: "/tmp/test-home" }]));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      expect(() => new SessionRegistry(homePath, { persistPath }, createMockSpawn())).not.toThrow();

      expect(warnSpy).toHaveBeenCalledWith("Stale terminal sessions file has invalid entries, ignoring");
      warnSpy.mockRestore();
      rmSync(homePath, { recursive: true, force: true });
    });
  });

  describe("getSession", () => {
    it("returns session info for existing session", () => {
      const registry = createRegistry();
      const id = registry.create("/home");
      const info = registry.getSession(id);
      expect(info).not.toBeNull();
      expect(info!.sessionId).toBe(id);
      expect(info!.state).toBe("running");
    });

    it("returns null for nonexistent session", () => {
      const registry = createRegistry();
      expect(registry.getSession("550e8400-e29b-41d4-a716-446655440000")).toBeNull();
    });
  });

  describe("lastAttachedAt", () => {
    it("updates lastAttachedAt on attach", () => {
      const registry = createRegistry();
      const id = registry.create("/home");
      const before = registry.getSession(id)!.lastAttachedAt;

      // Small delay to ensure timestamp differs
      const handle = registry.attach(id)!;
      handle.subscribe(() => {});
      const after = registry.getSession(id)!.lastAttachedAt;

      expect(after).toBeGreaterThanOrEqual(before);
    });
  });
});
