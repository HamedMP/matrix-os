import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import {
  MemoryWorkspaceRepository,
  MemoryConflictError,
} from "../../packages/gateway/src/memory-workspace/repository.js";
const request = {
  clientRequestId: "one",
  sources: [
    {
      externalId: "n1",
      title: "First",
      content: "Private note",
      kind: "note" as const,
      collection: "Notes",
    },
  ],
};
describe("memory repository", () => {
  let repo: MemoryWorkspaceRepository;
  beforeEach(async () => {
    const pg = await KyselyPGlite.create();
    repo = new MemoryWorkspaceRepository(pg.dialect);
    await repo.bootstrap();
  });
  afterEach(async () => {
    await repo.destroy();
  });
  it("atomically imports sources and independent jobs idempotently with owner isolation", async () => {
    const first = await repo.importSources("alice", request);
    const again = await repo.importSources("alice", request);
    expect(again.receipt).toEqual(first.receipt);
    expect((await repo.listJobs("alice")).length).toBe(2);
    expect(await repo.getSource("bob", first.sources[0].id)).toBeNull();
    expect(await repo.listSources("bob")).toEqual([]);
  });
  it("updates by revision, clears stale ingestion and blocks tombstoned reads", async () => {
    const {
      sources: [s],
    } = await repo.importSources("alice", request);
    const updated = await repo.patchSource("alice", s.id, {
      baseRevision: 1,
      content: "Changed",
    });
    expect(updated.revision).toBe(2);
    expect(updated.ingestion.hindsight).toBe("pending");
    await expect(
      repo.patchSource("alice", s.id, { baseRevision: 1, title: "Stale" }),
    ).rejects.toBeInstanceOf(MemoryConflictError);
    await repo.deleteSource("alice", s.id);
    expect(await repo.getSource("alice", s.id)).toBeNull();
    expect(
      (await repo.listJobs("alice")).filter((j) => j.operation === "delete"),
    ).toHaveLength(4);
  });
  it("leases jobs once, settles by lease token and recovers expiration", async () => {
    await repo.importSources("alice", request);
    const job = await repo.claimJob("hindsight", 1000);
    expect(job).not.toBeNull();
    expect(await repo.claimJob("hindsight", 1000)).toBeNull();
    expect(
      await repo.finishJob(
        job!.id,
        "00000000-0000-4000-8000-000000000000",
        true,
      ),
    ).toBe(false);
    await sql`UPDATE memory_workspace_jobs SET lease_until=now()-interval '1 second' WHERE id=${job!.id}`.execute(
      repo.kysely,
    );
    const retry = await repo.claimJob("hindsight", 1000);
    expect(retry?.id).toBe(job?.id);
    expect(retry?.attempts).toBe(2);
    expect(await repo.finishJob(retry!.id, retry!.leaseToken, true)).toBe(true);
    expect((await repo.listSources("alice"))[0].ingestion.hindsight).toBe(
      "ready",
    );
  });
});
describe("memory repository recovery", () => {
  let repo: MemoryWorkspaceRepository;
  beforeEach(async () => {
    const pg = await KyselyPGlite.create();
    repo = new MemoryWorkspaceRepository(pg.dialect);
    await repo.bootstrap();
  });
  afterEach(async () => {
    await repo.destroy();
  });
  it("rejects reused request IDs with different content and deduplicates unchanged records across requests", async () => {
    await repo.importSources("alice", request);
    await expect(
      repo.importSources("alice", {
        ...request,
        sources: [{ ...request.sources[0], content: "Different" }],
      }),
    ).rejects.toBeInstanceOf(MemoryConflictError);
    await repo.importSources("alice", { ...request, clientRequestId: "two" });
    expect(await repo.listJobs("alice")).toHaveLength(2);
  });
  it("does not lease a newer source revision while an earlier job is processing", async () => {
    const {
      sources: [s],
    } = await repo.importSources("alice", request);
    const leased = await repo.claimJob("hindsight");
    await repo.patchSource("alice", s.id, {
      baseRevision: 1,
      content: "Revision two",
    });
    expect(await repo.claimJob("hindsight")).toBeNull();
    await repo.finishJob(leased!.id, leased!.leaseToken, true);
    expect((await repo.claimJob("hindsight"))?.revision).toBe(2);
  });
  it("marks an exhausted expired job failed instead of leaving it processing forever", async () => {
    await repo.importSources("alice", request);
    const j = await repo.claimJob("hindsight");
    await sql`UPDATE memory_workspace_jobs SET attempts=3,lease_until=now()-interval '1 second' WHERE id=${j!.id}`.execute(
      repo.kysely,
    );
    expect(await repo.claimJob("hindsight")).toBeNull();
    expect(
      (await repo.listJobs("alice")).find((row) => row.id === j!.id)?.status,
    ).toBe("failed");
  });
});
describe("memory library pagination", () => {
  let repo: MemoryWorkspaceRepository;
  beforeEach(async () => {
    const pg = await KyselyPGlite.create();
    repo = new MemoryWorkspaceRepository(pg.dialect);
    await repo.bootstrap();
  });
  afterEach(async () => {
    await repo.destroy();
  });
  it("searches and filters across the corpus, not just the first loaded page", async () => {
    await repo.importSources("alice", {
      clientRequestId: "page",
      sources: [
        ...request.sources,
        {
          externalId: "n2",
          title: "Other",
          content: "Quantum project",
          kind: "document",
          collection: "Research",
        },
      ],
    });
    expect(await repo.listSources("alice", { limit: 1 })).toHaveLength(1);
    expect(
      (
        await repo.listSources("alice", {
          q: "Quantum",
          kind: "document",
          collection: "Research",
        })
      )[0].title,
    ).toBe("Other");
    expect(await repo.countSources("alice", { kind: "note" })).toEqual({
      totalSources: 2,
      filteredSources: 1,
    });
    expect((await repo.collections("alice")).collections).toEqual([
      { name: "Notes", count: 1 },
      { name: "Research", count: 1 },
    ]);
    expect((await repo.collections("bob")).collections).toEqual([]);
  });
  it("bounds source bodies in SQL before returning a library page but preserves originals", async () => {
    const content = "x".repeat(200_000);
    const {
      sources: [source],
    } = await repo.importSources("alice", {
      ...request,
      sources: [{ ...request.sources[0], content }],
    });
    const transferredContent: string[] = [];
    const reader = new MemoryWorkspaceRepository(
      repo.kysely.withPlugin({
        transformQuery(args) {
          return args.node;
        },
        async transformResult(args) {
          for (const row of args.result.rows) {
            if (typeof row.content === "string")
              transferredContent.push(row.content);
          }
          return args.result;
        },
      }),
    );
    const page = await reader.listSources("alice");
    expect(transferredContent.map((text) => text.length)).toEqual([240]);
    expect(page[0]).toMatchObject({
      content: "x".repeat(240),
      contentTruncated: true,
    });
    expect((await repo.getSource("alice", source.id))?.content).toBe(content);
  });
  it("keeps current ingestion receipts visible after thousands of later obsolete jobs", async () => {
    const {
      sources: [source],
    } = await repo.importSources("alice", request);
    await sql`UPDATE memory_workspace_sources SET revision=5000 WHERE id=${source.id}`.execute(
      repo.kysely,
    );
    await sql`UPDATE memory_workspace_jobs SET revision=5000,status='ready',updated_at=now()-interval '1 day' WHERE source_id=${source.id}`.execute(
      repo.kysely,
    );
    await sql`INSERT INTO memory_workspace_jobs(id,owner_id,source_id,engine,revision,operation,status,updated_at)
          SELECT gen_random_uuid(),'alice',${source.id}::uuid,'hindsight',n,'upsert','cancelled',now() FROM generate_series(1,4001) n`.execute(
      repo.kysely,
    );
    expect((await repo.listSources("alice"))[0].ingestion).toEqual({
      hindsight: "ready",
      openviking: "ready",
    });
    expect((await repo.getSource("alice", source.id))?.ingestion).toEqual({
      hindsight: "ready",
      openviking: "ready",
    });
  });
  it("retains bounded comparison results privately in Postgres", async () => {
    await repo.recordComparison("alice", "question", [
      { engine: "hindsight", status: "not_configured", latencyMs: 0, hits: [] },
    ]);
    const { rows } = await sql<{
      owner_id: string;
      query: string;
    }>`SELECT owner_id,query FROM memory_workspace_comparisons`.execute(
      repo.kysely,
    );
    expect(rows).toEqual([{ owner_id: "alice", query: "question" }]);
  });
});

