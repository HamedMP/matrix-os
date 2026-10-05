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
      document_id: `${source.id}:r1`,
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
  it("labels directory and generated previews as summaries and removes engine storage metadata", async () => {
    const root = `viking://resources/matrix/owner/${source.id}/r1`;
    const generated = `---\nsource_path: /tmp/openviking/uploads/private-note.md\nuri: ${root}\nschema_version: 1\n---\n\nJuniper's launch is Friday. See ${root}/note.md; parsed from /var/lib/matrix/memory-trial/openviking/workspace/chunk.md.`;
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "ok",
          result: {
            resources: [
              { uri: root, content: generated },
              { uri: `${root}/.overview.md`, content: generated },
              { uri: `${root}/.abstract.md`, content: generated },
              {
                uri: `${root}/note.md`,
                content: "engine-original",
                abstract: "original abstract",
              },
            ],
          },
        }),
      ),
    );
    const hits = await createMemoryEngines(
      { MEMORY_OPENVIKING_URL: "http://127.0.0.1:1933" },
      fetcher,
    ).openviking!.search("alice", "Juniper", 8, new AbortController().signal);
    expect(hits.map((hit) => hit.provenance)).toEqual([
      "summary",
      "summary",
      "summary",
      "document",
    ]);
    for (const hit of hits.slice(0, 3)) {
      expect(hit.text).toContain("Juniper's launch is Friday");
      expect(hit.text).not.toMatch(
        /source_path|schema_version|viking:\/\/|\/tmp\/|\/var\/lib\//,
      );
    }
  });
  it("sanitizes abstract-only previews and bounds generated summary excerpts", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "ok",
          result: {
            resources: [
              {
                uri: `viking://resources/matrix/owner/${source.id}/r1/note.md`,
                abstract:
                  "Summary from /private/tmp/openviking/file.md " +
                  "x".repeat(10_000),
              },
            ],
          },
        }),
      ),
    );
    const [hit] = await createMemoryEngines(
      { MEMORY_OPENVIKING_URL: "http://127.0.0.1:1933" },
      fetcher,
    ).openviking!.search("alice", "summary", 8, new AbortController().signal);
    expect(hit.provenance).toBe("summary");
    expect(hit.text.length).toBeLessThanOrEqual(8000);
    expect(hit.text).not.toContain("/private/tmp/");
  });
});

it("isolates remote writes and cleanup by revision while accepting legacy Hindsight IDs", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const fetcher = vi.fn(async (url, init) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    requests.push({ url: url.toString(), body });
    if (url.toString().includes("/recall"))
      return new Response(
        JSON.stringify({
          results: [
            {
              document_id: source.id,
              metadata: { matrix_revision: "1" },
              text: "legacy",
            },
            {
              document_id: `${source.id}:r2`,
              metadata: { matrix_source_id: source.id, matrix_revision: "2" },
              text: "current",
            },
            {
              document_id: `${source.id}:r2`,
              metadata: { matrix_source_id: source.id, matrix_revision: "1" },
              text: "mismatched",
            },
          ],
        }),
      );
    if (url.toString().includes("temp_upload"))
      return new Response(
        JSON.stringify({ status: "ok", result: { temp_file_id: "file" } }),
      );
    return new Response(
      JSON.stringify({ success: true, async: false, status: "ok", result: {} }),
    );
  });
  const engines = createMemoryEngines(
    {
      MEMORY_HINDSIGHT_URL: "http://127.0.0.1:8888",
      MEMORY_OPENVIKING_URL: "http://127.0.0.1:1933",
    },
    fetcher,
  );
  const signal = new AbortController().signal;
  await engines.hindsight!.upsert("alice", { ...source, revision: 2 }, signal);
  expect(requests[0].body.items[0].document_id).toBe(`${source.id}:r2`);
  await engines.hindsight!.delete("alice", source.id, 1, signal);
  expect(
    requests
      .filter((r) => r.url.includes("/documents/"))
      .map((r) => decodeURIComponent(r.url.split("/documents/")[1])),
  ).toEqual([`${source.id}:r1`, source.id]);
  expect(
    (await engines.hindsight!.search("alice", "q", 8, signal)).map(
      (h) => h.text,
    ),
  ).toEqual(["legacy", "current"]);
  requests.length = 0;
  await engines.openviking!.upsert("alice", { ...source, revision: 2 }, signal);
  await engines.openviking!.delete("alice", source.id, 1, signal);
  const paths = requests
    .filter((r) => r.url.includes("/fs?"))
    .map((r) => new URL(r.url).searchParams.get("uri"));
  expect(paths[0]).toMatch(new RegExp(`/${source.id}/r2$`));
  expect(paths[1]).toMatch(new RegExp(`/${source.id}/r1$`));
});
