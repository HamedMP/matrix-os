import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { CanvasConflictError, CanvasNotFoundError, CanvasRepository } from "../../packages/gateway/src/canvas/repository.js";

const owner = { ownerScope: "personal" as const, ownerId: "user_a" };
const otherOwner = { ownerScope: "personal" as const, ownerId: "user_b" };
const now = "2026-04-27T00:00:00.000Z";

function node(id: string) {
  return {
    id,
    type: "note",
    position: { x: 10, y: 20 },
    size: { width: 320, height: 180 },
    zIndex: 0,
    displayState: "normal",
    sourceRef: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}

function document(nodes: unknown[] = [], edges: unknown[] = []) {
  return {
    schemaVersion: 1,
    nodes,
    edges,
    viewStates: [],
    displayOptions: {},
  };
}

describe("CanvasRepository", () => {
  let pglite: InstanceType<typeof KyselyPGlite>;
  let repository: CanvasRepository;

  beforeEach(async () => {
    pglite = await KyselyPGlite.create();
    repository = new CanvasRepository(pglite.dialect);
    await repository.bootstrap();
  });

  afterEach(async () => {
    await repository.destroy();
  });

  it("bootstraps the Postgres tables and indexes idempotently", async () => {
    await repository.bootstrap();
    const result = await repository.kysely
      .selectFrom("canvas_documents")
      .select(({ fn }) => fn.countAll().as("count"))
      .executeTakeFirstOrThrow();
    expect(Number(result.count)).toBe(0);
  });

  it("isolates canvases by owner scope", async () => {
    const created = await repository.create(owner, {
      title: "Owner A",
      scopeType: "project",
      scopeRef: { projectId: "prj_1" },
      document: document(),
    });

    await repository.create(otherOwner, {
      title: "Owner B",
      scopeType: "project",
      scopeRef: { projectId: "prj_1" },
      document: document(),
    });

    expect(await repository.get(owner, created.id)).toMatchObject({ id: created.id, ownerId: owner.ownerId });
    expect(await repository.get(otherOwner, created.id)).toBeNull();
    await expect(repository.list(owner)).resolves.toHaveLength(1);
  });

  it("returns the existing active scoped canvas on duplicate create", async () => {
    const first = await repository.create(owner, {
      title: "PR workspace",
      scopeType: "pull_request",
      scopeRef: { projectId: "prj_1", number: 57 },
      document: document([node("node_a")]),
    });

    const second = await repository.create(owner, {
      title: "Duplicate PR workspace",
      scopeType: "pull_request",
      scopeRef: { projectId: "prj_1", number: 57 },
      document: document([node("node_b")]),
    });

    expect(second.id).toBe(first.id);
    expect(second.title).toBe("PR workspace");
    expect(second.nodes).toEqual([expect.objectContaining({ id: "node_a" })]);
    await expect(repository.list(owner)).resolves.toHaveLength(1);
  });

  it("uses optimistic revisions for document updates", async () => {
    const created = await repository.create(owner, {
      title: "Revisioned",
      scopeType: "global",
      scopeRef: null,
      document: document(),
    });

    const updated = await repository.replaceDocument(owner, created.id, {
      baseRevision: 1,
      document: document([node("node_a")]),
    });

    expect(updated.revision).toBe(2);
    await expect(repository.replaceDocument(owner, created.id, {
      baseRevision: 1,
      document: document(),
    })).rejects.toBeInstanceOf(CanvasConflictError);
  });

  it("patches nodes with strict optimistic revisions", async () => {
    const created = await repository.create(owner, {
      title: "Patchable",
      scopeType: "global",
      scopeRef: null,
      document: document([node("node_a"), node("node_b")]),
    });

    const first = await repository.patchNode(owner, created.id, {
      baseRevision: 1,
      nodeId: "node_a",
      updates: { metadata: { label: "A" } },
    });
    await expect(repository.patchNode(owner, created.id, {
      baseRevision: 1,
      nodeId: "node_b",
      updates: { metadata: { label: "B" } },
    })).rejects.toBeInstanceOf(CanvasConflictError);
    const second = await repository.patchNode(owner, created.id, {
      baseRevision: first.revision,
      nodeId: "node_b",
      updates: { metadata: { label: "B" } },
    });

    expect(first.revision).toBe(2);
    expect(second.revision).toBe(3);
    await expect(repository.get(owner, created.id)).resolves.toMatchObject({
      nodes: [
        expect.objectContaining({ id: "node_a", metadata: { label: "A" } }),
        expect.objectContaining({ id: "node_b", metadata: { label: "B" } }),
      ],
    });
  });

  it("does not end a shared pool from transaction-scoped wrappers", async () => {
    const pool = { end: vi.fn() };
    const wrapper = new CanvasRepository(repository.kysely, pool as any);

    await wrapper.destroy();

    expect(pool.end).not.toHaveBeenCalled();
  });

  it("does not double-end pools owned by the Kysely dialect", async () => {
    const pool = { end: vi.fn() };
    const owned = new CanvasRepository(pglite.dialect, pool as any);

    await owned.destroy();

    expect(pool.end).not.toHaveBeenCalled();
  });

  it("excludes soft-deleted documents from normal and export reads", async () => {
    const created = await repository.create(owner, {
      title: "Exportable",
      scopeType: "global",
      scopeRef: null,
      document: document(),
    });

    await repository.softDelete(owner, created.id);

    expect(await repository.get(owner, created.id)).toBeNull();
    expect(await repository.export(owner, created.id)).toBeNull();
    await expect(repository.softDelete(owner, created.id)).rejects.toBeInstanceOf(CanvasNotFoundError);
  });

  it("rolls back all writes when a transaction fails", async () => {
    await expect(repository.withTransaction(async (tx) => {
      await tx.create(owner, {
        title: "Rolled back",
        scopeType: "global",
        scopeRef: null,
        document: document(),
      });
      throw new Error("rollback");
    })).rejects.toThrow("rollback");

    await expect(repository.list(owner)).resolves.toHaveLength(0);
  });
});
