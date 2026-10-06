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
describe("memory correction and revision cleanup", () => {
  let repo: MemoryWorkspaceRepository;
  beforeEach(async () => {
    repo = new MemoryWorkspaceRepository((await KyselyPGlite.create()).dialect);
    await repo.bootstrap();
  });
  afterEach(async () => {
    await repo.destroy();
  });
  it.each(["patch", "reimport"])(
    "erases old comparison queries and excerpts transactionally on %s",
    async (mode) => {
      const {
        sources: [s],
      } = await repo.importSources("alice", request);
      await repo.recordComparison("alice", "Private note quoted", [
        {
          engine: "hindsight",
          status: "ready",
          latencyMs: 0,
          hits: [
            {
              sourceId: s.id,
              title: s.title,
              text: s.content,
              provenance: "summary",
              citation: { sourceId: s.id, revision: 1, label: s.title },
            },
          ],
        },
      ]);
      if (mode === "patch")
        await repo.patchSource("alice", s.id, {
          baseRevision: 1,
          content: "Corrected",
        });
      else
        await repo.importSources("alice", {
          clientRequestId: "new",
          sources: [{ ...request.sources[0], content: "Corrected" }],
        });
      expect(
        (
          await sql`SELECT * FROM memory_workspace_comparisons WHERE owner_id='alice'`.execute(
            repo.kysely,
          )
        ).rows,
      ).toEqual([]);
      expect(
        (await repo.listJobs("alice"))
          .filter((j) => j.operation === "delete")
          .map((j) => j.revision),
      ).toEqual([1, 1]);
    },
  );
  it("keeps revision cleanup durable across restore and reconciles already completed deletions", async () => {
    const {
      sources: [s],
    } = await repo.importSources("alice", request);
    await repo.deleteSource("alice", s.id);
    await repo.importSources("alice", {
      ...request,
      clientRequestId: "restore",
      sources: [{ ...request.sources[0], restoreDeleted: true }],
    });
    const cleanups = (await repo.listJobs("alice")).filter(
      (j) => j.operation === "delete",
    );
    expect(cleanups).toHaveLength(4);
    expect(
      cleanups.every((j) => j.revision < 3 && j.status === "pending"),
    ).toBe(true);
    await sql`UPDATE memory_workspace_jobs SET status='ready',updated_at=now()-interval '8 days' WHERE operation='delete'`.execute(
      repo.kysely,
    );
    await repo.prune();
    expect(
      (await repo.listJobs("alice")).filter((j) => j.operation === "delete"),
    ).toHaveLength(4);
    expect(
      (await repo.listJobs("alice"))
        .filter((j) => j.operation === "delete")
        .every((j) => j.status === "pending"),
    ).toBe(true);
  });
  it("revalidates standalone search against locked live source revisions", async () => {
    const {
      sources: [s],
    } = await repo.importSources("alice", request);
    const result = {
      engine: "hindsight" as const,
      status: "ready" as const,
      latencyMs: 0,
      hits: [
        {
          sourceId: s.id,
          title: s.title,
          text: s.content,
          provenance: "summary" as const,
          citation: { sourceId: s.id, revision: 1, label: s.title },
        },
      ],
    };
    await repo.patchSource("alice", s.id, {
      baseRevision: 1,
      content: "Corrected",
    });
    expect((await repo.revalidateSearch("alice", [result]))[0].hits).toEqual(
      [],
    );
  });
});

it("backfills cleanup of pre-revision deletion receipts without changing live legacy sources", async () => {
  const repo = new MemoryWorkspaceRepository(
    (await KyselyPGlite.create()).dialect,
  );
  try {
    await repo.bootstrap();
    const {
      sources: [source],
    } = await repo.importSources("alice", request);
    await repo.deleteSource("alice", source.id);
    // Previous releases tagged deletion jobs with the tombstone revision rather than the stored revision.
    await sql`UPDATE memory_workspace_jobs SET revision=2 WHERE operation='delete'`.execute(
      repo.kysely,
    );
    await repo.bootstrap();
    await repo.bootstrap();
    expect(
      (await repo.listJobs("alice")).filter(
        (j) => j.operation === "delete" && j.revision === 1,
      ),
    ).toHaveLength(2);
    expect(await repo.listSources("alice")).toEqual([]);
  } finally {
    await repo.destroy();
  }
});
