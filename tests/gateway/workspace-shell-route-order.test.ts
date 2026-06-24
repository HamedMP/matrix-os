import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerShellAndWorkspaceRoutes,
} from "../../packages/gateway/src/server.js";
import type { ShellRouteDeps } from "../../packages/gateway/src/shell/routes.js";
import type { createWorkspaceRoutes } from "../../packages/gateway/src/workspace-routes.js";

const roots: string[] = [];

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "matrix-workspace-shell-route-order-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe("gateway workspace and shell route order", () => {
  it("routes workspace sessions before legacy shell sessions without breaking shell namespaces", async () => {
    const homePath = await tempRoot();
    const app = new Hono();
    const shellSession = { name: "main" };
    const workspaceSession = { id: "sess_workspace", projectSlug: "repo" };
    const shellRoutes: ShellRouteDeps = {
      registry: {
        list: vi.fn(async () => [shellSession]),
        create: vi.fn(async () => shellSession),
        delete: vi.fn(async () => undefined),
      },
      workspace: {
        listTabs: vi.fn(async () => [{ idx: 0, name: "main", focused: true }]),
        createTab: vi.fn(async () => ({ idx: 1, name: "api" })),
        switchTab: vi.fn(async () => ({ ok: true })),
        closeTab: vi.fn(async () => ({ ok: true })),
        splitPane: vi.fn(async () => ({ pane: "pane-1" })),
        closePane: vi.fn(async () => ({ ok: true })),
        applyLayout: vi.fn(async () => ({ ok: true })),
        dumpLayout: vi.fn(async () => ({ kdl: "layout {}" })),
      },
    };
    const sessionOrchestrator = {
      startSession: vi.fn(async () => ({ ok: true, status: 201, session: workspaceSession })),
      listSessions: vi.fn(async () => ({ ok: true, sessions: [workspaceSession], nextCursor: null })),
      getSession: vi.fn(async () => ({ ok: true, session: workspaceSession })),
      sendInput: vi.fn(async () => ({ ok: true, session: workspaceSession })),
      attachSession: vi.fn(async () => ({ ok: true, terminalSessionId: "term_workspace" })),
      stopSession: vi.fn(async () => ({ ok: true, session: workspaceSession })),
    };
    const workspaceRoutes: Parameters<typeof createWorkspaceRoutes>[0] = {
      homePath,
      sessionOrchestrator: sessionOrchestrator as never,
      getOwnerScope: () => ({ type: "user", id: "user_workspace" }),
    };

    registerShellAndWorkspaceRoutes(app, { shellRoutes, workspaceRoutes });

    await expect((await app.request("/api/sessions?projectSlug=repo&limit=10")).json()).resolves.toEqual({
      sessions: [workspaceSession],
      nextCursor: null,
    });
    await expect((await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "shell",
        projectSlug: "repo",
        worktreeId: "wt_abc123",
      }),
    })).json()).resolves.toEqual({
      session: workspaceSession,
    });
    await expect((await app.request("/api/terminal/sessions")).json()).resolves.toEqual({
      sessions: [shellSession],
    });
    await expect((await app.request("/api/sessions/main/tabs")).json()).resolves.toEqual({
      tabs: [{ idx: 0, name: "main", focused: true }],
    });

    expect(sessionOrchestrator.listSessions).toHaveBeenCalledWith({
      projectSlug: "repo",
      taskId: undefined,
      status: undefined,
      pr: undefined,
      limit: 10,
      cursor: undefined,
    });
    expect(sessionOrchestrator.startSession).toHaveBeenCalledWith({
      ownerScope: { type: "user", id: "user_workspace" },
      request: {
        kind: "shell",
        projectSlug: "repo",
        worktreeId: "wt_abc123",
      },
    });
    expect(shellRoutes.registry.list).toHaveBeenCalledTimes(1);
    expect(shellRoutes.registry.create).not.toHaveBeenCalled();
    expect(shellRoutes.workspace?.listTabs).toHaveBeenCalledWith("main");
  });
});
