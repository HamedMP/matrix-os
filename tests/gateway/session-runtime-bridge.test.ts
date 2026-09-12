import { describe, expect, it, vi } from "vitest";
import {
  createProviderLoginTerminalRegistry,
  createSessionRuntimeBridge,
  resolveTerminalAttachmentMode,
  terminalAttachmentAllowsFrame,
} from "../../packages/gateway/src/session-runtime-bridge.js";

const TERMINAL_REF = {
  workspaceId: "tws_00000000000000000000000000000001",
  tabId: "tt_00000000000000000000000000000001",
} as const;

const ACTIVE_TAB = {
  id: TERMINAL_REF.tabId,
  workspaceId: TERMINAL_REF.workspaceId,
  name: "provider-auth-codex",
  cwd: "",
  status: "running",
  revision: 3,
  order: 0,
  agent: { providerId: "codex" },
  createdAt: "2026-09-07T00:00:00.000Z",
  updatedAt: "2026-09-07T00:00:01.000Z",
} as const;

const MAIN_WORKSPACE = {
  id: TERMINAL_REF.workspaceId,
  scope: "main",
  canonicalSize: { cols: 120, rows: 36 },
  status: "running",
  revision: 4,
  createdAt: "2026-09-07T00:00:00.000Z",
  updatedAt: "2026-09-07T00:00:01.000Z",
  tabs: [ACTIVE_TAB],
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
  const tokens = ["a".repeat(48), "b".repeat(48), "c".repeat(48)];
  let tokenIndex = 0;
  const bridge = createSessionRuntimeBridge({
    createAttachmentToken: () => tokens[tokenIndex++]!,
    now: () => 1_000,
  });

  it("returns the stable workspace/tab ref without spawning a compatibility PTY", () => {
    expect(bridge.registerSession(session(), { mode: "owner" })).toEqual({
      ok: true,
      mode: "owner",
      terminalRef: TERMINAL_REF,
      attachmentToken: tokens[0],
    });
    expect(bridge.registerSession(session(), { mode: "observe" })).toEqual({
      ok: true,
      mode: "observe",
      terminalRef: TERMINAL_REF,
      attachmentToken: tokens[1],
    });
  });

  it("consumes an attachment capability once and binds it to owner and terminal", () => {
    const registered = bridge.registerSession(session(), { mode: "observe" });
    expect(registered).toMatchObject({ ok: true });
    if (!registered.ok) throw new Error("Expected an attachment capability");

    expect(bridge.consumeSessionAttachment({
      attachmentToken: registered.attachmentToken,
      ownerId: "owner_user",
      terminalRef: TERMINAL_REF,
    })).toEqual({ ok: true, mode: "observe" });
    expect(bridge.consumeSessionAttachment({
      attachmentToken: registered.attachmentToken,
      ownerId: "owner_user",
      terminalRef: TERMINAL_REF,
    })).toMatchObject({ ok: false, status: 403 });
  });

  it("rejects capabilities presented for another owner without leaving them reusable", () => {
    const isolated = createSessionRuntimeBridge({
      createAttachmentToken: () => "d".repeat(48),
      now: () => 1_000,
    });
    const registered = isolated.registerSession(session(), { mode: "owner" });
    if (!registered.ok) throw new Error("Expected an attachment capability");

    expect(isolated.consumeSessionAttachment({
      attachmentToken: registered.attachmentToken,
      ownerId: "other_owner",
      terminalRef: TERMINAL_REF,
    })).toMatchObject({ ok: false, status: 403 });
    expect(isolated.consumeSessionAttachment({
      attachmentToken: registered.attachmentToken,
      ownerId: "owner_user",
      terminalRef: TERMINAL_REF,
    })).toMatchObject({ ok: false, status: 403 });
  });

  it("prevents observe attachments from writing input or hard-resizing the shared tab", () => {
    expect(terminalAttachmentAllowsFrame("observe", {
      type: "input",
      terminalRef: TERMINAL_REF,
      data: "rm -rf project",
    })).toBe(false);
    expect(terminalAttachmentAllowsFrame("observe", {
      type: "binary",
      terminalRef: TERMINAL_REF,
      dataBase64: "Gw==",
    })).toBe(false);
    expect(terminalAttachmentAllowsFrame("observe", {
      type: "resize",
      terminalRef: TERMINAL_REF,
      mode: "hard",
      size: { cols: 120, rows: 36 },
    })).toBe(false);
    expect(terminalAttachmentAllowsFrame("observe", {
      type: "resize",
      terminalRef: TERMINAL_REF,
      mode: "soft",
      size: { cols: 120, rows: 36 },
    })).toBe(true);
    expect(terminalAttachmentAllowsFrame("owner", {
      type: "input",
      terminalRef: TERMINAL_REF,
      data: "pwd\n",
    })).toBe(true);
  });

  it("requires a capability for session-bound refs while preserving direct owner tabs", async () => {
    const consumeSessionAttachment = vi.fn(() => ({ ok: true as const, mode: "observe" as const }));

    await expect(resolveTerminalAttachmentMode({
      ownerId: "owner_user",
      terminalRef: TERMINAL_REF,
    }, {
      consumeSessionAttachment,
      requiresAttachmentToken: vi.fn(async () => true),
    })).rejects.toThrow("capability required");

    await expect(resolveTerminalAttachmentMode({
      ownerId: "owner_user",
      terminalRef: TERMINAL_REF,
    }, {
      consumeSessionAttachment,
      requiresAttachmentToken: vi.fn(async () => false),
    })).resolves.toBe("owner");

    await expect(resolveTerminalAttachmentMode({
      attachmentToken: "a".repeat(48),
      ownerId: "owner_user",
      terminalRef: TERMINAL_REF,
    }, {
      consumeSessionAttachment,
      requiresAttachmentToken: vi.fn(async () => true),
    })).resolves.toBe("observe");
  });

  it("rejects closed and legacy native-multiplexer records", () => {
    expect(bridge.registerSession(session({ runtime: { type: "zellij", status: "exited" } }), { mode: "owner" }))
      .toMatchObject({ ok: false, status: 409 });
    expect(bridge.registerSession(session({ runtime: { type: "tmux", status: "running" } }), { mode: "owner" }))
      .toMatchObject({ ok: false, status: 400, error: { code: "runtime_unsupported" } });
  });
});

