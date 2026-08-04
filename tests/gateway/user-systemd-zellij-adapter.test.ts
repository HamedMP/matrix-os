import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUserSystemdZellijAdapter } from "../../packages/gateway/src/shell/user-systemd-zellij-adapter.js";
import type { UserSystemdTerminalDescriptor } from "../../packages/gateway/src/shell/user-systemd-terminal-runtime.js";
import type { ZellijAdapter } from "../../packages/gateway/src/shell/zellij.js";

const RUNTIME_ID = "rt_0123456789abcdef0123456789abcdef";
const GENERATION = "gen_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function descriptor(overrides: Partial<UserSystemdTerminalDescriptor> = {}): UserSystemdTerminalDescriptor {
  return {
    version: 1,
    runtimeId: RUNTIME_ID,
    sessionName: `matrix-${RUNTIME_ID}`,
    scope: "terminal",
    kind: "shell",
    displayName: "Main",
    cwd: "/home/matrix/home",
    layoutPath: "/home/matrix/home/system/zellij/layouts/default.kdl",
    generation: GENERATION,
    createdAt: "2026-07-31T12:00:00.000Z",
    ...overrides,
  };
}

function fakeAdapter(): ZellijAdapter {
  return {
    health: vi.fn(async () => ({ ok: true, code: "ok" })),
    listSessions: vi.fn(async () => []),
    focusedPaneRuntime: vi.fn(async () => ({ cwd: null, command: null, observed: false })),
    createSession: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
    renameSession: vi.fn(async () => undefined),
    validateLayout: vi.fn(async () => undefined),
    attachSession: vi.fn(() => ({
      write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
    })),
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
  };
}

describe("user-systemd zellij adapter", () => {
  let homePath: string;
  let base: ZellijAdapter;
  let pinned: ZellijAdapter;
  let controller: {
    create: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    findByDisplayName: ReturnType<typeof vi.fn>;
    renameDisplayName: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-user-systemd-adapter-"));
    await mkdir(join(homePath, "system", "zellij", "layouts"), { recursive: true });
    await writeFile(join(homePath, "system", "zellij", "layouts", "default.kdl"), "layout { pane }\n");
    base = fakeAdapter();
    pinned = fakeAdapter();
    controller = {
      create: vi.fn(async (input) => ({ ...descriptor(input), lifecycle: "running" })),
      start: vi.fn(async () => ({ ...descriptor(), lifecycle: "running" })),
      delete: vi.fn(async () => ({ ok: true })),
      get: vi.fn(async () => null),
      list: vi.fn(async () => []),
      findByDisplayName: vi.fn(async () => null),
      renameDisplayName: vi.fn(async (_id, displayName) => descriptor({ displayName })),
    };
  });

  afterEach(async () => {
    await rm(homePath, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("creates command sessions through the typed controller without spawning from the gateway", async () => {
    const adapter = createUserSystemdZellijAdapter({
      homePath,
      generation: GENERATION,
      controller,
      baseAdapter: base,
      adapterFactory: vi.fn(() => pinned),
      runtimeIdGenerator: () => RUNTIME_ID,
    });

    await adapter.createSession({ name: "Main", cwd: homePath, cmd: "codex --help" });

    expect(controller.create).toHaveBeenCalledWith(expect.objectContaining({
      runtimeId: RUNTIME_ID,
      scope: "terminal",
      kind: "shell",
      displayName: "Main",
      cwd: homePath,
      layoutPath: join(homePath, "system", "zellij", "runtime-layouts", `${RUNTIME_ID}.kdl`),
    }));
    expect(base.createSession).not.toHaveBeenCalled();
    const layout = await readFile(join(homePath, "system", "zellij", "runtime-layouts", `${RUNTIME_ID}.kdl`), "utf8");
    expect(layout).toContain('args "codex" "--help"');
    expect(layout).not.toContain("codex --help");
  });

  it("routes all live-session operations through the descriptor-pinned binary and immutable name", async () => {
    const live = descriptor({ cwd: homePath });
    controller.list.mockResolvedValue([live]);
    controller.findByDisplayName.mockResolvedValue(live);
    const adapterFactory = vi.fn(() => pinned);
    const adapter = createUserSystemdZellijAdapter({
      homePath,
      generation: GENERATION,
      controller,
      baseAdapter: base,
      adapterFactory,
    });

    await expect(adapter.listSessions()).resolves.toEqual(["Main"]);
    await adapter.sendInput("Main", "echo safe");
    adapter.attachSession("Main");

    expect(controller.list).toHaveBeenCalledWith({ scope: "terminal", runningOnly: true });
    expect(adapterFactory).toHaveBeenCalledWith(
      `/opt/matrix/terminal-runtime/generations/${GENERATION}/zellij`,
    );
    expect(pinned.sendInput).toHaveBeenCalledWith(live.sessionName, "echo safe");
    expect(pinned.attachSession).toHaveBeenCalledWith(live.sessionName, {});
  });

  it("renames metadata only and deletes the immutable unit through the controller", async () => {
    const live = descriptor({ cwd: homePath });
    controller.findByDisplayName.mockResolvedValue(live);
    const adapter = createUserSystemdZellijAdapter({
      homePath,
      generation: GENERATION,
      controller,
      baseAdapter: base,
      adapterFactory: vi.fn(() => pinned),
    });

    await adapter.renameSession("Main", "Renamed");
    await adapter.deleteSession("Main", { force: true });

    expect(controller.renameDisplayName).toHaveBeenCalledWith(RUNTIME_ID, "Renamed");
    expect(pinned.renameSession).not.toHaveBeenCalled();
    expect(controller.delete).toHaveBeenCalledWith(RUNTIME_ID);
  });

  it("makes repeated forced deletion succeed after the descriptor is already absent", async () => {
    controller.findByDisplayName.mockResolvedValue(null);
    const adapter = createUserSystemdZellijAdapter({
      homePath,
      generation: GENERATION,
      controller,
      baseAdapter: base,
      adapterFactory: vi.fn(() => pinned),
    });

    await expect(adapter.deleteSession("already-gone", { force: true })).resolves.toBeUndefined();

    expect(controller.delete).not.toHaveBeenCalled();
  });

  it("leaves an existing inactive descriptor interrupted instead of restarting its workload", async () => {
    const existing = descriptor({ cwd: homePath });
    controller.findByDisplayName.mockResolvedValue(existing);
    const adapter = createUserSystemdZellijAdapter({
      homePath,
      generation: GENERATION,
      controller,
      baseAdapter: base,
      adapterFactory: vi.fn(() => pinned),
      runtimeIdGenerator: () => "rt_ffffffffffffffffffffffffffffffff",
    });

    await expect(adapter.createSession({ name: "Main", cwd: homePath })).rejects.toMatchObject({
      code: "session_interrupted",
      status: 409,
    });

    expect(controller.start).not.toHaveBeenCalled();
    expect(controller.create).not.toHaveBeenCalled();
  });
});
