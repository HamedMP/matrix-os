import { describe, expect, it, vi } from "vitest";
import { MemoryWorkspaceService } from "../../packages/gateway/src/memory-workspace/service.js";
import { ChatMemorySnapshotSchema } from "../../packages/contracts/src/chat-agent-context.js";
import type { MemorySource } from "../../packages/contracts/src/memory-workspace.js";
const source: MemorySource = {
  id: "00000000-0000-4000-8000-000000000001",
  title: "Note",
  content: "My untrusted original",
  preview: "My untrusted original",
  kind: "note",
  collection: "Notes",
  revision: 2,
  occurredAt: null,
  updatedAt: new Date().toISOString(),
  ingestion: { hindsight: "ready", openviking: "ready" },
};
function repository() {
  return {
    getSource: vi.fn(async (owner: string, id: string) =>
      owner === "alice" && id === source.id ? source : null,
    ),
    listSources: vi.fn(async () => [source]),
    listJobs: vi.fn(async () => []),
    recordComparison: vi.fn(async () => {}),
  };
}
describe("memory workspace service", () => {
  it("reports unconfigured engines without fabricated retrieval", async () => {
    const service = new MemoryWorkspaceService(repository(), {});
    expect(
      (await service.snapshot("alice")).engines.every(
        (e) => e.status === "not_configured",
      ),
    ).toBe(true);
    expect(
      (await service.search("alice", "question", "hindsight", 8)).status,
    ).toBe("not_configured");
  });
  it("filters deleted, cross-owner and stale revision results", async () => {
    const repo = repository();
    const search = vi.fn(async () => [
      {
        sourceId: source.id,
        revision: 1,
        text: "stale",
        provenance: "summary" as const,
      },
      {
        sourceId: "00000000-0000-4000-8000-000000000002",
        revision: 2,
        text: "private",
        provenance: "summary" as const,
      },
      {
        sourceId: source.id,
        revision: 2,
        text: "fact",
        provenance: "summary" as const,
      },
    ]);
    const service = new MemoryWorkspaceService(repo, {
      hindsight: { id: "hindsight", search, upsert: vi.fn(), delete: vi.fn() },
    });
    expect(
      (await service.search("alice", "question", "hindsight", 8)).hits.map(
        (h) => h.text,
      ),
    ).toEqual(["fact"]);
    expect(
      (await service.search("bob", "question", "hindsight", 8)).hits,
    ).toEqual([]);
  });
  it("isolates failed engines in comparison", async () => {
    const service = new MemoryWorkspaceService(repository(), {
      hindsight: {
        id: "hindsight",
        search: vi.fn(async () => {
          throw new Error("provider secret");
        }),
        upsert: vi.fn(),
        delete: vi.fn(),
      },
    });
    const comparison = await service.compare("alice", "question", 8);
    expect(comparison.results.map((r) => r.status)).toEqual([
      "unavailable",
      "not_configured",
    ]);
    expect(JSON.stringify(comparison)).not.toContain("provider secret");
  });
  it("resolves authorized Chat snapshots and revalidates revisions", async () => {
    const repo = repository();
    const service = new MemoryWorkspaceService(repo, {});
    const snapshots = await service.resolveChat("alice", [
      { id: source.id, revision: 2 },
    ]);
    expect(snapshots[0].text).toContain(source.content);
    await expect(
      service.resolveChat("bob", [{ id: source.id }]),
    ).rejects.toThrow();
    await expect(
      service.resolveChat("alice", [{ id: source.id, revision: 1 }]),
    ).rejects.toThrow();
    repo.getSource.mockResolvedValue({ ...source, revision: 3 });
    await expect(service.revalidateChat("alice", snapshots)).rejects.toThrow();
  });
});
describe("memory context bounds", () => {
  it("uses citation-bearing context and caps UTF-8 bytes across selected sources", async () => {
    const repo = repository();
    repo.getSource.mockResolvedValue({
      ...source,
      content: "😀".repeat(10000),
    });
    const service = new MemoryWorkspaceService(repo, {});
    const result = await service.context("alice", [source.id]);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(24000);
    expect(result.text).toContain("revision 2");
    expect(result.text).not.toContain("�");
    const snapshots = await service.resolveChat("alice", [{ id: source.id }]);
    expect(Buffer.byteLength(snapshots[0].text)).toBe(8000);
    expect(snapshots[0].truncated).toBe(true);
    await expect(service.resolveChat("alice", [])).rejects.toThrow();
    await expect(
      service.resolveChat("alice", Array(9).fill({ id: source.id })),
    ).rejects.toThrow();
    await service.revalidateChat("alice", snapshots);
  });
  it("authorizes every selected source even when earlier sources fill the evidence budget", async () => {
    const repo = repository();
    repo.getSource
      .mockResolvedValueOnce({ ...source, content: "x".repeat(200000) })
      .mockResolvedValueOnce(null);
    const service = new MemoryWorkspaceService(repo, {});
    await expect(
      service.context("alice", [source.id, "other"]),
    ).rejects.toThrow();
  });
});

it("returns comparison hits revalidated during recording", async () => {
  const repo = repository();
  const filtered = [
    {
      engine: "hindsight" as const,
      status: "ready" as const,
      hits: [],
      latencyMs: 1,
    },
  ];
  const service = new MemoryWorkspaceService(
    { ...repo, recordComparison: vi.fn(async () => filtered) },
    {},
  );
  expect((await service.compare("alice", "question", 8)).results).toEqual(
    filtered,
  );
});
it("keeps eight long-source selections valid while authorizing exhausted references", async () => {
  const repo = repository();
  repo.getSource.mockImplementation(async (_owner, id) => ({
    ...source,
    id,
    content: "x".repeat(16000),
  }));
  const refs = Array.from({ length: 8 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
  }));
  const service = new MemoryWorkspaceService(repo, {});
  const snapshots = await service.resolveChat("alice", refs);
  expect(repo.getSource).toHaveBeenCalledTimes(8);
  expect(snapshots.length).toBe(3);
  for (const snapshot of snapshots)
    expect(ChatMemorySnapshotSchema.safeParse(snapshot).success).toBe(true);
  repo.getSource
    .mockResolvedValueOnce({ ...source, content: "x".repeat(16000) })
    .mockResolvedValueOnce({ ...source, content: "x".repeat(16000) })
    .mockResolvedValueOnce({ ...source, content: "x".repeat(16000) })
    .mockResolvedValueOnce(null);
  await expect(service.resolveChat("alice", refs)).rejects.toThrow();
});