describe("memory retention and deletion", () => {
  let repo: MemoryWorkspaceRepository;
  beforeEach(async () => {
    const pg = await KyselyPGlite.create();
    repo = new MemoryWorkspaceRepository(pg.dialect);
    await repo.bootstrap();
  });
  afterEach(async () => {
    await repo.destroy();
  });
  it("deletion removes originals and derivative comparison text from Matrix storage", async () => {
    const {
      sources: [s],
    } = await repo.importSources("alice", request);
    await repo.recordComparison("alice", "Which note?", [
      {
        engine: "hindsight",
        status: "ready",
        latencyMs: 0,
        hits: [
          {
            sourceId: s.id,
            title: s.title,
            text: "Private note",
            provenance: "summary",
            citation: { sourceId: s.id, revision: 1, label: s.title },
          },
        ],
      },
    ]);
    await repo.deleteSource("alice", s.id);
    const rows = (
      await sql<{
        content: string;
        title: string;
      }>`SELECT content,title FROM memory_workspace_sources WHERE id=${s.id}`.execute(
        repo.kysely,
      )
    ).rows;
    expect(rows).toEqual([{ content: "", title: "Deleted source" }]);
    expect(
      (
        await sql`SELECT * FROM memory_workspace_comparisons`.execute(
          repo.kysely,
        )
      ).rows,
    ).toEqual([]);
  });
  it("prunes old receipts and obsolete terminal jobs while preserving current ingestion status", async () => {
    const {
      sources: [s],
    } = await repo.importSources("alice", request);
    await repo.patchSource("alice", s.id, {
      baseRevision: 1,
      content: "Current",
    });
    await sql`UPDATE memory_workspace_jobs SET updated_at=now()-interval '8 days' WHERE revision=1`.execute(
      repo.kysely,
    );
    await sql`UPDATE memory_workspace_imports SET created_at=now()-interval '31 days'`.execute(
      repo.kysely,
    );
    await repo.prune();
    expect(
      (await repo.listJobs("alice"))
        .filter((j) => j.operation === "upsert")
        .every((j) => j.revision === 2),
    ).toBe(true);
    expect(
      (await sql`SELECT * FROM memory_workspace_imports`.execute(repo.kysely))
        .rows,
    ).toEqual([]);
    expect((await repo.getSource("alice", s.id))?.content).toBe("Current");
  });
  it("rejects concurrent duplicate claims for the same engine", async () => {
    await repo.importSources("alice", request);
    const claims = await Promise.all([
      repo.claimJob("hindsight"),
      repo.claimJob("hindsight"),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });
  it("does not resurrect comparison evidence captured before a source was deleted", async () => {
    const {
      sources: [source],
    } = await repo.importSources("alice", request);
    // A search has already resolved this evidence while deletion completes before persistence.
    const captured = [
      {
        engine: "hindsight" as const,
        status: "ready" as const,
        latencyMs: 1,
        hits: [
          {
            sourceId: source.id,
            title: source.title,
            text: "Private note",
            provenance: "summary" as const,
            citation: {
              sourceId: source.id,
              revision: source.revision,
              label: source.title,
            },
          },
        ],
      },
    ];
    await repo.deleteSource("alice", source.id);
    const revalidated = await repo.recordComparison(
      "alice",
      "Question quoting Private note",
      captured,
    );
    expect(revalidated[0].hits).toEqual([]);
    expect(
      (
        await sql`SELECT * FROM memory_workspace_comparisons`.execute(
          repo.kysely,
        )
      ).rows,
    ).toEqual([]);
  });
  it("rejects changed and foreign evidence but keeps current evidence in the response", async () => {
    const {
      sources: [source],
    } = await repo.importSources("alice", request);
    const hit = {
      sourceId: source.id,
      title: source.title,
      text: "Private note",
      provenance: "summary" as const,
      citation: {
        sourceId: source.id,
        revision: source.revision,
        label: source.title,
      },
    };
    await repo.patchSource("alice", source.id, {
      baseRevision: 1,
      content: "New decision",
    });
    const {
      sources: [foreign],
    } = await repo.importSources("bob", request);
    const current = {
      ...hit,
      text: "New decision",
      citation: { ...hit.citation, revision: 2 },
    };
    const revalidated = await repo.recordComparison("alice", "question", [
      {
        engine: "hindsight",
        status: "ready",
        latencyMs: 1,
        hits: [
          hit,
          {
            ...hit,
            sourceId: foreign.id,
            citation: { ...hit.citation, sourceId: foreign.id },
          },
          current,
        ],
      },
    ]);
    expect(revalidated[0].hits).toEqual([current]);
    expect(
      (
        await sql`SELECT * FROM memory_workspace_comparisons`.execute(
          repo.kysely,
        )
      ).rows,
    ).toEqual([]);
  });

  it("allows failed deletion retries but rejects cancellation of cleanup jobs", async () => {
    const {
      sources: [source],
    } = await repo.importSources("alice", request);
    await repo.deleteSource("alice", source.id);
    const cleanup = (await repo.listJobs("alice")).find(
      (job) => job.operation === "delete",
    )!;
    expect(await repo.jobAction("alice", cleanup.id, "cancel")).toBe(false);
    expect(
      (await repo.listJobs("alice")).find((job) => job.id === cleanup.id)
        ?.status,
    ).toBe("pending");
    await sql`UPDATE memory_workspace_jobs SET status='failed',attempts=3 WHERE id=${cleanup.id}`.execute(
      repo.kysely,
    );
    expect(await repo.jobAction("alice", cleanup.id, "retry")).toBe(true);
    expect(
      (await repo.listJobs("alice")).find((job) => job.id === cleanup.id),
    ).toMatchObject({ status: "pending", attempts: 0 });
  });
});
