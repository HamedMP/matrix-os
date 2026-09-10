import { access, lstat, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  createTerminalWorkspaceRoutes,
  terminalRuntimeOwnerAccess,
  terminalRuntimeRefAccess,
} from "../../packages/gateway/src/shell/workspace-routes.js";
import {
  createTerminalPasteAssetCleanupLifecycle,
  saveTerminalPasteAsset,
} from "../../packages/gateway/src/shell/paste-assets.js";
import { TerminalRuntimeError } from "../../packages/terminal-runtime/src/errors.js";

const workspace = {
  id: "tws_0123456789abcdef0123456789abcdef",
  scope: "project" as const,
  projectId: "matrix-os",
  canonicalSize: { cols: 120, rows: 36 },
  status: "running" as const,
  revision: 1,
  createdAt: "2026-08-11T12:00:00.000Z",
  updatedAt: "2026-08-11T12:00:00.000Z",
  tabs: [],
};

describe("terminal workspace gateway routes", () => {
  const ownerOptions = {
    getPrincipal: () => ({ userId: "user_owner", source: "jwt" as const }),
    terminalOwnerIds: ["user_owner"],
  };

  it("authorizes only exact terminal refs in the authenticated owner's runtime", async () => {
    const tabId = "tt_0123456789abcdef0123456789abcdef";
    const runtime = {
      listWorkspaces: vi.fn(async () => [{
        ...workspace,
        tabs: [{ id: tabId, accessScope: "owner" }],
      }]),
    };
    const ref = { workspaceId: workspace.id, tabId };

    await expect(terminalRuntimeRefAccess(
      { userId: "user_owner", source: "jwt" },
      ["user_owner"],
      runtime,
      ref,
    )).resolves.toBe("allowed");
    await expect(terminalRuntimeRefAccess(
      { userId: "user_other", source: "jwt" },
      ["user_owner"],
      runtime,
      ref,
    )).resolves.toBe("not_found");
    await expect(terminalRuntimeRefAccess(
      { userId: "user_owner", source: "jwt" },
      ["user_owner"],
      runtime,
      { ...ref, tabId: "tt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    )).resolves.toBe("not_found");
    expect(runtime.listWorkspaces).toHaveBeenCalledTimes(2);
  });

  it("keeps Chat and legacy terminal refs fail-closed without repository context", async () => {
    const ownerTabId = "tt_0123456789abcdef0123456789abcdef";
    const chatTabId = "tt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const legacyTabId = "tt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const runtime = {
      listWorkspaces: vi.fn(async () => [{
        ...workspace,
        tabs: [
          { id: ownerTabId, accessScope: "owner" },
          { id: chatTabId, accessScope: "chat" },
          { id: legacyTabId, accessScope: "legacy" },
        ],
      }]),
    };
    const principal = { userId: "user_owner", source: "jwt" as const };

    await expect(terminalRuntimeRefAccess(principal, ["user_owner"], runtime, {
      workspaceId: workspace.id,
      tabId: ownerTabId,
    })).resolves.toBe("allowed");
    await expect(terminalRuntimeRefAccess(principal, ["user_owner"], runtime, {
      workspaceId: workspace.id,
      tabId: chatTabId,
    })).resolves.toBe("chat_required");
    await expect(terminalRuntimeRefAccess(principal, ["user_owner"], runtime, {
      workspaceId: workspace.id,
      tabId: legacyTabId,
    })).resolves.toBe("repository_required");
  });

  it("refuses ambiguous terminal runtime owner configuration", () => {
    expect(terminalRuntimeOwnerAccess(
      { userId: "user_owner", source: "jwt" },
      ["user_owner", "user_other"],
    )).toBe("unavailable");
  });

  it("expires stale terminal paste assets before retaining a new upload", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-workspace-paste-cleanup-"));
    const staleDirectory = join(homePath, "temporary", "terminal-pastes", "2026-09-08");
    const stalePath = join(staleDirectory, "stale.png");
    await mkdir(staleDirectory, { recursive: true });
    await writeFile(stalePath, Uint8Array.from([0x89, 0x50, 0x4e, 0x47]));
    await utimes(stalePath, new Date("2026-09-08T00:00:00Z"), new Date("2026-09-08T00:00:00Z"));

    try {
      await saveTerminalPasteAsset({
        homePath,
        cwd: "projects/matrix-os",
        bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        contentType: "image/png",
        now: new Date("2026-09-10T12:00:00Z"),
      });
      await expect(access(stalePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("runs recurring paste cleanup without overlap and clears its timer on close", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-workspace-paste-lifecycle-"));
    let scheduled: (() => void) | undefined;
    const schedule = vi.fn((callback: () => void) => {
      scheduled = callback;
      return "terminal-paste-cleanup-timer";
    });
    const cancel = vi.fn();
    const lifecycle = createTerminalPasteAssetCleanupLifecycle({
      homePath,
      intervalMs: 100,
      schedule,
      cancel,
      now: () => new Date("2026-09-10T12:00:00Z").getTime(),
    });

    try {
      const initialRun = lifecycle.runNow();
      expect(lifecycle.runNow()).toBe(initialRun);
      await initialRun;
      const directory = join(homePath, "temporary", "terminal-pastes", "2026-09-08");
      const stalePath = join(directory, "later.png");
      await mkdir(directory, { recursive: true });
      await writeFile(stalePath, Uint8Array.from([0x89, 0x50, 0x4e, 0x47]));
      await utimes(stalePath, new Date("2026-09-08T00:00:00Z"), new Date("2026-09-08T00:00:00Z"));

      scheduled?.();
      await lifecycle.waitForIdle();
      await expect(lstat(stalePath)).rejects.toMatchObject({ code: "ENOENT" });

      lifecycle.close();
      expect(cancel).toHaveBeenCalledWith("terminal-paste-cleanup-timer");
      expect(schedule).toHaveBeenCalledOnce();
    } finally {
      lifecycle.close();
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("starts recurring paste cleanup after gateway startup and cancels it before awaited shutdown", async () => {
    const [source, lifecycleSource] = await Promise.all([
      readFile(new URL("../../packages/gateway/src/server.ts", import.meta.url), "utf8"),
      readFile(new URL(
        "../../packages/gateway/src/shell/paste-asset-cleanup-runtime.ts",
        import.meta.url,
      ), "utf8"),
    ]);
    const serverStart = source.indexOf("const server = serve(");
    const cleanupStart = source.indexOf("startTerminalPasteAssetCleanup({");
    const cleanupClose = source.indexOf("await terminalPasteAssetCleanup.close();", cleanupStart);

    expect(serverStart).toBeGreaterThan(-1);
    expect(cleanupStart).toBeGreaterThan(serverStart);
    expect(cleanupClose).toBeGreaterThan(cleanupStart);
    expect(source).not.toContain("createTerminalPasteAssetCleanupLifecycle({");
    expect(lifecycleSource).toContain("createTerminalPasteAssetCleanupLifecycle({");
    expect(lifecycleSource).toContain("void lifecycle.runNow()");
    expect(lifecycleSource).toContain("lifecycle.close();");
    expect(lifecycleSource).toContain("await lifecycle.waitForIdle()");
  });

  it("pins each paste directory while enumerating and deleting its entries", async () => {
    const source = await readFile(new URL(
      "../../packages/gateway/src/shell/paste-assets.ts",
      import.meta.url,
    ), "utf8");

    expect(source).toContain("O_DIRECTORY | O_NOFOLLOW");
    expect(source).toContain("`/proc/self/fd/${handle.fd}`");
    expect(source).toContain("await pinnedDirectory.handle.close()");
  });

  it("validates workspace/tab mutations and requires deletion confirmation", async () => {
    const runtime = {
      listWorkspaces: vi.fn(async () => [workspace]),
      ensureWorkspace: vi.fn(async () => workspace),
      createTab: vi.fn(async () => ({
        id: "tt_0123456789abcdef0123456789abcdef",
        workspaceId: workspace.id,
        name: "main",
        cwd: "projects/matrix-os",
        status: "running" as const,
        revision: 1,
        order: 0,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      })),
      paneAction: vi.fn(async () => undefined),
      updateTabUiState: vi.fn(async (
        _ref: { workspaceId: string; tabId: string },
        input: { pinned?: boolean },
      ) => ({
        id: "tt_0123456789abcdef0123456789abcdef",
        workspaceId: workspace.id,
        name: "main",
        cwd: "projects/matrix-os",
        status: "running" as const,
        revision: 2,
        order: 0,
        uiState: { placement: "active" as const, lastSeenSeq: null, pinned: input.pinned },
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      })),
      deletionImpact: vi.fn(async () => ({ runningTabs: 1, tabs: [] })),
      deleteWorkspace: vi.fn(async () => undefined),
    };
    const app = new Hono().route("/api/terminal", createTerminalWorkspaceRoutes({ runtime, ...ownerOptions }));

    expect((await app.request("/api/terminal/workspaces")).status).toBe(200);
    expect((await app.request("/api/terminal/workspaces/ensure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "matrix-os" }),
    })).status).toBe(200);
    expect((await app.request(`/api/terminal/workspaces/${workspace.id}/tabs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "main",
        cwd: "projects/matrix-os",
        agent: { providerId: "codex", threadId: "thread_terminal_01" },
      }),
    })).status).toBe(201);
    expect(runtime.createTab).toHaveBeenCalledWith(workspace.id, {
      name: "main",
      cwd: "projects/matrix-os",
      agent: { providerId: "codex", threadId: "thread_terminal_01" },
      accessScope: "owner",
    });

    expect((await app.request(`/api/terminal/workspaces/${workspace.id}/tabs/tt_0123456789abcdef0123456789abcdef/pane-actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "split", direction: "right" }),
    })).status).toBe(200);
    expect(runtime.paneAction).toHaveBeenCalledWith(
      { workspaceId: workspace.id, tabId: "tt_0123456789abcdef0123456789abcdef" },
      { type: "split", direction: "right" },
    );

    expect((await app.request(`/api/terminal/workspaces/${workspace.id}/tabs/tt_0123456789abcdef0123456789abcdef/ui-state`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: true, baseRevision: 1 }),
    })).status).toBe(200);
    expect(runtime.updateTabUiState).toHaveBeenCalledWith(
      { workspaceId: workspace.id, tabId: "tt_0123456789abcdef0123456789abcdef" },
      { pinned: true, baseRevision: 1 },
    );

    expect((await app.request(`/api/terminal/workspaces/${workspace.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmTerminate: false }),
    })).status).toBe(409);
    expect(runtime.deleteWorkspace).not.toHaveBeenCalled();
    expect((await app.request(`/api/terminal/workspaces/${workspace.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmTerminate: true }),
    })).status).toBe(204);
  });

  it("accepts one maximum-size image after JSON base64 expansion", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-workspace-paste-"));
    const tab = {
      id: "tt_0123456789abcdef0123456789abcdef",
      workspaceId: workspace.id,
      name: "main",
      cwd: "projects/matrix-os",
      status: "running" as const,
      revision: 1,
      order: 0,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    };
    const runtime = {
      listWorkspaces: vi.fn(async () => [{ ...workspace, tabs: [tab] }]),
      ensureWorkspace: vi.fn(async () => workspace),
      createTab: vi.fn(async () => tab),
      deletionImpact: vi.fn(async () => ({ runningTabs: 0, tabs: [] })),
      deleteWorkspace: vi.fn(async () => undefined),
    };
    const app = new Hono().route("/api/terminal", createTerminalWorkspaceRoutes({
      runtime,
      homePath,
      ...ownerOptions,
    }));
    const bytes = Buffer.alloc(10 * 1024 * 1024);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    try {
      const response = await app.request(
        `/api/terminal/workspaces/${workspace.id}/tabs/${tab.id}/paste-assets`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            assets: [{ name: "capture.png", mimeType: "image/png", dataBase64: bytes.toString("base64") }],
          }),
        },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        assets: [{ size: bytes.byteLength, mimeType: "image/png" }],
      });
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("binds a Chat terminal by stable workspace/tab ref and cleans up failed bindings", async () => {
    const tab = {
      id: "tt_0123456789abcdef0123456789abcdef",
      workspaceId: workspace.id,
      name: "Chat terminal",
      cwd: "projects/matrix-os",
      status: "running" as const,
      revision: 1,
      order: 0,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    };
    const runtime = {
      listWorkspaces: vi.fn(async () => [{ ...workspace, tabs: [tab] }]),
      ensureWorkspace: vi.fn(async () => workspace),
      createTab: vi.fn(async () => tab),
      terminateTab: vi.fn(async () => undefined),
      paneAction: vi.fn(async () => undefined),
      deletionImpact: vi.fn(async () => ({ runningTabs: 0, tabs: [] })),
      deleteWorkspace: vi.fn(async () => undefined),
    };
    const prepare = vi.fn(async () => ({ runId: "run_selected", cwd: "projects/matrix-os" }));
    const bind = vi.fn(async () => undefined);
    const authorizePaneAction = vi.fn(async () => true);
    const listBoundSessionIds = vi.fn(async () => [`${workspace.id}:${tab.id}`]);
    const app = new Hono().route("/api/terminal", createTerminalWorkspaceRoutes({
      runtime,
      getPrincipal: () => ({ userId: "user_selected", source: "jwt" }),
      terminalOwnerIds: ["user_selected"],
      chatTerminals: { prepare, bind, authorizePaneAction, listBoundSessionIds },
    }));

    const response = await app.request(`/api/terminal/workspaces/${workspace.id}/tabs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Chat terminal", cwd: "", chatId: "chat_selected" }),
    });

    expect(response.status).toBe(201);
    expect(runtime.createTab).toHaveBeenCalledWith(workspace.id, {
      name: "Chat terminal",
      cwd: "projects/matrix-os",
      accessScope: "chat",
    });
    expect(bind).toHaveBeenCalledWith(
      { userId: "user_selected", source: "jwt" },
      {
        chatId: "chat_selected",
        runId: "run_selected",
        sessionId: `${workspace.id}:${tab.id}`,
        sessionCreatedAt: tab.createdAt,
      },
    );
    expect(runtime.terminateTab).not.toHaveBeenCalled();

    expect((await app.request(`/api/terminal/workspaces/${workspace.id}/tabs/${tab.id}/pane-actions?chatId=chat_selected`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "fullscreen" }),
    })).status).toBe(200);
    expect(authorizePaneAction).toHaveBeenCalledWith(
      { userId: "user_selected", source: "jwt" },
      {
        chatId: "chat_selected",
        sessionId: `${workspace.id}:${tab.id}`,
        sessionCreatedAt: tab.createdAt,
      },
    );
    expect(runtime.paneAction).toHaveBeenCalledWith(
      { workspaceId: workspace.id, tabId: tab.id },
      { type: "fullscreen" },
    );

    authorizePaneAction.mockResolvedValueOnce(false);
    expect((await app.request(`/api/terminal/workspaces/${workspace.id}/tabs/${tab.id}/pane-actions?chatId=chat_selected`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "close" }),
    })).status).toBe(404);
    expect(runtime.paneAction).toHaveBeenCalledTimes(1);

    expect((await app.request(`/api/terminal/workspaces/${workspace.id}/tabs/${tab.id}/pane-actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "close" }),
    })).status).toBe(404);
    expect(listBoundSessionIds).toHaveBeenCalledWith(
      { userId: "user_selected", source: "jwt" },
      [`${workspace.id}:${tab.id}`],
    );
    expect(runtime.paneAction).toHaveBeenCalledTimes(1);

    bind.mockRejectedValueOnce(new Error("database unavailable"));
    expect((await app.request(`/api/terminal/workspaces/${workspace.id}/tabs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Chat terminal", cwd: "", chatId: "chat_selected" }),
    })).status).toBe(500);
    expect(runtime.terminateTab).toHaveBeenCalledWith({ workspaceId: workspace.id, tabId: tab.id });
  });

  it("rejects Chat terminal wiring that cannot clean up a failed binding", () => {
    const runtime = {
      listWorkspaces: vi.fn(async () => [workspace]),
      ensureWorkspace: vi.fn(async () => workspace),
      createTab: vi.fn(),
      deletionImpact: vi.fn(async () => ({ runningTabs: 0, tabs: [] })),
      deleteWorkspace: vi.fn(async () => undefined),
    };

    expect(() => createTerminalWorkspaceRoutes({
      runtime,
      ...ownerOptions,
      chatTerminals: {
        prepare: vi.fn(async () => ({})),
        bind: vi.fn(async () => undefined),
      },
    })).toThrow("Chat terminal cleanup is unavailable");
  });

  it("keeps deletion confirmation authoritative inside the serialized runtime mutation", async () => {
    const deleteWorkspace = vi.fn(async (
      _workspaceId: string,
      input: { confirmTerminate: boolean },
    ) => {
      if (!input.confirmTerminate) throw new TerminalRuntimeError("confirmation_required");
    });
    const runtime = {
      listWorkspaces: vi.fn(async () => [workspace]),
      ensureWorkspace: vi.fn(async () => workspace),
      createTab: vi.fn(),
      deletionImpact: vi.fn(async () => ({ runningTabs: 0, tabs: [] })),
      deleteWorkspace,
    };
    const app = new Hono().route("/api/terminal", createTerminalWorkspaceRoutes({ runtime, ...ownerOptions }));

    const response = await app.request(`/api/terminal/workspaces/${workspace.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmTerminate: false }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "terminal_termination_confirmation_required",
    });
    expect(deleteWorkspace).toHaveBeenCalledWith(workspace.id, { confirmTerminate: false });
  });

  it("maps typed runtime not-found and revision-conflict errors to bounded HTTP responses", async () => {
    const runtime = {
      listWorkspaces: vi.fn(async () => { throw new TerminalRuntimeError("not_found"); }),
      ensureWorkspace: vi.fn(async () => workspace),
      createTab: vi.fn(),
      reorderTabs: vi.fn(async () => { throw new TerminalRuntimeError("conflict"); }),
      deletionImpact: vi.fn(async () => ({ runningTabs: 0, tabs: [] })),
      deleteWorkspace: vi.fn(async () => undefined),
    };
    const app = new Hono().route("/api/terminal", createTerminalWorkspaceRoutes({ runtime, ...ownerOptions }));

    const missing = await app.request("/api/terminal/workspaces");
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: "Terminal operation failed" });

    const conflict = await app.request(`/api/terminal/workspaces/${workspace.id}/tabs/order`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tabIds: [], baseRevision: 1 }),
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({ error: "terminal_revision_conflict" });
  });

  it("rejects a principal that does not own the local terminal runtime", async () => {
    const runtime = {
      listWorkspaces: vi.fn(async () => [workspace]),
      ensureWorkspace: vi.fn(async () => workspace),
      createTab: vi.fn(),
      deletionImpact: vi.fn(),
      deleteWorkspace: vi.fn(),
    };
    const app = new Hono().route("/api/terminal", createTerminalWorkspaceRoutes({
      runtime,
      getPrincipal: () => ({ userId: "user_other", source: "jwt" }),
      terminalOwnerIds: ["user_owner"],
    }));

    expect((await app.request("/api/terminal/workspaces")).status).toBe(404);
    expect(runtime.listWorkspaces).not.toHaveBeenCalled();
  });
});
