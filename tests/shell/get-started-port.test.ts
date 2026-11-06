import { afterEach, describe, expect, it, vi } from "vitest";
import { createShellGetStartedGalleryPort, createShellGetStartedPort } from "../../shell/src/components/get-started/shell-get-started-port.js";

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

  it("asks the gateway for bot name suggestions with POST, bounded by a timeout", async () => {
    const names = { names: [] };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(names), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const request = { goals: ["code" as const], personality: "calm-mentor" as const, exclude: ["Luna"] };
    const signal = new AbortController().signal;
    await expect(createShellGetStartedPort("https://gw.example").suggestBotNames!(request, signal)).resolves.toEqual(names);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://gw.example/api/settings/get-started/bot-names");
    expect(init).toMatchObject({ method: "POST", body: JSON.stringify(request) });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects non-2xx responses without exposing their body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("pg: connection refused at /home/matrix", { status: 500 })));
    const error = await createShellGetStartedPort("https://gw.example").load(new AbortController().signal).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).toBe("GetStartedRequestFailed:500");
  });
});

describe("shell Get started gallery port", () => {
  it("lists App Gallery, installs an app with an empty JSON body, and points at its gallery icon", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ version: 1, apps: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const gallery = createShellGetStartedGalleryPort("https://gw.example");
    await expect(gallery.list(new AbortController().signal)).resolves.toEqual({ version: 1, apps: [] });
    await gallery.install("folio");
    const [listUrl, listInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [installUrl, installInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(listUrl).toBe("https://gw.example/api/app-gallery");
    expect(listInit.signal).toBeInstanceOf(AbortSignal);
    expect(installUrl).toBe("https://gw.example/api/app-gallery/folio/install");
    expect(installInit).toMatchObject({ method: "POST", body: "{}" });
    expect(installInit.signal).toBeInstanceOf(AbortSignal);
    expect(gallery.iconUrl("folio")).toBe("https://gw.example/icons/gallery-folio.png");
  });

  it("refuses app ids the gallery could never have", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(createShellGetStartedGalleryPort("https://gw.example").install("../etc")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
