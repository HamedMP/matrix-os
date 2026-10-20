import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const clerk = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => ({ auth: clerk.auth }));
import { GET, POST, DELETE } from "../../shell/src/app/workspace/api/[...path]/route";
const context = { params: Promise.resolve({ path: ["api", "files"] }) };
beforeEach(() => {
  vi.stubEnv("MATRIX_SHARED_WORKSPACE_SPIKE", "1");
  vi.stubEnv("MATRIX_SHARED_WORKSPACE_ORIGIN", "https://preview.workers.dev");
  clerk.auth.mockResolvedValue({ userId: "owner", getToken: async () => "verified-jwt" });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("shared data forwarding boundary", () => {
  it("forwards only verified auth to the configured origin and does not wake compute for reads", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ files: [] }));
    vi.stubGlobal("fetch", fetcher);
    const response = await GET(new Request("https://shell.test/workspace/api/api/files?path=notes", { headers: { "x-owner-id": "attacker", "x-platform-user-id": "attacker", cookie: "secret=1", authorization: "Bearer attacker" } }), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url.toString()).toBe("https://preview.workers.dev/api/files?path=notes");
    expect([...init.headers.entries()]).toEqual([["authorization", "Bearer verified-jwt"]]);
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it("hydrates shipped wallpaper when owner storage has no override", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "Not found" }, { status: 404 })));
    const response = await GET(new Request("https://shell.test/workspace/api/api/files/blob?path=system%2Fwallpapers%2Fmatrix-dusk.webp"), { params: Promise.resolve({ path: ["api", "files", "blob"] }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(100);
  });
  it("preserves custom owner asset bytes over bundled defaults", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("custom-owner-data", { headers: { "content-type": "image/webp" } })));
    const response = await GET(new Request("https://shell.test/workspace/api/api/files/blob?path=system%2Fwallpapers%2Fmatrix-dusk.webp"), { params: Promise.resolve({ path: ["api", "files", "blob"] }) });
    expect(await response.text()).toBe("custom-owner-data");
  });
  it("preserves bodyless successful mutation responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    const response = await DELETE(new Request("https://shell.test/workspace/api/api/files", { method: "DELETE", headers: { origin: "https://shell.test" } }), context);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });
  it("rejects unauthenticated requests before accessing the Worker", async () => {
    clerk.auth.mockResolvedValue({ userId: null });
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect((await GET(new Request("https://shell.test/workspace/api/api/files"), context)).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("accepts only a trusted configured browser origin despite an internal rewrite host", async () => {
    vi.stubEnv("MATRIX_SHARED_WORKSPACE_SHELL_ORIGIN", "http://127.0.0.1:3217");
    const fetcher = vi.fn().mockResolvedValue(Response.json({ queued: true }));
    vi.stubGlobal("fetch", fetcher);
    const request = (origin: string) => new Request("http://localhost:3217/workspace/api/api/workspace/actions", { method: "POST", headers: { origin, "x-forwarded-host": "attacker.test" }, body: JSON.stringify({ type: "wake" }) });
    expect((await POST(request("http://127.0.0.1:3217"), context)).status).toBe(200);
    expect((await POST(request("https://attacker.test"), context)).status).toBe(403);
    expect((await POST(request("http://localhost:3217"), context)).status).toBe(403);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([POST, DELETE])("rejects foreign Origin on mutations", async (handler) => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect((await handler(new Request("https://shell.test/workspace/api/api/files", { method: handler === POST ? "POST" : "DELETE", headers: { origin: "https://attacker.test" } }), context)).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("caps request bodies before forwarding", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const response = await POST(new Request("https://shell.test/workspace/api/api/files", { method: "POST", headers: { origin: "https://shell.test" }, body: "x".repeat(1024 * 1024 + 1) }), context);
    expect(response.status).toBe(413);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("returns generic bounded errors and never falls back to a personal gateway", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("provider database /private/key"));
    vi.stubGlobal("fetch", fetcher);
    const response = await GET(new Request("https://shell.test/workspace/api/api/files"), context);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/provider|database|private/);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("does not open a personal WebSocket when the shared bridge is unavailable", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect((await GET(new Request("https://shell.test/workspace/api/ws"), { params: Promise.resolve({ path: ["ws"] }) })).status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
