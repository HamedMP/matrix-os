import { expect, it, vi } from "vitest";
import { createApiClient } from "../../desktop/src/renderer/src/lib/api";
import { loadMatrixUsage } from "../../desktop/src/renderer/src/lib/ai-usage-history";
import { createHistoryReports } from "../../packages/contracts/src/ai-usage/history-report";
const builder = createHistoryReports(
  "2026-01-01T00:00:00Z",
  "UTC",
  new Date("2026-11-09T00:00:00Z"),
);
builder.push({
  id: "event",
  session: "session",
  agent: "claude",
  model: "unknown",
  timestamp: "2026-01-01T12:00:00Z",
  input: 5,
  cachedInput: 0,
  cacheWrite: 0,
  output: 3,
});
const report = {
  version: 1,
  events: [],
  issues: 0,
  history: {
    reports: builder.finish(),
    coverage: {
      machines: ["Mac", "Matrix"],
      files: 2,
      bytes: 100,
      indexedBytes: 100,
      oldest: "2026-01-01T00:00:00Z",
      newest: "2026-01-01T00:00:00Z",
      issues: 0,
      failedRoots: 0,
      indexedAt: "2026-11-09T00:00:00Z",
    },
  },
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
function client(fetchFn: ReturnType<typeof vi.fn>) {
  return createApiClient({
    baseUrl: "https://matrix.example",
    getRuntimeSlot: () => "primary",
    fetchFn,
  });
}
it.each(["missing", "recent"])(
  "shows recovered history through the authenticated file API on %s runtimes",
  async (kind) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        kind === "missing"
          ? json({ error: "not_found" }, 404)
          : json({ version: 1, events: [], issues: 0 }),
      )
      .mockResolvedValueOnce(json({ version: 1, ownerId: "owner", report }));
    const result = await loadMatrixUsage(
      client(fetch),
      "owner",
      new AbortController().signal,
    );
    expect(result.backup).toBe(true);
    expect(
      result.snapshot.history!.reports.find(
        (r) => r.id === "all" && r.agent === "",
      )!.summary.tokens,
    ).toBe(8);
    expect(new URL(fetch.mock.calls[1][0]).searchParams.get("path")).toBe(
      "exports/ai-usage/latest.json",
    );
  },
);
it("uses the live index when available", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(json(report));
  expect(
    (
      await loadMatrixUsage(
        client(fetch),
        "owner",
        new AbortController().signal,
      )
    ).backup,
  ).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("reads the freshly synced owner export when the paired collector is its authority", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json({ version: 1, ownerId: "owner", report }));
  const result = await loadMatrixUsage(
    client(fetch),
    "owner",
    new AbortController().signal,
    { syncedExport: true },
  );
  expect(result.backup).toBe(true);
  expect(String(fetch.mock.calls[0][0])).toContain("/api/files/blob?");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it.each([401, 403, 503])(
  "does not hide an authority or service failure behind a backup (%s)",
  async (status) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ error: "unavailable" }, status));
    await expect(
      loadMatrixUsage(client(fetch), "owner", new AbortController().signal),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);
it("rejects a snapshot belonging to another signed-in person", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json({ error: "not_found" }, 404))
    .mockResolvedValueOnce(json({ version: 1, ownerId: "other", report }));
  await expect(
    loadMatrixUsage(client(fetch), "owner", new AbortController().signal),
  ).rejects.toThrow();
});
it.each([404,401,503])("retains usable recent counters only when the optional historical export is absent (%s)",async status=>{
 const recent={version:1,events:[{id:"recent",session:"recent",agent:"claude",model:"unknown",timestamp:"2026-11-09T12:00:00Z",input:10,cachedInput:0,cacheWrite:0,output:2}],issues:0};
 const fetch=vi.fn().mockResolvedValueOnce(json(recent)).mockResolvedValueOnce(json({error:"unavailable"},status));
 const result=loadMatrixUsage(client(fetch),"owner",new AbortController().signal);
 if(status===404) expect((await result).snapshot.events).toHaveLength(1);
 else await expect(result).rejects.toThrow();
});
