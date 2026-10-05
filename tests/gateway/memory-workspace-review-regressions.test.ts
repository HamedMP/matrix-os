import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { MemoryWorkspaceRepository, MemoryConflictError, MemoryNotFoundError } from "../../packages/gateway/src/memory-workspace/repository.js";
import { MemoryWorkspaceService } from "../../packages/gateway/src/memory-workspace/service.js";
import { MemoryContextRequestSchema } from "@matrix-os/contracts";
const input = { clientRequestId: "one", sources: [{ externalId: "one", title: "Original", content: "Forgotten secret", kind: "note" as const, collection: "Notes" }] };
let repo: MemoryWorkspaceRepository;
beforeEach(async () => { repo = new MemoryWorkspaceRepository((await KyselyPGlite.create()).dialect); await repo.bootstrap(); });
afterEach(async () => { vi.restoreAllMocks(); await repo.destroy(); });

it("classifies stale and missing patches within their transaction without requesting another connection", async () => {
  const { sources: [source] } = await repo.importSources("alice", input);
  const externalRead = vi.spyOn(repo, "getSource").mockRejectedValue(new Error("outside transaction"));
  await expect(repo.patchSource("alice", source.id, { baseRevision: 99, title: "stale" })).rejects.toBeInstanceOf(MemoryConflictError);
  await expect(repo.patchSource("alice", "00000000-0000-4000-8000-000000000002", { baseRevision: 1, title: "missing" })).rejects.toBeInstanceOf(MemoryNotFoundError);
  expect(externalRead).not.toHaveBeenCalled();
});
it("keeps tombstones on ordinary import and requires owner-scoped explicit restoration with distinct receipt intent", async () => {
  const { sources: [source] } = await repo.importSources("alice", input);
  await repo.deleteSource("alice", source.id);
  await expect(repo.importSources("alice", { ...input, clientRequestId: "ordinary" })).rejects.toBeInstanceOf(MemoryConflictError);
  expect(await repo.getSource("alice", source.id)).toBeNull();
  const restoredInput = { clientRequestId: "restore", sources: [{ ...input.sources[0], restoreDeleted: true }] };
  const restored = await repo.importSources("alice", restoredInput);
  expect(restored.sources[0]).toMatchObject({ id: source.id, revision: 3, content: "Forgotten secret" });
  expect((await repo.importSources("alice", restoredInput)).receipt).toEqual(restored.receipt);
  await expect(repo.importSources("alice", { ...input, clientRequestId: "restore" })).rejects.toBeInstanceOf(MemoryConflictError);
  const other = await repo.importSources("bob", restoredInput);
  expect(other.sources[0].id).not.toBe(source.id);
});
it("retains only a content-free query receipt even for no-hit comparisons after forgetting", async () => {
  const { sources: [source] } = await repo.importSources("alice", input);
  await repo.deleteSource("alice", source.id);
  await repo.recordComparison("alice", "Forgotten secret", []);
  const rows = (await sql<{ query: string }>`SELECT query FROM memory_workspace_comparisons`.execute(repo.kysely)).rows;
  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toContain("Forgotten secret");
  await sql`UPDATE memory_workspace_comparisons SET query='legacy secret'`.execute(repo.kysely);
  await repo.bootstrap();
  expect(JSON.stringify((await sql`SELECT query FROM memory_workspace_comparisons`.execute(repo.kysely)).rows)).not.toContain("legacy secret");
});
it("projects cancellation truthfully and returns pending only after an explicit retry", async () => {
  const { sources: [source] } = await repo.importSources("alice", input);
  const job = (await repo.listJobs("alice")).find((j) => j.engine === "hindsight")!;
  await repo.jobAction("alice", job.id, "cancel");
  expect((await repo.getSource("alice", source.id))?.ingestion.hindsight).toBe("cancelled");
  await repo.jobAction("alice", job.id, "retry");
  expect((await repo.getSource("alice", source.id))?.ingestion.hindsight).toBe("pending");
});
it.each(["patch", "delete"])("rejects standalone context if %s happens between selected-source reads", async (mode) => {
  const { sources } = await repo.importSources("alice", { clientRequestId: "many", sources: [input.sources[0], { ...input.sources[0], externalId: "two" }] });
  const read = repo.getSource.bind(repo);
  vi.spyOn(repo, "getSource").mockImplementation(async (owner, id) => {
    if (id === sources[1].id) {
      if (mode === "patch") await repo.patchSource(owner, sources[0].id, { baseRevision: 1, content: "corrected" });
      else await repo.deleteSource(owner, sources[0].id);
    }
    return read(owner, id);
  });
  await expect(new MemoryWorkspaceService(repo, {}).context("alice", sources.map((s) => s.id))).rejects.toBeInstanceOf(MemoryConflictError);
});
it("returns every selected original at the thirty-source context limit through real repository validation", async () => {
  const { sources } = await repo.importSources("alice", {
    clientRequestId: "context-max",
    sources: Array.from({ length: 30 }, (_, index) => ({
      ...input.sources[0], externalId: `context-${index}`, title: `Source ${index}`, content: `Original fact ${index}.`,
    })),
  });
  const sourceIds = sources.map(source => source.id);
  expect(MemoryContextRequestSchema.safeParse({ sourceIds }).success).toBe(true);
  const context = await new MemoryWorkspaceService(repo, {}).context("alice", sourceIds);
  expect(context.sources.map(source => source.sourceId)).toEqual(sourceIds);
  expect(context.sources.every(source => source.revision === 1 && !source.truncated)).toBe(true);
  for (const source of sources) expect(context.text).toContain(source.content);
  expect(Buffer.byteLength(context.text)).toBeLessThanOrEqual(24000);
});
it("rejects thirty-one context selections at contract and service admission before reading originals", async () => {
  const sourceIds = Array.from({ length: 31 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
  expect(MemoryContextRequestSchema.safeParse({ sourceIds }).success).toBe(false);
  const read = vi.spyOn(repo, "getSource");
  await expect(new MemoryWorkspaceService(repo, {}).context("alice", sourceIds)).rejects.toBeInstanceOf(MemoryConflictError);
  expect(read).not.toHaveBeenCalled();
});
