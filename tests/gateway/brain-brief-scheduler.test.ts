import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapBrainBriefDatabase } from "../../packages/gateway/src/brain/brief/database.js";
import {
  BRIEF_START_DELAY_MS, createBrainBriefScheduler, createBrainBriefScopeLister, msUntilNextRun,
} from "../../packages/gateway/src/brain/brief/scheduler.js";
import type { BrainBriefRunner } from "../../packages/gateway/src/brain/contracts.js";
import { createBrainHarness } from "./helpers/brain-store-helpers.js";

const NOW = new Date("2026-10-01T05:00:00.000Z");
const scopes = { listActiveScopes: async () => [] };
const summary = { scopes: 0, built: 0, failed: 0, skipped: 0 };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("brief scheduler", () => {
  it("computes the wait until the next run hour", () => {
    expect(msUntilNextRun(NOW)).toBe(3_600_000);
    expect(msUntilNextRun(new Date("2026-10-01T06:00:00.000Z"))).toBe(86_400_000);
    expect(msUntilNextRun(new Date("2026-10-01T07:00:00.000Z"))).toBe(23 * 3_600_000);
  });

  it("runs once after start, then daily, and stops cleanly", async () => {
    vi.useFakeTimers({ now: NOW });
    const runner = vi.fn<BrainBriefRunner>(async () => summary);
    const job = createBrainBriefScheduler({ runner, ownerId: "owner_a", scopes });
    expect(job.name).toBe("brain-brief");
    job.start();
    job.start();
    await vi.advanceTimersByTimeAsync(BRIEF_START_DELAY_MS);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]![0]).toMatchObject({ ownerId: "owner_a", now: new Date(NOW.getTime() + BRIEF_START_DELAY_MS) });
    await vi.advanceTimersByTimeAsync(3_600_000 - BRIEF_START_DELAY_MS);
    expect(runner).toHaveBeenCalledTimes(2);
    await job.stop();
    await vi.advanceTimersByTimeAsync(2 * 86_400_000);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("logs failed passes and aborts a running pass on stop", async () => {
    vi.useFakeTimers({ now: NOW });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let signal: AbortSignal | undefined;
    const runner = vi.fn<BrainBriefRunner>()
      .mockResolvedValueOnce({ ...summary, failed: 2 })
      .mockRejectedValueOnce(new RangeError("boom"))
      .mockImplementationOnce(async (input) => {
        signal = input.signal;
        await new Promise((resolve) => input.signal.addEventListener("abort", resolve));
        return summary;
      })
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockRejectedValueOnce("text");
    const job = createBrainBriefScheduler({ runner, ownerId: "owner_a", scopes, now: () => new Date(Date.now()) });
    job.start();
    await vi.advanceTimersByTimeAsync(BRIEF_START_DELAY_MS);
    expect(error).toHaveBeenCalledWith("[brain-brief] Pass finished with 2 failed scopes");
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(error).toHaveBeenCalledWith("[brain-brief] Pass failed:", "RangeError");
    await vi.advanceTimersByTimeAsync(86_400_000);
    await job.stop();
    expect(signal?.aborted).toBe(true);
    job.start();
    await vi.advanceTimersByTimeAsync(BRIEF_START_DELAY_MS);
    const stopping = job.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    await stopping;
    job.start();
    await vi.advanceTimersByTimeAsync(BRIEF_START_DELAY_MS);
    expect(runner).toHaveBeenCalledTimes(4);
    const again = job.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    await again;
    const fresh = createBrainBriefScheduler({ runner, ownerId: "owner_a", scopes });
    fresh.start();
    await vi.advanceTimersByTimeAsync(BRIEF_START_DELAY_MS);
    await fresh.stop();
    expect(error).toHaveBeenCalledWith("[brain-brief] Pass failed:", "UnknownError");
  });
});

describe("scope lister", () => {
  it("lists distinct scopes with a live source, bounded", async () => {
    const harness = await createBrainHarness();
    try {
      await bootstrapBrainBriefDatabase(harness.db);
      const lister = createBrainBriefScopeLister(harness.db);
      const repository = harness.repository;
      for (const scopeId of ["s2", "s1", "s1"]) {
        await repository.createSource({ ownerId: "o", scopeId }, { kind: "git", externalRef: `r${Math.random()}`, label: "L" });
      }
      const { source } = await repository.createSource({ ownerId: "o", scopeId: "s3" }, { kind: "git", externalRef: "x", label: "L" });
      await repository.deleteSource({ ownerId: "o", scopeId: "s3" }, { sourceId: source.sourceId, expectedRevision: 1 });
      expect(await lister.listActiveScopes("o", 10)).toEqual([{ ownerId: "o", scopeId: "s1" }, { ownerId: "o", scopeId: "s2" }]);
      expect(await lister.listActiveScopes("o", 0)).toHaveLength(1);
      expect(await lister.listActiveScopes("other", 500)).toEqual([]);
    } finally {
      await harness.destroy();
    }
  });
});
