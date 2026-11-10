import { expect, it, vi } from "vitest";
import { loadMatrixUsage } from "../../packages/ui/src/ai-usage/load-matrix-usage";
import { loadDesktopUsage } from "../../desktop/src/renderer/src/lib/ai-usage-history";
import { AppError } from "../../desktop/src/shared/app-error";
const totals = { tokens: 8, input: 6, cachedInput: 0, cacheWrite: 0, output: 2, requests: 1, estimatedUsd: null, unpriced: 1 };
const report = {
  version: 1, events: [], issues: 0,
  history: {
    timeZone: "UTC",
    reports: [{ id: "all", label: "All", agent: "", endDay: "2026-11-09", days: 1,
      summary: { ...totals, sessions: 1, activeDays: 1, daily: [{ ...totals, day: "2026-11-09" }], models: [] } }],
    coverage: { machines: ["Mac"], files: 1, bytes: 1, indexedBytes: 1, oldest: null, newest: null, issues: 0, failedRoots: 0, indexedAt: "2026-11-09T12:00:00.000Z" },
  },
};
class HttpError extends Error { constructor(readonly status: number) { super("http"); } }
const transport = (responses: Array<unknown | HttpError>) => {
  const get = vi.fn(async (_path: string) => {
    const next = responses.shift();
    if (next instanceof HttpError) throw next;
    return next;
  });
  return { get, status: (e: unknown) => (e instanceof HttpError ? e.status : undefined) };
};
const signal = () => new AbortController().signal;
it("asks the live index for the viewer's timezone", async () => {
  const t = transport([report]);
  await loadMatrixUsage(t, "owner", signal(), { timeZone: "Europe/Stockholm" });
  expect(t.get.mock.calls[0][0]).toBe("/api/ai-usage?timeZone=Europe%2FStockholm");
});
it("gives web the same owner-bound export fallback as desktop when the computer has no live index", async () => {
  const t = transport([new HttpError(404), { version: 1, ownerId: "owner", report }]);
  const result = await loadMatrixUsage(t, "owner", signal());
  expect(result.backup).toBe(true);
  expect(t.get.mock.calls[1][0]).toContain("exports%2Fai-usage%2Flatest.json");
  const other = transport([new HttpError(404), { version: 1, ownerId: "someone-else", report }]);
  await expect(loadMatrixUsage(other, "owner", signal())).rejects.toThrow("Usage unavailable");
});
it("never reads an export without a known signed-in owner, and never falls back on a service failure", async () => {
  const anonymous = transport([new HttpError(404), { version: 1, ownerId: "owner", report }]);
  await expect(loadMatrixUsage(anonymous, null, signal())).rejects.toThrow();
  expect(anonymous.get).toHaveBeenCalledTimes(1);
  const failing = transport([new HttpError(503), { version: 1, ownerId: "owner", report }]);
  await expect(loadMatrixUsage(failing, "owner", signal())).rejects.toThrow();
  expect(failing.get).toHaveBeenCalledTimes(1);
});
it("shows Matrix history when the Mac transfer fails instead of an empty panel", async () => {
  const get = vi.fn().mockRejectedValueOnce(new AppError("server", { httpStatus: 404 }))
    .mockResolvedValueOnce({ version: 1, ownerId: "owner", report });
  const result = await loadDesktopUsage({
    sync: async () => { throw new Error("ssh unreachable"); },
    api: { get } as never, owner: "owner", signal: signal(), timeZone: "UTC",
  });
  expect(result.sync).toBe("failed");
  expect(result.snapshot.history?.reports[0].summary.tokens).toBe(8);
  const synced = vi.fn().mockResolvedValueOnce({ version: 1, ownerId: "owner", report });
  expect((await loadDesktopUsage({ sync: async () => ({ status: "synced" }), api: { get: synced } as never, owner: "owner", signal: signal() })).sync).toBe("synced");
  expect(String(synced.mock.calls[0][0])).toContain("/api/files/blob?");
});
