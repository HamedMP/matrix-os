import { beforeEach, afterEach, it, expect } from "vitest";
import { sql } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { MemoryWorkspaceRepository } from "../../packages/gateway/src/memory-workspace/repository.js";
import { MemoryIngestionWorker } from "../../packages/gateway/src/memory-workspace/ingestion-worker.js";
import { MemoryWorkspaceService } from "../../packages/gateway/src/memory-workspace/service.js";
import type { MemoryEngineAdapter } from "../../packages/gateway/src/memory-workspace/engines/index.js";
let repo: MemoryWorkspaceRepository;
const request = {
  clientRequestId: "one",
  sources: [
    {
      externalId: "note",
      title: "Decision",
      content: "Old secret",
      kind: "note" as const,
      collection: "Notes",
    },
  ],
};
beforeEach(async () => {
  repo = new MemoryWorkspaceRepository((await KyselyPGlite.create()).dialect);
  await repo.bootstrap();
});
afterEach(async () => {
  await repo.destroy();
});
function gate() {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release: () => release(), entered: () => entered(), wait, started };
}
it("keeps the corrected revision ready when an expired old lease commits last", async () => {
  const {
    sources: [source],
  } = await repo.importSources("alice", request);
  const remote = new Map<number, string>();
  const slow = gate();
  let first = true;
  const adapter: MemoryEngineAdapter = {
    id: "hindsight",
    search: async () => [],
    delete: async (_owner, _id, revision) => {
      remote.delete(revision);
    },
    upsert: async (_owner, s) => {
      if (first) {
        first = false;
        slow.entered();
        await slow.wait;
      }
      remote.set(s.revision, s.content);
    },
  };
  const oldWorker = new MemoryIngestionWorker(repo, { hindsight: adapter });
  const otherWorker = new MemoryIngestionWorker(repo, { hindsight: adapter });
  const oldRun = oldWorker.tick();
  await slow.started;
  await repo.patchSource("alice", source.id, {
    baseRevision: 1,
    content: "New correction",
  });
  await sql`UPDATE memory_workspace_jobs SET lease_until=now()-interval '1 second' WHERE source_id=${source.id} AND status='processing'`.execute(
    repo.kysely,
  );
  await otherWorker.tick(); // Receipts from the obsolete lease are safely superseded.
  await otherWorker.tick(); // New revision commits first.
  expect(remote.get(2)).toBe("New correction");
  slow.release();
  await oldRun;
  expect(remote.get(2)).toBe("New correction");
  expect(remote.has(1)).toBe(false);
  expect((await repo.getSource("alice", source.id))?.ingestion.hindsight).toBe(
    "ready",
  );
});
it("a late deletion of an expired cleanup lease cannot remove a restored source", async () => {
  const {
    sources: [source],
  } = await repo.importSources("alice", request);
  await repo.deleteSource("alice", source.id);
  const remote = new Map<number, string>([[1, "Old secret"]]);
  const slow = gate();
  let first = true;
  const adapter: MemoryEngineAdapter = {
    id: "hindsight",
    search: async () => [],
    upsert: async (_owner, s) => {
      remote.set(s.revision, s.content);
    },
    delete: async (_owner, _id, revision) => {
      if (first) {
        first = false;
        slow.entered();
        await slow.wait;
      }
      remote.delete(revision);
    },
  };
  const worker = new MemoryIngestionWorker(repo, { hindsight: adapter });
  const other = new MemoryIngestionWorker(repo, { hindsight: adapter });
  const deletionRun = worker.tick();
  await slow.started;
  await repo.importSources("alice", {
    ...request,
    clientRequestId: "restore",
    sources: [{ ...request.sources[0], content: "Restored correction" }],
  });
  await sql`UPDATE memory_workspace_jobs SET lease_until=now()-interval '1 second' WHERE source_id=${source.id} AND status='processing'`.execute(
    repo.kysely,
  );
  await other.tick();
  await other.tick();
  expect(remote.get(3)).toBe("Restored correction");
  slow.release();
  await deletionRun;
  expect(remote.get(3)).toBe("Restored correction");
  expect((await repo.getSource("alice", source.id))?.ingestion.hindsight).toBe(
    "ready",
  );
});
it.each(["search", "compare"])(
  "drops original text from %s if correction completes after retrieval read",
  async (mode) => {
    const {
      sources: [source],
    } = await repo.importSources("alice", request);
    const leased = await repo.claimJob("hindsight");
    await repo.finishJob(leased!.id, leased!.leaseToken, true);
    const get = repo.getSource.bind(repo);
    let captured = false;
    repo.getSource = async (owner, id) => {
      const value = await get(owner, id);
      if (!captured) {
        captured = true;
        await repo.patchSource(owner, id, {
          baseRevision: 1,
          content: "New correction",
        });
      }
      return value;
    };
    const service = new MemoryWorkspaceService(repo, {
      hindsight: {
        id: "hindsight",
        upsert: async () => {},
        delete: async () => {},
        search: async () => [
          {
            sourceId: source.id,
            revision: 1,
            text: "Old secret",
            provenance: "document",
          },
        ],
      },
    });
    if (mode === "search") {
      const result = await service.search(
        "alice",
        "Old secret quoted",
        "hindsight",
        8,
      );
      expect(result.status).toBe("ready");
      expect(result.hits).toEqual([]);
    } else {
      const result = await service.compare("alice", "Old secret quoted", 8);
      expect(result.results[0].hits).toEqual([]);
      expect(
        (
          await sql`SELECT * FROM memory_workspace_comparisons`.execute(
            repo.kysely,
          )
        ).rows,
      ).toEqual([]);
    }
  },
);
