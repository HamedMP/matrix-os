import { describe, expect, it, vi } from "vitest";
import { createSessionRuntimeBridge } from "../../packages/gateway/src/session-runtime-bridge.js";

const TERMINAL_REF = {
  workspaceId: "tws_00000000000000000000000000000001",
  tabId: "tt_00000000000000000000000000000001",
} as const;

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: "sess_abc123",
    kind: "agent",
    ownerId: "owner_user",
    runtime: { type: "zellij", status: "running" },
    terminalRef: TERMINAL_REF,
    ...overrides,
  } as never;
}

describe("session runtime bridge", () => {
  const bridge = createSessionRuntimeBridge({
    homePath: "/home/matrix/home",
    registry: { registerExternal: vi.fn(), getSession: vi.fn() } as never,
    zellijRuntime: { attachCommand: vi.fn(), observeCommand: vi.fn() } as never,
  });

  it("returns the stable workspace/tab ref without spawning a compatibility PTY", () => {
    expect(bridge.registerSession(session(), { mode: "owner" })).toEqual({
      ok: true,
      mode: "owner",
      terminalRef: TERMINAL_REF,
    });
    expect(bridge.registerSession(session(), { mode: "observe" })).toEqual({
      ok: true,
      mode: "observe",
      terminalRef: TERMINAL_REF,
    });
  });

  it("rejects closed and legacy native-multiplexer records", () => {
    expect(bridge.registerSession(session({ runtime: { type: "zellij", status: "exited" } }), { mode: "owner" }))
      .toMatchObject({ ok: false, status: 409 });
    expect(bridge.registerSession(session({ runtime: { type: "tmux", status: "running" } }), { mode: "owner" }))
      .toMatchObject({ ok: false, status: 400, error: { code: "runtime_unsupported" } });
  });
});
