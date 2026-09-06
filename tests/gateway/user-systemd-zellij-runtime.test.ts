import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUserSystemdZellijRuntime, workspaceRuntimeId } from "../../packages/gateway/src/user-systemd-zellij-runtime.js";
import type { ZellijAdapter } from "../../packages/gateway/src/shell/zellij.js";

const GENERATION = "gen_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SESSION_ID = "sess_demo";

function fakeAdapter(): ZellijAdapter {
  return {
    health: vi.fn(async () => ({ ok: true, code: "ok" })), listSessions: vi.fn(async () => []),
    focusedPaneRuntime: vi.fn(async () => ({ cwd: null, command: null, observed: false })), createSession: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined), renameSession: vi.fn(async () => undefined),
    validateLayout: vi.fn(async () => undefined), attachSession: vi.fn() as never,
    sendInput: vi.fn(async () => undefined), listTabs: vi.fn(async () => []),
    createTab: vi.fn(async () => ({})), switchTab: vi.fn(async () => ({})), switchTabById: vi.fn(async () => ({})),
    closeTab: vi.fn(async () => ({})),
    splitPane: vi.fn(async () => ({})), closePane: vi.fn(async () => ({})), applyLayout: vi.fn(async () => ({})),
    dumpLayout: vi.fn(async () => ({})), setShellTheme: vi.fn(async () => undefined),
  };
}

describe("user-systemd workspace Zellij runtime", () => {
  let homePath: string;

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-user-systemd-workspace-"));
    await mkdir(join(homePath, "system", "zellij", "layouts"), { recursive: true });
    await writeFile(join(homePath, "system", "zellij", "layouts", `${SESSION_ID}.kdl`), "layout { pane }\n");
  });

  afterEach(async () => {
    await rm(homePath, { recursive: true, force: true });
  });

  it("maps workspace sessions to stable immutable runtime IDs", () => {
    expect(workspaceRuntimeId(SESSION_ID)).toBe(workspaceRuntimeId(SESSION_ID));
    expect(workspaceRuntimeId(SESSION_ID)).toMatch(/^rt_[0-9a-f]{32}$/);
    expect(workspaceRuntimeId("sess_other")).not.toBe(workspaceRuntimeId(SESSION_ID));
  });

  it("starts the generated agent layout in the typed user-systemd runtime", async () => {
    const controller = {
      create: vi.fn(async (input) => ({
        version: 1 as const,
        sessionName: `matrix-${input.runtimeId}`,
        generation: GENERATION,
        createdAt: "2026-07-31T12:00:00.000Z",
        lifecycle: "running" as const,
        ...input,
      })),
      delete: vi.fn(),
      get: vi.fn(),
      isRunning: vi.fn(async () => true),
    };
    const generated = {
      generateLayout: vi.fn(async () => ({ sessionName: "legacy", layoutPath: join(homePath, "system", "zellij", "layouts", `${SESSION_ID}.kdl`) })),
    };
    const runtime = createUserSystemdZellijRuntime({
      homePath,
      generation: GENERATION,
      controller,
      layoutRuntime: generated,
      baseAdapter: fakeAdapter(),
      adapterFactory: vi.fn(() => fakeAdapter()),
    });

    const result = await runtime.start({
      sessionId: SESSION_ID,
      launch: { command: "codex", args: [], cwd: homePath, env: { MATRIX_NODE_PREFIX: "/opt/matrix/runtime/node" } },
    });

    expect(controller.create).toHaveBeenCalledWith(expect.objectContaining({
      runtimeId: workspaceRuntimeId(SESSION_ID),
      scope: "workspace",
      kind: "agent",
      displayName: SESSION_ID,
      cwd: homePath,
      layoutPath: expect.stringMatching(new RegExp(`runtime-layouts/${workspaceRuntimeId(SESSION_ID)}-[0-9a-f]{16}\\.kdl$`)),
      environmentPath: expect.stringMatching(new RegExp(`${workspaceRuntimeId(SESSION_ID)}-[0-9a-f]{16}\\.json$`)),
    }));
    const createInput = controller.create.mock.calls[0]?.[0];
    await expect(readFile(createInput.environmentPath, "utf8")).resolves.toContain('"MATRIX_NODE_PREFIX"');
    expect(result).toMatchObject({
      ok: true,
      status: "running",
      sessionName: `matrix-${workspaceRuntimeId(SESSION_ID)}`,
      publicSessionName: SESSION_ID,
      createdAt: "2026-07-31T12:00:00.000Z",
    });
  });

  it("rejects launch environment keys outside the fixed runtime allowlist", async () => {
    const controller = { create: vi.fn(), delete: vi.fn(), get: vi.fn(), isRunning: vi.fn() };
    const runtime = createUserSystemdZellijRuntime({
      homePath,
      generation: GENERATION,
      controller,
      layoutRuntime: {
        generateLayout: vi.fn(async () => ({
          sessionName: "legacy",
          layoutPath: join(homePath, "system", "zellij", "layouts", `${SESSION_ID}.kdl`),
        })),
      },
      baseAdapter: fakeAdapter(),
    });

    await expect(runtime.start({
      sessionId: SESSION_ID,
      launch: { command: "codex", args: [], cwd: homePath, env: { LD_PRELOAD: "/tmp/hostile.so" } },
    })).rejects.toThrow();

    expect(controller.create).not.toHaveBeenCalled();
  });

  it("uses the fixed attach helper and descriptor-pinned binary for input and deletion", async () => {
    const runtimeId = workspaceRuntimeId(SESSION_ID);
    const stored = {
      version: 1 as const,
      runtimeId,
      sessionName: `matrix-${runtimeId}`,
      scope: "workspace" as const,
      kind: "agent" as const,
      displayName: SESSION_ID,
      cwd: homePath,
      layoutPath: join(homePath, "system", "zellij", "layouts", `${SESSION_ID}.kdl`),
      generation: GENERATION,
      createdAt: "2026-07-31T12:00:00.000Z",
    };
    const controller = {
      create: vi.fn(),
      delete: vi.fn(async () => ({ ok: true })),
      get: vi.fn(async () => stored),
      isRunning: vi.fn(async () => true),
    };
    const pinned = fakeAdapter();
    const adapterFactory = vi.fn(() => pinned);
    const runtime = createUserSystemdZellijRuntime({
      homePath,
      generation: GENERATION,
      controller,
      layoutRuntime: { generateLayout: vi.fn() },
      baseAdapter: fakeAdapter(),
      adapterFactory,
    });

    expect(runtime.attachCommand(SESSION_ID)).toEqual(["matrix-terminal-attach", runtimeId]);
    expect(runtime.observeCommand(SESSION_ID)).toEqual(["matrix-terminal-attach", runtimeId, "--index", "0"]);
    await runtime.sendInput(SESSION_ID, "echo safe");
    await runtime.kill(SESSION_ID);
    await expect(runtime.isAlive(SESSION_ID)).resolves.toBe(true);

    expect(adapterFactory).toHaveBeenCalledWith(`/opt/matrix/terminal-runtime/generations/${GENERATION}/zellij`);
    expect(pinned.sendInput).toHaveBeenCalledWith(stored.sessionName, "echo safe");
    expect(controller.delete).toHaveBeenCalledWith(runtimeId);
    expect(controller.isRunning).toHaveBeenCalledWith(runtimeId);
  });
});
