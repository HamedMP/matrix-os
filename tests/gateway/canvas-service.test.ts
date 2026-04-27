import { describe, expect, it, vi } from "vitest";
import { CanvasService } from "../../packages/gateway/src/canvas/service.js";

const now = "2026-04-27T00:00:00.000Z";

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

  it("delegates terminal actions to the durable session registry", async () => {
    const terminalRegistry = {
      create: vi.fn().mockReturnValue("550e8400-e29b-41d4-a716-446655440000"),
      getSession: vi.fn().mockReturnValue({ sessionId: "550e8400-e29b-41d4-a716-446655440000", state: "running" }),
      destroy: vi.fn(),
    };
    const service = new CanvasService(repository([record()]), { terminalRegistry });

    await expect(service.executeAction("user_a", "cnv_0123456789abcdef", {
      nodeId: "node_terminal",
      type: "terminal.create",
      payload: { cwd: "projects/app" },
    })).resolves.toMatchObject({ result: { kind: "terminal_session" } });
    expect(terminalRegistry.create).toHaveBeenCalledWith("projects/app", undefined);
  });

  it("uses a 10 second timeout for preview health checks", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const service = new CanvasService(repository([record()]), { fetchImpl: fetchImpl as any });

    await service.executeAction("user_a", "cnv_0123456789abcdef", {
      nodeId: "node_preview",
      type: "preview.healthCheck",
      payload: { url: "https://example.com" },
    });

    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});
