import { describe, expect, it, vi } from "vitest";
import { createSiteClient, SiteClientError, siteActionError, type SiteTransport } from "../../shell/src/lib/site-client";

function transport(): SiteTransport {
  return { get: vi.fn(async () => null) as SiteTransport["get"], post: vi.fn(async () => null) as SiteTransport["post"], patch: vi.fn(async () => null) as SiteTransport["patch"], delete: vi.fn(async () => null) as SiteTransport["delete"], getBlob: vi.fn(async () => new Blob()), getText: vi.fn(async () => "") };
}
describe("app site client", () => {
  it("loads only validated public capabilities from the owner app manifest", async () => {
    const api = transport();
    api.get = vi.fn(async () => ({ manifest: { publishing: { data: { event: "Launch" }, forms: [] } } })) as SiteTransport["get"];
    const client = createSiteClient(api);
    expect(await client.getConfig("launch", new AbortController().signal)).toEqual({ data: { event: "Launch" }, forms: [] });
    expect(api.get).toHaveBeenCalledWith("/api/apps/launch/manifest", expect.any(Object));
  });
  it("encodes app paths and bounds deployment wait; sanitizes unknown errors", async () => {
    const api = transport(); const client = createSiteClient(api); const signal = new AbortController().signal;
    await expect(client.deploy("launch", { title: "Launch", description: "", slug: null, reviewedConfig: { data: { event: "Launch" }, forms: [] } }, signal)).rejects.toThrow();
    expect(api.post).toHaveBeenCalledWith("/api/apps/launch/site", expect.objectContaining({ reviewedConfig: { data: { event: "Launch" }, forms: [] } }), { signal, timeoutMs: 150_000 });
    expect(siteActionError(new Error("/private/database/password"))).toBe("Could not complete this action. Please try again.");
    expect(siteActionError(new SiteClientError(409))).toContain("publication changed");
  });
  it("fails closed on malformed responses and unknown public manifest declarations", async () => {
    const api = transport();
    api.get = vi.fn(async () => ({ manifest: { publishing: { data: {}, forms: [], privateSql: "query" } } })) as SiteTransport["get"];
    await expect(createSiteClient(api).getConfig("launch", new AbortController().signal)).rejects.toThrow();
    api.get = vi.fn(async () => ({ title: "Malformed publication" })) as SiteTransport["get"];
    await expect(createSiteClient(api).get("launch", new AbortController().signal)).rejects.toThrow();
  });

  it("rejects deployment without a reviewed declaration before sending a request", async () => {
    const api = transport();
    const client = createSiteClient(api);
    await expect(client.deploy("launch", { title: "Launch", description: "", slug: null } as Parameters<typeof client.deploy>[1], new AbortController().signal)).rejects.toThrow();
    expect(api.post).not.toHaveBeenCalled();
  });

});
