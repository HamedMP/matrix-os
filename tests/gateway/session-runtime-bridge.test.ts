import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionRuntimeBridge } from "../../packages/gateway/src/session-runtime-bridge.js";
import { SessionRegistry } from "../../packages/gateway/src/session-registry.js";
import type { WorkspaceSession } from "../../packages/gateway/src/agent-session-manager.js";

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

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("session-runtime-bridge", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = mkdtempSync(join(tmpdir(), "matrix-session-runtime-bridge-"));
    mkdirSync(join(homePath, "system"), { recursive: true });
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function createSession(overrides: Partial<WorkspaceSession> = {}): WorkspaceSession {
    return {
      id: "sess_abc123",
      kind: "agent",
      projectSlug: "repo",
      worktreeId: "wt_abc123def456",
      agent: "codex",
      runtime: {
        type: "zellij",
        status: "running",
        zellijSession: "matrix-sess_abc123",
        zellijLayoutPath: join(homePath, "system", "zellij", "layouts", "sess_abc123.kdl"),
      },
      terminalSessionId: "term_pending",
      transcriptPath: join(homePath, "system", "session-output", "sess_abc123.jsonl"),
      attachedClients: 0,
      writeMode: "owner",
      ownerId: "user_a",
      startedAt: "2026-04-26T00:00:00.000Z",
      lastActivityAt: "2026-04-26T00:00:00.000Z",
      ...overrides,
    };
  }

  it("registers a Zellij attach process with the terminal registry using argv execution", () => {
    const mockPty = createMockPty();
    const spawn = vi.fn(() => mockPty);
    const registry = new SessionRegistry(
      homePath,
      { persistPath: join(homePath, "system", "terminal-sessions.json") },
      spawn,
    );
    const zellijRuntime = {
      attachCommand: vi.fn((sessionId: string) => ["zellij", "attach", `matrix-${sessionId}`]),
      observeCommand: vi.fn((sessionId: string) => ["zellij", "attach", `matrix-${sessionId}`, "--index", "0"]),
    };
    const bridge = createSessionRuntimeBridge({ homePath, registry, zellijRuntime });

    const result = bridge.registerSession(createSession(), { mode: "owner" });

    expect(result).toMatchObject({ ok: true, mode: "owner" });
    if (!result.ok) return;
    expect(result.terminalSessionId).toMatch(UUID_REGEX);
    expect(registry.getSession(result.terminalSessionId)).toMatchObject({
      sessionId: result.terminalSessionId,
      cwd: homePath,
      shell: "zellij",
      state: "running",
    });
    expect(spawn).toHaveBeenCalledWith(
      "zellij",
      ["attach", "matrix-sess_abc123"],
      expect.objectContaining({ cwd: homePath }),
    );
    expect(spawn.mock.calls[0]?.[0]).toBe("zellij");
    expect(spawn.mock.calls[0]?.[1]).not.toContain("-c");
  });

  it("registers read-only observe attaches separately from write-owner attaches", () => {
    const spawn = vi.fn(() => createMockPty());
    const registry = new SessionRegistry(
      homePath,
      { persistPath: join(homePath, "system", "terminal-sessions.json") },
      spawn,
    );
    const zellijRuntime = {
      attachCommand: vi.fn((sessionId: string) => ["zellij", "attach", `matrix-${sessionId}`]),
      observeCommand: vi.fn((sessionId: string) => ["zellij", "attach", `matrix-${sessionId}`, "--index", "0"]),
    };
    const bridge = createSessionRuntimeBridge({ homePath, registry, zellijRuntime });

    const result = bridge.registerSession(createSession(), { mode: "observe" });

    expect(result).toMatchObject({ ok: true, mode: "observe" });
    expect(spawn).toHaveBeenCalledWith(
      "zellij",
      ["attach", "matrix-sess_abc123", "--index", "0"],
      expect.any(Object),
    );
  });

  it("supports tmux runtime records without zellij metadata", () => {
    const spawn = vi.fn(() => createMockPty());
    const registry = new SessionRegistry(
      homePath,
      { persistPath: join(homePath, "system", "terminal-sessions.json") },
      spawn,
    );
    const bridge = createSessionRuntimeBridge({
      homePath,
      registry,
      zellijRuntime: {
        attachCommand: vi.fn(),
        observeCommand: vi.fn(),
      },
    });

    const result = bridge.registerSession(createSession({
      runtime: {
        type: "tmux",
        status: "running",
        tmuxSession: "matrix-sess_abc123",
      },
    }), { mode: "owner" });

    expect(result).toMatchObject({ ok: true });
    expect(spawn).toHaveBeenCalledWith(
      "tmux",
      ["attach-session", "-t", "matrix-sess_abc123"],
      expect.any(Object),
    );
  });

  it("rejects unavailable sessions and unsupported runtimes without spawning a process", () => {
    const spawn = vi.fn(() => createMockPty());
    const registry = new SessionRegistry(
      homePath,
      { persistPath: join(homePath, "system", "terminal-sessions.json") },
      spawn,
    );
    const bridge = createSessionRuntimeBridge({
      homePath,
      registry,
      zellijRuntime: {
        attachCommand: vi.fn(),
        observeCommand: vi.fn(),
      },
    });

    expect(bridge.registerSession(createSession({
      runtime: {
        type: "zellij",
        status: "degraded",
        zellijSession: "matrix-sess_abc123",
      },
    }), { mode: "owner" })).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "session_unavailable" },
    });

    expect(bridge.registerSession(createSession({
      runtime: {
        type: "pty",
        status: "running",
      },
    }), { mode: "owner" })).toMatchObject({
      ok: false,
      status: 400,
      error: { code: "runtime_unsupported" },
    });

    expect(spawn).not.toHaveBeenCalled();
  });
});
