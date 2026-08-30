import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CanvasNotFoundError } from "../../packages/gateway/src/canvas/repository.js";
import { CanvasConfigurationError, CanvasService, mapCanvasError } from "../../packages/gateway/src/canvas/service.js";

const now = "2026-04-27T00:00:00.000Z";
const workspaceId = "tws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const tabId = "tt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function terminalRuntime(workspaces: any[] = []) {
  const workspace = { id: workspaceId, scope: "project", projectId: "prj_1", tabs: [] };
  const tab = { id: tabId, workspaceId, name: "terminal", cwd: "projects/app", status: "running" };
  return {
    listWorkspaces: vi.fn().mockResolvedValue(workspaces),
    ensureWorkspace: vi.fn().mockResolvedValue(workspace),
    createTab: vi.fn().mockResolvedValue(tab),
    writeInput: vi.fn().mockResolvedValue(undefined),
    terminateTab: vi.fn().mockResolvedValue(undefined),
  };
}

function record(overrides: Partial<any> = {}) {
  return {
    id: "cnv_0123456789abcdef",
    ownerScope: "personal",
    ownerId: "user_a",
    title: "PR 57",
    scopeType: "pull_request",
    scopeRef: { projectId: "prj_1", owner: "acme", repo: "app", number: 57 },
    revision: 1,
    schemaVersion: 1,
    nodes: [],
    edges: [],
    viewStates: [],
    displayOptions: {},
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function repository(records: any[] = []) {
  return {
    list: vi.fn().mockResolvedValue(records),
    get: vi.fn().mockImplementation((_owner, canvasId) => Promise.resolve(records.find((item) => item.id === canvasId) ?? null)),
    create: vi.fn().mockImplementation((_owner, input) => Promise.resolve(record({
      id: "cnv_created123456",
      title: input.title,
      scopeType: input.scopeType,
      scopeRef: input.scopeRef,
      nodes: input.document.nodes,
      edges: input.document.edges,
    }))),
    replaceDocument: vi.fn().mockResolvedValue({ revision: 2, updatedAt: now }),
    patchNode: vi.fn().mockResolvedValue({ revision: 2, updatedAt: now }),
    softDelete: vi.fn().mockResolvedValue(undefined),
    export: vi.fn().mockResolvedValue(record()),
  } as any;
}

describe("CanvasService", () => {
  it("creates PR workspace canvases with PR, review, terminal nodes and no duplicated source records", async () => {
    const repo = repository();
    const service = new CanvasService(repo);

    const created = await service.createCanvas("user_a", {
      title: "PR 57 Review",
      scopeType: "pull_request",
      scopeRef: { projectId: "prj_1", owner: "acme", repo: "app", number: 57 },
      template: "pr_workspace",
    });

    expect(created.canvasId).toBe("cnv_created123456");
    const input = repo.create.mock.calls[0][1];
    expect(input.document.nodes.map((node: any) => node.type)).toEqual(["pr", "review_loop", "terminal"]);
    expect(input.document.nodes[0].sourceRef.external).toMatchObject({ owner: "acme", repo: "app", number: 57 });
  });

  it("summarizes node counts and supports scoped search filters", async () => {
    const service = new CanvasService(repository([
      record({ title: "Alpha", nodes: [{ type: "terminal", displayState: "normal" }, { type: "task", displayState: "stale" }] }),
      record({ id: "cnv_other1234567", title: "Beta", scopeType: "project", scopeRef: { projectId: "prj_2" } }),
    ]));

    const result = await service.listCanvases("user_a", { scopeType: "pull_request", q: "alpha" });
    expect(result.canvases).toHaveLength(1);
    expect(result.canvases[0].nodeCounts).toEqual({ total: 2, stale: 1, live: 1 });
  });

  it("delegates terminal actions to the project workspace runtime", async () => {
    const runtime = terminalRuntime();
    const service = new CanvasService(repository([record()]), {
      terminalRuntime: runtime,
      terminalOwnerIds: ["user_a"],
    });

    await expect(service.executeAction("user_a", "cnv_0123456789abcdef", {
      nodeId: "node_terminal",
      type: "terminal.create",
      payload: { cwd: "projects/app" },
    })).resolves.toEqual({ ok: true, result: { kind: "terminal_tab", terminalRef: { workspaceId, tabId } } });
    expect(runtime.ensureWorkspace).toHaveBeenCalledWith({ projectId: "prj_1" });
    expect(runtime.createTab).toHaveBeenCalledWith(workspaceId, { name: "terminal", cwd: "projects/app" });
  });

  it("rejects terminal creation for a project outside the canvas scope", async () => {
    const runtime = terminalRuntime();
    const service = new CanvasService(repository([record()]), {
      terminalRuntime: runtime,
      terminalOwnerIds: ["user_a"],
    });

    await expect(service.executeAction("user_a", "cnv_0123456789abcdef", {
      nodeId: "node_terminal",
      type: "terminal.create",
      payload: { cwd: "projects/app", projectId: "prj_other" },
    })).rejects.toBeInstanceOf(CanvasNotFoundError);
    expect(runtime.ensureWorkspace).not.toHaveBeenCalled();
  });

  it("rejects terminal control when the requested ref is not bound to the canvas node", async () => {
    const boundRef = { workspaceId, tabId };
    const otherRef = {
      workspaceId: "tws_cccccccccccccccccccccccccccccccc",
      tabId: "tt_dddddddddddddddddddddddddddddddd",
    };
    const otherTab = {
      id: otherRef.tabId,
      workspaceId: otherRef.workspaceId,
      name: "other",
      cwd: "projects/other",
      status: "running",
    };
    const runtime = terminalRuntime([{
      id: otherRef.workspaceId,
      scope: "project",
      projectId: "prj_other",
      tabs: [otherTab],
    }]);
    const service = new CanvasService(repository([record({
      nodes: [{
        id: "node_terminal",
        type: "terminal",
        sourceRef: { kind: "terminal_tab", terminalRef: boundRef },
      }],
    })]), { terminalRuntime: runtime, terminalOwnerIds: ["user_a"] });

    await expect(service.executeAction("user_a", "cnv_0123456789abcdef", {
      nodeId: "node_terminal",
      type: "terminal.write",
      payload: { terminalRef: otherRef, input: "whoami\n" },
    })).rejects.toBeInstanceOf(CanvasNotFoundError);
    expect(runtime.writeInput).not.toHaveBeenCalled();
  });

  it("rejects a node-bound terminal ref from another project", async () => {
    const otherRef = {
      workspaceId: "tws_cccccccccccccccccccccccccccccccc",
      tabId: "tt_dddddddddddddddddddddddddddddddd",
    };
    const runtime = terminalRuntime([{
      id: otherRef.workspaceId,
      scope: "project",
      projectId: "prj_other",
      tabs: [{
        id: otherRef.tabId,
        workspaceId: otherRef.workspaceId,
        name: "other",
        cwd: "projects/other",
        status: "running",
      }],
    }]);
    const service = new CanvasService(repository([record({
      nodes: [{
        id: "node_terminal",
        type: "terminal",
        sourceRef: { kind: "terminal_tab", terminalRef: otherRef },
      }],
    })]), { terminalRuntime: runtime, terminalOwnerIds: ["user_a"] });

    await expect(service.executeAction("user_a", "cnv_0123456789abcdef", {
      nodeId: "node_terminal",
      type: "terminal.write",
      payload: { terminalRef: otherRef, input: "whoami\n" },
    })).rejects.toBeInstanceOf(CanvasNotFoundError);
    expect(runtime.writeInput).not.toHaveBeenCalled();
  });

  it("rejects terminal actions from a principal that does not own the local runtime", async () => {
    const runtime = terminalRuntime();
    const service = new CanvasService(repository([record()]), {
      terminalRuntime: runtime,
      terminalOwnerIds: ["user_a"],
    });

    await expect(service.executeAction("user_other", "cnv_0123456789abcdef", {
      nodeId: "node_terminal",
      type: "terminal.create",
      payload: { cwd: "projects/app" },
    })).rejects.toBeInstanceOf(CanvasNotFoundError);
    expect(runtime.ensureWorkspace).not.toHaveBeenCalled();
  });

  it("caps reconciled terminal refs at the canvas node limit", async () => {
    const source = await readFile(
      join(process.cwd(), "packages/gateway/src/canvas/service.ts"),
      "utf8",
    );

    expect(source).toContain("CANVAS_MAX_NODES");
    expect(source).toContain("terminalRefs.size >= CANVAS_MAX_NODES");
  });

  it("validates terminal cwd at the canvas action boundary", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "canvas-home-"));
    const runtime = terminalRuntime();
    const service = new CanvasService(repository([record()]), { terminalRuntime: runtime, homePath });

    await expect(service.executeAction("user_a", "cnv_0123456789abcdef", {
      nodeId: "node_terminal",
      type: "terminal.create",
      payload: { cwd: "../outside" },
    })).rejects.toBeInstanceOf(CanvasNotFoundError);
    expect(runtime.createTab).not.toHaveBeenCalled();
  });

  it("requires homePath before resolving file.open actions", async () => {
    const service = new CanvasService(repository([record()]));

    await expect(service.executeAction("user_a", "cnv_0123456789abcdef", {
      nodeId: "node_file",
      type: "file.open",
      payload: { path: "projects/app/README.md" },
    })).rejects.toBeInstanceOf(CanvasConfigurationError);
  });

  it("requires homePath before accepting file source refs in node patches", async () => {
    const repo = repository([record()]);
    const service = new CanvasService(repo);

    await expect(service.patchCanvasNode("user_a", "cnv_0123456789abcdef", {
      baseRevision: 1,
      nodeId: "node_file",
      updates: { sourceRef: { kind: "file", id: "projects/app/README.md" } },
    })).rejects.toBeInstanceOf(CanvasConfigurationError);
    expect(repo.patchNode).not.toHaveBeenCalled();
  });

  it("marks stale terminal refs recoverable on the main canvas read path", async () => {
    const service = new CanvasService(repository([record({
      nodes: [{
        id: "node_terminal",
        type: "terminal",
        sourceRef: { kind: "terminal_tab", terminalRef: { workspaceId, tabId } },
        displayState: "normal",
        metadata: {},
      }],
    })]), {
      terminalRuntime: terminalRuntime([]),
    });

    const result = await service.getCanvas("user_a", "cnv_0123456789abcdef");

    expect(result.document.nodes[0]).toMatchObject({
      displayState: "recoverable",
      metadata: { recoveryReason: "missing_reference" },
    });
  });

  it("does not disclose terminal metadata outside the canvas project scope", async () => {
    const otherRef = {
      workspaceId: "tws_cccccccccccccccccccccccccccccccc",
      tabId: "tt_dddddddddddddddddddddddddddddddd",
    };
    const service = new CanvasService(repository([record({
      nodes: [{
        id: "node_terminal",
        type: "terminal",
        sourceRef: { kind: "terminal_tab", terminalRef: otherRef },
        displayState: "normal",
        metadata: {},
      }],
    })]), {
      terminalRuntime: terminalRuntime([{
        id: otherRef.workspaceId,
        scope: "project",
        projectId: "prj_other",
        tabs: [{
          id: otherRef.tabId,
          workspaceId: otherRef.workspaceId,
          name: "secret terminal",
          cwd: "projects/other",
          status: "running",
        }],
      }]),
    });

    const result = await service.getCanvas("user_a", "cnv_0123456789abcdef");

    expect(result.linkedState.terminalTabs).toEqual([]);
    expect(result.linkedState.missingRefs).toEqual([{
      kind: "terminal_tab",
      terminalRef: otherRef,
    }]);
    expect(result.document.nodes[0]).toMatchObject({
      displayState: "recoverable",
      metadata: { recoveryReason: "missing_reference" },
    });
  });

  it("maps canvas configuration failures to service unavailable", () => {
    expect(mapCanvasError(new CanvasConfigurationError())).toEqual({
      error: "Canvas service unavailable",
      status: 503,
    });
  });

  it("uses a bounded HEAD-only fetch for preview health checks without echoing response status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const resolvePreviewHost = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const service = new CanvasService(repository([record()]), { fetchImpl: fetchImpl as any, resolvePreviewHost });

    const result = await service.executeAction("user_a", "cnv_0123456789abcdef", {
      nodeId: "node_preview",
      type: "preview.healthCheck",
      payload: { url: "https://example.com" },
    });

    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      method: "HEAD",
      redirect: "error",
    });
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(result.result).toEqual({ kind: "preview_health", ok: true });
  });

  it("blocks preview health checks to private or link-local resolved addresses", async () => {
    const fetchImpl = vi.fn();
    const resolvePreviewHost = vi.fn().mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    const service = new CanvasService(repository([record()]), { fetchImpl: fetchImpl as any, resolvePreviewHost });

    await expect(service.executeAction("user_a", "cnv_0123456789abcdef", {
      nodeId: "node_preview",
      type: "preview.healthCheck",
      payload: { url: "https://metadata.internal/latest" },
    })).rejects.toBeInstanceOf(CanvasNotFoundError);

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
