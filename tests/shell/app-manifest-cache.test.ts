import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { fetchAppManifest, invalidateManifest, clearManifestCache } from "../../shell/src/lib/app-manifest-cache.js";

const mockEnvelope = {
  manifest: { slug: "notes", runtime: "vite", name: "Notes", version: "1.0.0" },
  runtimeState: { status: "ready" },
  distributionStatus: "installable" as const,
};

const mockNonReadyEnvelope = {
  manifest: { slug: "building", runtime: "vite", name: "Building", version: "1.0.0" },
  runtimeState: { status: "needs_build" },
  distributionStatus: "installable" as const,
};

beforeEach(() => {
  clearManifestCache();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("app-manifest-cache", () => {
  it("fetches and caches manifest envelope", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(mockEnvelope), { status: 200 }),
    );

    const result = await fetchAppManifest("notes", "http://localhost:4000");
    expect(result.manifest.slug).toBe("notes");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Second call should use cache
    const result2 = await fetchAppManifest("notes", "http://localhost:4000");
    expect(result2.manifest.slug).toBe("notes");
    expect(fetchSpy).toHaveBeenCalledTimes(1); // Not called again
  });

  it("invalidateManifest forces refetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify(mockEnvelope), { status: 200 }),
    );

    await fetchAppManifest("notes", "http://localhost:4000");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    invalidateManifest("notes");

    await fetchAppManifest("notes", "http://localhost:4000");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("uses short TTL (2s) for non-ready envelopes", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify(mockNonReadyEnvelope), { status: 200 }),
    );

    await fetchAppManifest("building", "http://localhost:4000");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Advance past non-ready TTL (2s)
    vi.advanceTimersByTime(2100);

    await fetchAppManifest("building", "http://localhost:4000");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("uses 60s TTL for ready envelopes", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify(mockEnvelope), { status: 200 }),
    );

    await fetchAppManifest("notes", "http://localhost:4000");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Advance 30s -- still cached
    vi.advanceTimersByTime(30_000);
    await fetchAppManifest("notes", "http://localhost:4000");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Advance past 60s -- refetch
    vi.advanceTimersByTime(31_000);
    await fetchAppManifest("notes", "http://localhost:4000");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("evicts LRU when cache exceeds 32 entries", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const slug = String(url).split("/api/apps/")[1]?.split("/")[0] ?? "unknown";
      return new Response(
        JSON.stringify({
          manifest: { slug, runtime: "static", name: slug, version: "1.0.0" },
          runtimeState: { status: "ready" },
          distributionStatus: "installable",
        }),
        { status: 200 },
      );
    });

    // Fill cache with 32 entries
    for (let i = 0; i < 32; i++) {
      await fetchAppManifest(`app${i}`, "http://localhost:4000");
    }
    expect(fetchSpy).toHaveBeenCalledTimes(32);

    // Add one more -- should evict oldest
    await fetchAppManifest("app32", "http://localhost:4000");
    expect(fetchSpy).toHaveBeenCalledTimes(33);

    // app0 should have been evicted and need refetch
    await fetchAppManifest("app0", "http://localhost:4000");
    expect(fetchSpy).toHaveBeenCalledTimes(34);
  });

  it("throws on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
    );

    await expect(fetchAppManifest("missing", "http://localhost:4000")).rejects.toThrow(
      /Failed to fetch manifest/,
    );
  });
});
