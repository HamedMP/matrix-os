import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminalAgentServices } from "../../packages/gateway/src/terminal-agent/services.js";

const workspaceId = `tws_${"0".repeat(32)}`;
const tabId = `tt_${"1".repeat(32)}`;
const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function services(ownerIds: string[]) {
  const home = await mkdtemp(join(tmpdir(), "matrix-terminal-services-"));
  roots.push(home);
  const writes: string[] = [];
  const runtime = {
    listWorkspaces: async () => [{
      id: workspaceId, scope: "project", projectId: "app", canonicalSize: { cols: 80, rows: 24 }, status: "running", revision: 1,
      createdAt: "2026-11-11T10:00:00.000Z", updatedAt: "2026-11-11T10:00:00.000Z",
      tabs: [{ id: tabId, workspaceId, name: "t", cwd: "", status: "running", revision: 1, order: 0, accessScope: "owner",
        createdAt: "2026-11-11T10:00:00.000Z", updatedAt: "2026-11-11T10:00:00.000Z" }],
    }],
    getSnapshot: async () => undefined,
    writeInput: async (_ref: unknown, data: string) => { writes.push(data); },
    listAgentStatuses: async () => [],
    ensureWorkspace: async () => ({ id: workspaceId }),
    createTab: async () => ({ id: tabId }),
  };
  const withWorkspace = vi.fn(async (_owner: string, _workspace: string, _kind: string, operation: () => Promise<unknown>) => operation());
  const withProject = vi.fn(async (_owner: string, _project: string | undefined, _kind: string, operation: () => Promise<unknown>) => operation());
  const built = createTerminalAgentServices({
    runtime: runtime as never,
    homePath: home,
    terminalOwnerIds: ownerIds,
    projectAdmission: { withWorkspace, withProject } as never,
  });
  closers.push(() => built.close());
  return { built, writes, withWorkspace, withProject };
}

// Fault detected (review of #3298): the kernel writes into a fenced or shared
// project's terminals that the HTTP routes would refuse.
describe("terminal agent services: kernel tools", () => {
  it("runs kernel writes and launches through project admission as the terminal owner", async () => {
    const { built, writes, withWorkspace, withProject } = await services(["user_owner"]);
    await built.kernelTools.send({ workspaceId, tabId }, "npm test");
    expect(withWorkspace).toHaveBeenCalledWith("user_owner", workspaceId, "run", expect.any(Function));
    expect(writes).toEqual(["npm test\r"]);
    await built.kernelTools.run({ projectId: "app", name: "tests", cwd: "", argv: ["bun", "test"] });
    expect(withProject).toHaveBeenCalledWith("user_owner", "app", "run", expect.any(Function));
  });

  it("refuses kernel writes when the terminal owner is not exactly one user", async () => {
    const { built, writes } = await services(["a", "b"]);
    await expect(built.kernelTools.send({ workspaceId, tabId }, "x")).rejects.toMatchObject({ code: "not_found" });
    expect(writes).toEqual([]);
  });
});
