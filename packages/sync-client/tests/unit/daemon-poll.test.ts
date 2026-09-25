import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { waitForHomeMirrorReady } from "../../src/daemon/index.js";

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

describe("waitForHomeMirrorReady", () => {
  it("returns immediately when the home mirror is ready, even with an empty manifest", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        homeMirror: { state: "ready" },
        manifestVersion: 0,
        fileCount: 0,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      waitForHomeMirrorReady({ gatewayUrl, token, logger: silentLogger }),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`${gatewayUrl}/api/sync/status`, expect.any(Object));
  });

  it("polls while the home mirror is starting", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ homeMirror: { state: "starting" } }))
      .mockResolvedValueOnce(jsonResponse({ homeMirror: { state: "starting" } }))
      .mockResolvedValueOnce(jsonResponse({ homeMirror: { state: "ready" } }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = waitForHomeMirrorReady({ gatewayUrl, token, logger: silentLogger });

    // Drain three polls separated by ~2s waits. Each iteration: await pending
    // microtasks so the fetch promise settles, then advance the 2s sleep timer.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2_000);
    }

    await expect(promise).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("throws after 120s while the home mirror remains starting", async () => {
    // Use mockImplementation so each poll gets a fresh Response. `mockResolvedValue`
    // returns the same instance, and Response bodies are single-use — the second
    // res.json() call would throw "body already used" and trick the non-JSON
    // strike counter.
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        jsonResponse({ homeMirror: { state: "starting" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const promise = waitForHomeMirrorReady({ gatewayUrl, token, logger: silentLogger });
    // Prevent unhandled rejection warnings while timers advance.
    const caught = promise.catch((err) => err);

    // Advance well past the 120s timeout, running pending microtasks in
    // between so each settled fetch queues the next sleep.
    for (let i = 0; i < 80; i++) {
      await vi.advanceTimersByTimeAsync(2_000);
    }

    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Timed out waiting for sync readiness/);
  });

  it.each(["failed", "disabled"])("fails immediately when the home mirror is %s", async (state) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({ homeMirror: { state } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      waitForHomeMirrorReady({ gatewayUrl, token, logger: silentLogger }),
    ).rejects.toThrow(state === "failed" ? /failed to start/ : /not enabled/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails clearly when the gateway does not expose home-mirror readiness", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({ manifestVersion: 2, fileCount: 3 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      waitForHomeMirrorReady({ gatewayUrl, token, logger: silentLogger }),
    ).rejects.toThrow(/does not report sync readiness/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails clearly when the readiness response is JSON null", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(null));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      waitForHomeMirrorReady({ gatewayUrl, token, logger: silentLogger }),
    ).rejects.toThrow(/does not report sync readiness/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws immediately on 401", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response("unauthorized", { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      waitForHomeMirrorReady({ gatewayUrl, token, logger: silentLogger }),
    ).rejects.toThrow(/Auth token rejected/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws immediately on 403", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response("forbidden", { status: 403 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      waitForHomeMirrorReady({ gatewayUrl, token, logger: silentLogger }),
    ).rejects.toThrow(/Auth token rejected/);
  });

  it("retries on 5xx and continues when the home mirror becomes ready", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 503 }))
      .mockResolvedValueOnce(
        jsonResponse({ homeMirror: { state: "ready" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const promise = waitForHomeMirrorReady({ gatewayUrl, token, logger: silentLogger });

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
        jsonResponse({ homeMirror: { state: "ready" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const promise = waitForHomeMirrorReady({ gatewayUrl, token, logger: silentLogger });

    for (let i = 0; i < 2; i++) {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2_000);
    }

    await expect(promise).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries once on non-JSON response and recovers on next poll", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("<html>proxy page</html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ homeMirror: { state: "ready" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const promise = waitForHomeMirrorReady({ gatewayUrl, token, logger: silentLogger });

    for (let i = 0; i < 2; i++) {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2_000);
    }

    await expect(promise).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("hard-fails after 3 consecutive non-JSON responses (misconfigured gateway)", async () => {
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response("<html>bad</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const promise = waitForHomeMirrorReady({ gatewayUrl, token, logger: silentLogger });
    const caught = promise.catch((err) => err);

    // 3 polls, each followed by the 2s sleep. Can't just advance 6s in one
    // go -- the fetch promise needs to settle between timer ticks so the
    // next sleep gets queued.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2_000);
    }

    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/non-JSON responses/);
    expect((err as Error).message).toContain(gatewayUrl);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("resets the non-JSON strike counter when a valid JSON response arrives", async () => {
    // Two non-JSON hits, then a valid starting response resets the counter,
    // then two more non-JSON hits — should NOT hard-fail because counter was
    // reset after the valid response.
    const htmlRes = () =>
      new Response("<html>x</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(htmlRes())
      .mockResolvedValueOnce(htmlRes())
      .mockResolvedValueOnce(
        jsonResponse({ homeMirror: { state: "starting" } }),
      )
      .mockResolvedValueOnce(htmlRes())
      .mockResolvedValueOnce(htmlRes())
      .mockResolvedValueOnce(
        jsonResponse({ homeMirror: { state: "ready" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const promise = waitForHomeMirrorReady({ gatewayUrl, token, logger: silentLogger });

    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2_000);
    }

    await expect(promise).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("includes gatewayUrl in the 120s timeout error", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        jsonResponse({ homeMirror: { state: "starting" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const promise = waitForHomeMirrorReady({ gatewayUrl, token, logger: silentLogger });
    const caught = promise.catch((err) => err);

    for (let i = 0; i < 80; i++) {
      await vi.advanceTimersByTimeAsync(2_000);
    }

    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(gatewayUrl);
  });

  it("does not leak raw fetch error messages on network failure", async () => {
    const warnings: string[] = [];
    const logger = {
      info: () => {},
      warn: (msg: string) => warnings.push(msg),
      error: () => {},
    };
    // fetch throws an error whose message mimics a server response leak
    // (what res.json() does on HTML bodies).
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(
        new SyntaxError("Unexpected token '<', \"<html>secret</html>\" is not valid JSON"),
      )
      .mockResolvedValueOnce(
        jsonResponse({ homeMirror: { state: "ready" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const promise = waitForHomeMirrorReady({ gatewayUrl, token, logger });

    for (let i = 0; i < 2; i++) {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2_000);
    }

    await expect(promise).resolves.toBeUndefined();
    // The generic warning must NOT include the raw error text.
    expect(warnings.some((w) => w.includes("<html>secret</html>"))).toBe(false);
    // But SHOULD include the gateway URL for triage.
    expect(warnings.some((w) => w.includes(gatewayUrl))).toBe(true);
  });
});
