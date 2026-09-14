import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createUserSystemdWorkspaceLifecycle,
  workspaceRuntimeId,
} from "../../packages/terminal-runtime/src/user-systemd-workspace.js";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("project workspace systemd ownership", () => {
  it("uses one immutable runtime identity for every tab in a workspace", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-workspace-systemd-"));
    homes.push(homePath);
    const logicalName = "matrix-w-0123456789abcdef0123456789abcdef";
    const runtimeId = workspaceRuntimeId(logicalName);
    const descriptor = {
      version: 1 as const,
      runtimeId,
      sessionName: `matrix-${runtimeId}`,
      scope: "workspace" as const,
      kind: "shell" as const,
      displayName: logicalName,
      cwd: homePath,
      layoutPath: join(homePath, "system", "zellij", "runtime-layouts", `${runtimeId}-workspace.kdl`),
      generation: `gen_${"a".repeat(64)}`,
      createdAt: "2026-09-09T00:00:00.000Z",
      lifecycle: "running" as const,
    };
    const controller = {
      get: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(descriptor),
      create: vi.fn(async () => descriptor),
      start: vi.fn(async () => descriptor),
      delete: vi.fn(async () => ({ ok: true as const })),
    };
    const lifecycle = createUserSystemdWorkspaceLifecycle({ homePath, controller });

    await expect(lifecycle.ensureWorkspaceSession(logicalName, { cols: 120, rows: 36 }))
      .resolves.toEqual(expect.objectContaining({ sessionName: descriptor.sessionName }));
    await expect(lifecycle.ensureWorkspaceSession(logicalName, { cols: 160, rows: 48 }))
      .resolves.toEqual(expect.objectContaining({ sessionName: descriptor.sessionName }));
    await lifecycle.deleteWorkspaceSession(logicalName);

    expect(controller.create).toHaveBeenCalledTimes(1);
    expect(controller.create).toHaveBeenCalledWith(expect.objectContaining({
      runtimeId,
      scope: "workspace",
      displayName: logicalName,
      cwd: homePath,
    }));
    expect(controller.start).toHaveBeenCalledWith(runtimeId);
    expect(controller.delete).toHaveBeenCalledWith(runtimeId);
    expect(workspaceRuntimeId(logicalName)).toBe(runtimeId);
  });

  it("routes control operations through the descriptor-pinned Zellij generation", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-workspace-systemd-generation-"));
    homes.push(homePath);
    const logicalName = "matrix-w-fedcba9876543210fedcba9876543210";
    const runtimeId = workspaceRuntimeId(logicalName);
    const pinnedGeneration = `gen_${"b".repeat(64)}`;
    const descriptor = {
      version: 1 as const,
      runtimeId,
      sessionName: `matrix-${runtimeId}`,
      scope: "workspace" as const,
      kind: "shell" as const,
      displayName: logicalName,
      cwd: homePath,
      layoutPath: join(homePath, "system", "zellij", "runtime-layouts", `${runtimeId}-workspace.kdl`),
      generation: pinnedGeneration,
      createdAt: "2026-09-09T00:00:00.000Z",
      lifecycle: "running" as const,
    };
    const controller = {
      get: vi.fn(async () => descriptor),
      create: vi.fn(async () => descriptor),
      start: vi.fn(async () => descriptor),
      delete: vi.fn(async () => ({ ok: true as const })),
    };
    const terminalRuntimeRoot = "/opt/matrix/terminal-runtime";
    const lifecycle = createUserSystemdWorkspaceLifecycle({
      homePath,
      controller,
      terminalRuntimeRoot,
    });

    await expect(lifecycle.resolveWorkspaceTarget(logicalName)).resolves.toEqual({
      sessionName: descriptor.sessionName,
      binaryPath: join(terminalRuntimeRoot, "generations", pinnedGeneration, "zellij"),
    });
    await expect(lifecycle.ensureWorkspaceSession(logicalName, { cols: 120, rows: 36 }))
      .resolves.toEqual({
        sessionName: descriptor.sessionName,
        binaryPath: join(terminalRuntimeRoot, "generations", pinnedGeneration, "zellij"),
      });
  });
});
