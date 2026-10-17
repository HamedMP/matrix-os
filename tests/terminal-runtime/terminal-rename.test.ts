import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalRuntime, type ZellijRuntimeAdapter } from "../../packages/terminal-runtime/src/runtime.js";
import { TerminalWorkspaceStore } from "../../packages/terminal-runtime/src/workspace-store.js";
import { TerminalRuntimeSocketClient } from "../../packages/terminal-runtime/src/socket-client.js";
import { TerminalRuntimeSocketServer } from "../../packages/terminal-runtime/src/socket-server.js";
import { createTerminalWorkspaceRoutes } from "../../packages/gateway/src/shell/workspace-routes.js";
import { ProjectFenceError } from "../../packages/gateway/src/collaboration/project-fence.js";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))); });

async function fixture(projectId?: string) {
  const homePath = await mkdtemp(join(tmpdir(), "terminal-rename-"));
  homes.push(homePath);
  const store = new TerminalWorkspaceStore({ homePath });
  let physicalName = "";
  let input = "";
  // Faithfully model rename-tab: it replaces the name used by runtime discovery.
  const adapter: ZellijRuntimeAdapter = {
    ensureSession: async () => undefined,
    createTab: async (_session, tab) => { physicalName = tab.internalName; return { tabId: 1, paneId: "terminal_1" }; },
    findTabByInternalName: async (_session, name) => name === physicalName ? { tabId: 1, paneId: "terminal_1" } : undefined,
    renameTab: async (_session, _id, name) => { physicalName = name; },
    writeToPane: async (_session, _pane, data) => { input += new TextDecoder().decode(data); },
    openAttachment: async () => { throw new Error("No viewer required"); },
    subscribeWorkspace: async () => ({ close: async () => undefined }),
  };
  const runtime = new TerminalRuntime({ store, zellij: adapter });
  const workspace = await runtime.ensureWorkspace({ projectId });
  const tab = await runtime.createTab(workspace.id, { name: "spry-pine", cwd: "projects" });
  const ref = { workspaceId: workspace.id, tabId: tab.id };
  const originalPhysicalName = physicalName;
  return { homePath, store, runtime, tab, ref, originalPhysicalName, physicalName: () => physicalName, input: () => input };
}

