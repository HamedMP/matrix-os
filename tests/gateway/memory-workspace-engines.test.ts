import { describe, expect, it, vi } from "vitest";
import { createMemoryEngines } from "../../packages/gateway/src/memory-workspace/engines/index.js";
const source = {
  id: "00000000-0000-4000-8000-000000000001",
  title: "Note",
  content: "My note",
  preview: "My note",
  kind: "note" as const,
  collection: "Notes",
  revision: 1,
  occurredAt: null,
  updatedAt: new Date().toISOString(),
  ingestion: { hindsight: "pending" as const, openviking: "pending" as const },
};
describe("memory engine HTTP adapters", () => {
  it("rejects non-loopback operator URLs and defaults to no engines", () => {
    expect(createMemoryEngines({})).toEqual({});
    expect(() =>
      createMemoryEngines({ MEMORY_HINDSIGHT_URL: "http://169.254.169.254" }),
    ).toThrow();
    expect(() =>
      createMemoryEngines({ MEMORY_HINDSIGHT_URL: "http://localhost:8888" }),
    ).toThrow();
  });
  it("retains revision metadata synchronously and reads document provenance", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, async: false })),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              {
                text: "Remembered fact",
                document_id: source.id,
                metadata: { matrix_revision: "1" },
                scores: { final: 0.8 },
              },
            ],
          }),
        ),
      );
    const engine = createMemoryEngines(
      { MEMORY_HINDSIGHT_URL: "http://127.0.0.1:8888" },
      fetcher,
    ).hindsight!;
    await engine.upsert("alice", source, new AbortController().signal);
    const [url, init] = fetcher.mock.calls[0];
    expect(url.toString()).toContain("/memories");
    expect(JSON.parse(init.body).items[0]).toMatchObject({
      document_id: source.id,
      metadata: { matrix_revision: "1" },
    });
    expect(init.signal).toBeDefined();
    expect(init.redirect).toBe("error");
    expect(
      await engine.search("alice", "fact", 8, new AbortController().signal),
    ).toEqual([
      {
        sourceId: source.id,
        revision: 1,
        text: "Remembered fact",
        score: 0.8,
        provenance: "summary",
      },
    ]);
  });
  it("uploads actual note text, waits for indexing and searches scoped resources", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: "ok", result: { temp_file_id: "tmp-one" } }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "ok",
            result: { root_uri: "viking://resources/x" },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "ok",
            result: {
              resources: [
                {
                  uri: `viking://resources/matrix/owner/${source.id}/r1/note.md`,
                  abstract: "Summary",
                  score: 0.9,
                },
              ],
            },
          }),
        ),
      );
    const engine = createMemoryEngines(
      { MEMORY_OPENVIKING_URL: "http://127.0.0.1:1933" },
      fetcher,
    ).openviking!;
    await engine.upsert("alice", source, new AbortController().signal);
    expect(fetcher.mock.calls[1][1].body).toBeInstanceOf(FormData);
    expect(JSON.parse(fetcher.mock.calls[2][1].body)).toMatchObject({
      temp_file_id: "tmp-one",
      wait: true,
      timeout: 90,
    });
    const result = await engine.search(
      "alice",
      "note",
      8,
      new AbortController().signal,
    );
    expect(result[0]).toMatchObject({
      sourceId: source.id,
      revision: 1,
      text: "Summary",
    });
  });
  it("does not treat malformed or asynchronous retain responses as completed", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true, async: true })),
      );
    await expect(
      createMemoryEngines(
        { MEMORY_HINDSIGHT_URL: "http://127.0.0.1:8888" },
        fetcher,
      ).hindsight!.upsert("alice", source, new AbortController().signal),
    ).rejects.toThrow();
  });
});
