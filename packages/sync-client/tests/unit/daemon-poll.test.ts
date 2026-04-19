import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { waitForManifest } from "../../src/daemon/index.js";

const gatewayUrl = "http://localhost:4000";
const token = "test-token";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("waitForManifest", () => {
  it("returns immediately when the manifest is populated on first call", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        manifestVersion: 1,
        manifest: {
          files: { "a.md": { hash: "h", size: 1, mtime: 0, peerId: "p", version: 1 } },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      waitForManifest({ gatewayUrl, token, logger: silentLogger }),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("polls until the manifest is populated", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ manifestVersion: 0, manifest: { files: {} } }))
      .mockResolvedValueOnce(jsonResponse({ manifestVersion: 0, manifest: { files: {} } }))
      .mockResolvedValueOnce(
        jsonResponse({
          manifestVersion: 2,
          manifest: {
            files: { "a.md": { hash: "h", size: 1, mtime: 0, peerId: "p", version: 1 } },
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const promise = waitForManifest({ gatewayUrl, token, logger: silentLogger });

    // Drain three polls separated by ~2s waits. Each iteration: await pending
    // microtasks so the fetch promise settles, then advance the 2s sleep timer.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2_000);
    }

    await expect(promise).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("throws after 120s of empty manifests", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ manifestVersion: 0, manifest: { files: {} } }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = waitForManifest({ gatewayUrl, token, logger: silentLogger });
    // Prevent unhandled rejection warnings while timers advance.
    const caught = promise.catch((err) => err);

    // Advance well past the 120s timeout, running pending microtasks in
    // between so each settled fetch queues the next sleep.
    for (let i = 0; i < 80; i++) {
      await vi.advanceTimersByTimeAsync(2_000);
    }

    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Timed out waiting for your Matrix instance/);
  });

  it("throws immediately on 401", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response("unauthorized", { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      waitForManifest({ gatewayUrl, token, logger: silentLogger }),
    ).rejects.toThrow(/Auth token rejected/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws immediately on 403", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response("forbidden", { status: 403 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      waitForManifest({ gatewayUrl, token, logger: silentLogger }),
    ).rejects.toThrow(/Auth token rejected/);
  });

  it("retries on 5xx and continues when the manifest becomes available", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 503 }))
      .mockResolvedValueOnce(
        jsonResponse({
          manifestVersion: 1,
          manifest: {
            files: { "a.md": { hash: "h", size: 1, mtime: 0, peerId: "p", version: 1 } },
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const promise = waitForManifest({ gatewayUrl, token, logger: silentLogger });

    for (let i = 0; i < 2; i++) {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2_000);
    }

    await expect(promise).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries on transient network errors", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(
        jsonResponse({
          manifestVersion: 1,
          manifest: {
            files: { "a.md": { hash: "h", size: 1, mtime: 0, peerId: "p", version: 1 } },
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const promise = waitForManifest({ gatewayUrl, token, logger: silentLogger });

    for (let i = 0; i < 2; i++) {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2_000);
    }

    await expect(promise).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
