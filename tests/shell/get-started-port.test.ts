import { afterEach, describe, expect, it, vi } from "vitest";
import { createShellGetStartedPort } from "../../shell/src/components/get-started/shell-get-started-port.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shell Get started port", () => {
  it("loads the state from the gateway without caching, bounded by a timeout", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "pending" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const port = createShellGetStartedPort("https://gw.example");
    await expect(port.load(new AbortController().signal)).resolves.toEqual({ status: "pending" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://gw.example/api/settings/get-started");
    expect(init.cache).toBe("no-store");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("saves updates as JSON with PUT", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "skipped", skippedAt: "2026-10-25T10:12:00.000Z" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await createShellGetStartedPort("https://gw.example").save({ type: "skip" });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init).toMatchObject({ method: "PUT", body: JSON.stringify({ type: "skip" }) });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects non-2xx responses without exposing their body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("pg: connection refused at /home/matrix", { status: 500 })));
    const error = await createShellGetStartedPort("https://gw.example").load(new AbortController().signal).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).toBe("GetStartedRequestFailed:500");
  });
});
