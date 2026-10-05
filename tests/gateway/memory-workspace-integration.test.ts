import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import {
  createMemoryWorkspaceRuntime,
  createMemoryWorkspaceRoutes,
} from "../../packages/gateway/src/memory-workspace/index.js";
import { MemoryWorkspaceRepository } from "../../packages/gateway/src/memory-workspace/repository.js";
import { createMemoryEngines } from "../../packages/gateway/src/memory-workspace/engines/index.js";
const source = {
  externalId: "mail:1",
  title: "Project decision",
  content: "Use Orion next week.",
  kind: "email",
  collection: "Mail",
  occurredAt: "2026-10-01T10:00:00Z",
};
describe("memory workspace full route and worker path", () => {
  let repository: MemoryWorkspaceRepository;
  beforeEach(async () => {
    const pg = await KyselyPGlite.create();
    repository = new MemoryWorkspaceRepository(pg.dialect);
  });
  afterEach(async () => {
    await repository.destroy();
  });
  it("imports, ingests real HTTP request shapes, compares, edits and deletes with safe Chat context", async () => {
    const fetcher = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        const uri = url.toString();
        let value: unknown = { success: true, async: false };
        if (uri.includes("/recall")) {
          const [s] = await repository.listSources("alice");
          value = {
            results: s
              ? [
                  {
                    document_id: s.id,
                    text: "Use Orion.",
                    metadata: { matrix_revision: String(s.revision) },
                  },
                ]
              : [],
          };
        }
        if (init?.method === "DELETE") value = { memory_units_deleted: 1 };
        return new Response(JSON.stringify(value));
      },
    );
    const runtime = await createMemoryWorkspaceRuntime({
      repository,
      engines: createMemoryEngines(
        { MEMORY_HINDSIGHT_URL: "http://127.0.0.1:8888" },
        fetcher,
      ),
    });
    const app = createMemoryWorkspaceRoutes({
      service: runtime.service,
      getOwnerId: () => "alice",
    });
    const post = (path: string, body: unknown, method = "POST") =>
      app.request(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const imported = await post("/sources", {
      clientRequestId: "test-one",
      sources: [source],
    });
    expect(imported.status).toBe(201);
    const {
      sources: [s],
    } = await imported.json();
    await runtime.worker.tick();
    expect(
      (await runtime.service.getSource("alice", s.id)).ingestion.hindsight,
    ).toBe("ready");
    const compared = await post("/compare", { query: "Which project?" });
    expect((await compared.json()).results[0].hits[0].citation.sourceId).toBe(
      s.id,
    );
    const context = await post("/context", { sourceIds: [s.id] });
    expect((await context.json()).text).toContain("Use Orion next week.");
    const snapshot = await app.request("/?q=Orion&kind=email&collection=Mail");
    expect((await snapshot.json()).filteredSources).toBe(1);
    const patched = await post(
      `/sources/${s.id}`,
      { baseRevision: 1, content: "Use Vega." },
      "PATCH",
    );
    expect((await patched.json()).source.revision).toBe(2);
    expect(
      (
        await post(
          `/sources/${s.id}`,
          { baseRevision: 1, content: "Stale" },
          "PATCH",
        )
      ).status,
    ).toBe(409);
    expect(
      (await post("/search", { query: "Orion", engine: "hindsight" })).status,
    ).toBe(200);
    const jobs = await repository.listJobs("alice");
    const pending = jobs.find(
      (j) => j.engine === "openviking" && j.revision === 2,
    )!;
    expect(
      (await post(`/jobs/${pending.id}/action`, { type: "cancel" })).status,
    ).toBe(200);
    expect(
      (await post(`/jobs/${pending.id}/action`, { type: "retry" })).status,
    ).toBe(200);
    expect(
      (await app.request(`/sources/${s.id}`, { method: "DELETE" })).status,
    ).toBe(200);
    await runtime.worker.tick();
    expect((await app.request(`/sources/${s.id}`)).status).toBe(404);
    await expect(
      runtime.service.resolveChat("alice", [{ id: s.id }]),
    ).rejects.toThrow();
    await runtime.close();
    expect(await repository.listSources("alice")).toEqual([]);
  });
  it("does not create an in-memory replacement when no durable database is configured", async () => {
    await expect(createMemoryWorkspaceRuntime({})).rejects.toThrow(
      "database unavailable",
    );
  });
});
