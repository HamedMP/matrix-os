import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { CanvasConflictError, CanvasRepository } from "../../packages/gateway/src/canvas/repository.js";

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