describe("terminal display-name rename", () => {
  it("preserves immutable runtime identity, process input and restart recovery", async () => {
    const f = await fixture();
    try {
      await f.runtime.renameTab(f.ref, { name: "handoff-skill", baseRevision: f.tab.revision });
      await f.runtime.restoreAll();
      expect((await f.store.getTab(f.ref))?.status).toBe("running");
      expect(f.physicalName()).toBe(f.originalPhysicalName);
      await f.runtime.writeInput(f.ref, "echo still alive\r");
      expect(f.input()).toBe("echo still alive\r");
      expect((await new TerminalWorkspaceStore({ homePath: f.homePath }).getTab(f.ref))?.name).toBe("handoff-skill");
    } finally { await f.runtime.shutdown(); }
  });

  it("allows unrelated output revisions while protecting the expected display name", async () => {
    const f = await fixture();
    try {
      await f.store.checkpointTab(f.ref, { ansi: "new output", viewport: ["new output"], scrollback: [] });
      const renamed = await f.runtime.renameTab(f.ref, {
        name: "handoff-skill", baseRevision: f.tab.revision, expectedName: f.tab.name,
      });
      expect(renamed.name).toBe("handoff-skill");
      await expect(f.runtime.renameTab(f.ref, {
        name: "stale edit", baseRevision: f.tab.revision, expectedName: f.tab.name,
      })).rejects.toMatchObject({ code: "conflict" });
      expect((await f.store.getTab(f.ref))?.name).toBe("handoff-skill");
      expect(f.physicalName()).toBe(f.originalPhysicalName);
    } finally { await f.runtime.shutdown(); }
  });

  it("keeps legacy full-revision guards and rejects future revisions before changing metadata", async () => {
    const f = await fixture();
    try {
      await f.store.checkpointTab(f.ref, { ansi: "output", viewport: ["output"], scrollback: [] });
      await expect(f.runtime.renameTab(f.ref, { name: "legacy stale", baseRevision: f.tab.revision }))
        .rejects.toMatchObject({ code: "conflict" });
      await expect(f.runtime.renameTab(f.ref, { name: "future", baseRevision: 999, expectedName: f.tab.name }))
        .rejects.toMatchObject({ code: "conflict" });
      expect((await f.store.getTab(f.ref))?.name).toBe(f.tab.name);
      expect(f.physicalName()).toBe(f.originalPhysicalName);
    } finally { await f.runtime.shutdown(); }
  });

  it("renames retained metadata after the process exits without requiring a live Zellij tab", async () => {
    const f = await fixture();
    try {
      const exited = await f.store.markTabExited(f.ref, 0);
      const noRuntime = new TerminalRuntime({ store: f.store, zellij: {
        ensureSession: async () => undefined, createTab: async () => { throw new Error("not running"); },
        openAttachment: async () => { throw new Error("not running"); },
        subscribeWorkspace: async () => ({ close: async () => undefined }),
      } });
      try {
        const renamed = await noRuntime.renameTab(f.ref, { name: "handoff-skill", baseRevision: exited.revision });
        expect(renamed).toMatchObject({ name: "handoff-skill", status: "exited", activityAt: f.tab.activityAt });
      } finally { await noRuntime.shutdown(); }
    } finally { await f.runtime.shutdown(); }
  });

  it.each([undefined, "matrix-os"])("round-trips the name precondition through HTTP and the owner-local socket (project %s)", async (projectId) => {
    const f = await fixture(projectId);
    const socketPath = join(f.homePath, "r.sock");
    const server = new TerminalRuntimeSocketServer({ socketPath, runtime: f.runtime });
    try {
      await server.start();
      const client = new TerminalRuntimeSocketClient({ socketPath });
      let actor = "owner";
      let shared = false;
      const admissions: unknown[] = [];
      const app = new Hono().route("/api/terminal", createTerminalWorkspaceRoutes({
        runtime: client, homePath: f.homePath,
        getPrincipal: () => ({ userId: actor, source: "jwt" }), terminalOwnerIds: ["owner"],
        projectOperationAdmission: {
          withLegacyAdmission: async (input, operation) => {
            admissions.push(input);
            if (shared) throw new ProjectFenceError("scope_required");
            return operation();
          },
        },
      }));
      await f.store.checkpointTab(f.ref, { ansi: "new output", viewport: ["new output"], scrollback: [] });
      const path = `/api/terminal/workspaces/${f.ref.workspaceId}/tabs/${f.ref.tabId}`;
      const patch = (body: unknown) => app.request(path, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const response = await patch({ name: "handoff-skill", baseRevision: f.tab.revision, expectedName: f.tab.name });
      expect(response.status).toBe(200);
      expect((await response.json()).tab.name).toBe("handoff-skill");
      expect((await patch({ name: "stale", baseRevision: f.tab.revision, expectedName: f.tab.name })).status).toBe(409);
      if (projectId) {
        expect(admissions).toEqual(Array(2).fill({ ownerType: "personal", ownerId: "owner", projectId, kind: "write" }));
        const beforeFence = await f.store.getTab(f.ref);
        shared = true;
        expect((await patch({ name: "blocked", baseRevision: beforeFence!.revision, expectedName: "handoff-skill" })).status).toBe(409);
        expect(await f.store.getTab(f.ref)).toEqual(beforeFence);
      } else {
        expect(admissions).toEqual([]);
      }
      actor = "other";
      expect((await patch({ name: "unauthorized", baseRevision: 999, expectedName: "handoff-skill" })).status).toBe(404);
      expect((await f.store.getTab(f.ref))?.name).toBe("handoff-skill");
    } finally { await server.close(); await f.runtime.shutdown(); }
  });
});
