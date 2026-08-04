import { describe, expect, it, vi } from "vitest";
import {
  createSupervisedZellijAdapter,
  type GatewayTerminalRuntimeClient,
} from "../../packages/gateway/src/shell/runtime-client.js";
import type { ZellijAdapter } from "../../packages/gateway/src/shell/zellij.js";

const RUNTIME_ID = "0123456789abcdef0123456789abcdef";
const LIVE = {
  runtimeId: RUNTIME_ID,
  displayName: "calm-otter",
  lifecycleState: "live" as const,
  recoverable: false,
  recoveryReason: null,
  recoveryMode: null,
  metadataRevision: 1,
};

function directAdapter() {
  const process = {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn(() => ({ dispose: vi.fn() })),
  };
  const adapter = {
    health: vi.fn(async () => ({ ok: true as const, code: "ok" as const })),
    listSessions: vi.fn(async () => []),
    focusedPaneCwd: vi.fn(async () => null),
    createSession: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
    renameSession: vi.fn(async () => undefined),
    validateLayout: vi.fn(async () => undefined),
    attachSession: vi.fn(() => process),
    sendInput: vi.fn(async () => undefined),
    listTabs: vi.fn(async () => []),
    createTab: vi.fn(async () => ({ ok: true })),
    switchTab: vi.fn(async () => ({ ok: true })),
    closeTab: vi.fn(async () => ({ ok: true })),
    splitPane: vi.fn(async () => ({ ok: true })),
    closePane: vi.fn(async () => ({ ok: true })),
    applyLayout: vi.fn(async () => ({ ok: true })),
    dumpLayout: vi.fn(async () => ({ kdl: "" })),
    setShellTheme: vi.fn(async () => undefined),
  } satisfies ZellijAdapter;
  return { adapter, process };
}

function runtimeClient(): GatewayTerminalRuntimeClient {
  return {
    list: vi.fn(async () => [LIVE]),
    inspect: vi.fn(async () => LIVE),
    createShell: vi.fn(async () => ({ ...LIVE, lifecycleState: "starting" })),
    createAgent: vi.fn(async () => ({ ...LIVE, lifecycleState: "starting" })),
    rename: vi.fn(async () => ({ ...LIVE, displayName: "swift-otter", metadataRevision: 2 })),
    delete: vi.fn(async () => undefined),
  };
}

describe("supervised shell adapter", () => {
  it("maps display names to immutable runtime identities for attach and input", async () => {
    const runtime = runtimeClient();
    const direct = directAdapter();
    const adapter = createSupervisedZellijAdapter({ runtime, zellij: direct.adapter });

    await expect(adapter.listSessions()).resolves.toEqual(["calm-otter"]);
    adapter.attachSession("calm-otter");
    await adapter.sendInput("calm-otter", "hello\r");

    expect(direct.adapter.attachSession).toHaveBeenCalledWith(
      `matrix-t-${RUNTIME_ID}`,
      {},
    );
    expect(direct.adapter.sendInput).toHaveBeenCalledWith(
      `matrix-t-${RUNTIME_ID}`,
      "hello\r",
    );
    expect(runtime.createShell).not.toHaveBeenCalled();
  });

  it("creates and deletes through the supervisor without direct zellij lifecycle calls", async () => {
    const runtime = runtimeClient();
    const direct = directAdapter();
    const adapter = createSupervisedZellijAdapter({ runtime, zellij: direct.adapter });

    await adapter.createSession({ name: "calm-otter", cwd: "/home/matrix/home/projects/example" });
    await adapter.deleteSession("calm-otter");

    expect(runtime.createShell).toHaveBeenCalledWith({
      displayName: "calm-otter",
      cwd: "/home/matrix/home/projects/example",
    });
    expect(runtime.delete).toHaveBeenCalledWith(RUNTIME_ID);
    expect(direct.adapter.createSession).not.toHaveBeenCalled();
    expect(direct.adapter.deleteSession).not.toHaveBeenCalled();
  });

  it("renames metadata without changing the zellij identity", async () => {
    const runtime = runtimeClient();
    const direct = directAdapter();
    const adapter = createSupervisedZellijAdapter({ runtime, zellij: direct.adapter });
    await adapter.listSessions();

    await adapter.renameSession("calm-otter", "swift-otter");
    adapter.attachSession("swift-otter");

    expect(runtime.rename).toHaveBeenCalledWith({
      runtimeId: RUNTIME_ID,
      displayName: "swift-otter",
      baseRevision: 1,
    });
    expect(direct.adapter.renameSession).not.toHaveBeenCalled();
    expect(direct.adapter.attachSession).toHaveBeenCalledWith(
      `matrix-t-${RUNTIME_ID}`,
      {},
    );
  });

  it("never creates or recovers while resolving an attach", () => {
    const runtime = runtimeClient();
    const direct = directAdapter();
    const adapter = createSupervisedZellijAdapter({ runtime, zellij: direct.adapter });

    expect(() => adapter.attachSession("missing-session")).toThrow("terminal_runtime_not_resolved");
    expect(runtime.createShell).not.toHaveBeenCalled();
    expect(runtime.createAgent).not.toHaveBeenCalled();
  });
});
