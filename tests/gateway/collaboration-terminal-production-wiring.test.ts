import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordingRuntime, startupOptions, type EnabledSurfaces } from "./collaboration-startup-harness.js";

// Only the collaboration runtime itself is stubbed: the startup module, the canonical
// terminal bridge and the owner surface composition all run for real, so the order the
// surfaces are enabled in is observed rather than read out of the source text.
const surfaces: EnabledSurfaces = { order: [] };
vi.mock("../../packages/gateway/src/collaboration/wiring.js", async (importActual) => {
  const actual = await importActual<typeof import("../../packages/gateway/src/collaboration/wiring.js")>();
  return { ...actual, createGatewayCollaboration: async () => recordingRuntime(surfaces) };
});

const { constructOwnerCollaboration } = await import("../../packages/gateway/src/startup/collaboration.js");

const runtimeSource = readFileSync(fileURLToPath(new URL(
  "../../packages/terminal-runtime/src/socket-client.ts", import.meta.url,
)), "utf8");

describe("production shared-terminal composition", () => {
  let homePath: string;

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-wiring-"));
    surfaces.order = [];
    surfaces.terminal = undefined;
    surfaces.resources = undefined;
    surfaces.project = undefined;
  });

  afterEach(async () => {
    surfaces.resources?.driver.close();
    await rm(homePath, { recursive: true, force: true });
  });

  it("enables the canonical shared terminal before the shared project surface", async () => {
    const construction = await constructOwnerCollaboration(startupOptions(homePath));
    expect(construction.ok).toBe(true);
    // The terminal bridge must exist on the runtime before the surfaces the
    // collaboration package composes, and the project surface is the last of them.
    expect(surfaces.order).toEqual(["terminal", "resources", "git", "project"]);
    expect(surfaces.order.indexOf("terminal")).toBeLessThan(surfaces.order.indexOf("project"));
  });

  it("enables a workspace/tab bridge rather than a stub, under the terminal eligibility profile", async () => {
    await constructOwnerCollaboration(startupOptions(homePath));
    const terminal = surfaces.terminal as {
      registry: Record<string, unknown>;
      runtime: { resize(input: unknown): Promise<void> };
      connectOutput: unknown;
      executionEligibility: Record<string, unknown>;
    };
    for (const surface of ["get", "bindCollaboration", "setContributorControl", "unbindCollaboration"]) {
      expect(typeof terminal.registry[surface]).toBe("function");
    }
    expect(typeof terminal.connectOutput).toBe("function");
    // The canonical bridge refuses workspace-wide resize; a stub would not.
    await expect(terminal.runtime.resize({})).rejects.toThrow("Shared terminal is unavailable");
    expect(terminal.executionEligibility).toMatchObject({
      adapterId: "terminal", profileId: "scope-runtime-terminal-v1", profileVersion: 1,
    });
    expect(terminal.executionEligibility.profileDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses to compose when the runtime has no configured owner", async () => {
    // The bridge is bound to one owner; an unconfigured runtime must fail closed
    // rather than expose the host shell, and the partial runtime is shut down.
    const construction = await constructOwnerCollaboration(startupOptions(homePath, {
      collaborationConfig: { ownerId: undefined } as never,
    }));
    expect(construction).toEqual({ ok: false, reason: "construction_failed" });
    expect(surfaces.order).toEqual([]);
  });

  it("requires a workspace/tab bridge rather than the retired name-based shell API", () => {
    expect(runtimeSource).toContain("async listWorkspaces()");
    expect(runtimeSource).toContain("async writeInput(");
    expect(runtimeSource).toContain("async terminateTab(");
    expect(runtimeSource).not.toContain("async bindCollaboration(");
  });
});