describe("provider login terminal registry", () => {
  it("creates provider login commands as shared-runtime tabs", async () => {
    const created = { ...ACTIVE_TAB, name: "provider-auth-claude", agent: { providerId: "claude" } };
    const runtime = {
      listWorkspaces: vi.fn(async () => [{ ...MAIN_WORKSPACE, tabs: [] }]),
      ensureWorkspace: vi.fn(async () => ({ ...MAIN_WORKSPACE, tabs: [] })),
      createTab: vi.fn(async () => created),
      renameTab: vi.fn(),
      terminateTab: vi.fn(),
    };
    const registry = createProviderLoginTerminalRegistry(runtime);

    await expect(registry.create({
      name: created.name,
      cwd: "~",
      cmd: "claude",
      agent: "claude",
      exclusive: false,
    })).resolves.toEqual({ name: created.name });
    expect(runtime.createTab).toHaveBeenCalledWith(MAIN_WORKSPACE.id, {
      name: created.name,
      cwd: "",
      command: ["sh", "-lc", "claude"],
      agent: { providerId: "claude" },
    });
  });

  it("resolves, renames, and deletes provider tabs by their durable name", async () => {
    const renamed = { ...ACTIVE_TAB, name: "provider-auth-renamed", revision: 4 };
    const runtime = {
      listWorkspaces: vi.fn(async () => [MAIN_WORKSPACE]),
      ensureWorkspace: vi.fn(),
      createTab: vi.fn(),
      renameTab: vi.fn(async () => renamed),
      terminateTab: vi.fn(async () => undefined),
    };
    const registry = createProviderLoginTerminalRegistry(runtime);

    await expect(registry.get(ACTIVE_TAB.name)).resolves.toEqual({ name: ACTIVE_TAB.name });
    await expect(registry.rename(ACTIVE_TAB.name, renamed.name)).resolves.toEqual({ name: renamed.name });
    expect(runtime.renameTab).toHaveBeenCalledWith(TERMINAL_REF, {
      name: renamed.name,
      baseRevision: ACTIVE_TAB.revision,
    });
    await expect(registry.delete(ACTIVE_TAB.name)).resolves.toBeUndefined();
    expect(runtime.terminateTab).toHaveBeenCalledWith(TERMINAL_REF);
  });

  it("fails closed for missing or ambiguous durable names", async () => {
    const runtime = {
      listWorkspaces: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([MAIN_WORKSPACE, { ...MAIN_WORKSPACE, id: "tws_00000000000000000000000000000002" }])
        .mockResolvedValueOnce([]),
      ensureWorkspace: vi.fn(),
      createTab: vi.fn(),
      renameTab: vi.fn(),
      terminateTab: vi.fn(),
    };
    const registry = createProviderLoginTerminalRegistry(runtime);

    await expect(registry.get(ACTIVE_TAB.name)).rejects.toMatchObject({ code: "session_not_found" });
    await expect(registry.get(ACTIVE_TAB.name)).rejects.toThrow("Provider terminal identity is ambiguous");
    await expect(registry.delete(ACTIVE_TAB.name, { force: true })).resolves.toBeUndefined();
    expect(runtime.terminateTab).not.toHaveBeenCalled();
  });

  it("reports liveness only for the matching active provider tab", async () => {
    const runtime = {
      listWorkspaces: vi.fn(async () => [MAIN_WORKSPACE]),
      ensureWorkspace: vi.fn(),
      createTab: vi.fn(),
      renameTab: vi.fn(),
      terminateTab: vi.fn(),
    };
    const registry = createProviderLoginTerminalRegistry(runtime);

    await expect(registry.observeAgentLiveness(ACTIVE_TAB.name, "codex")).resolves.toBe("running");
    await expect(registry.observeAgentLiveness(ACTIVE_TAB.name, "claude")).resolves.toBe("stopped");
  });
});
