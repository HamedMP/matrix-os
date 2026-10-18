import { describe, expect, it, vi } from "vitest";
import { createStoreClient, storeErrorMessage, safeLaunchPath } from "../../home/apps/app-gallery/src/store-model";
import { listing, summary } from "./app-store-fixtures";
describe("store bridge contracts", () => {
  it("validates catalog data and encodes bounded search", async () => {
    const gatewayFetch = vi.fn().mockResolvedValue({ listings: [summary()] });
    const result = await createStoreClient({ gatewayFetch }).catalog({ q: "notes & mail", category: "productivity", sort: "new" });
    expect(result.listings[0].slug).toBe(listing.slug);
    expect(gatewayFetch.mock.calls[0][0]).toContain("q=notes+%26+mail");
  });
  it("rejects malformed server responses and never echoes provider messages", async () => {
    const client = createStoreClient({ gatewayFetch: vi.fn().mockResolvedValue({ listings: [{ name: "/private/token" }] }) });
    await expect(client.catalog({})).rejects.toThrow();
    expect(storeErrorMessage(new Error("Postgres /private/token"))).toBe("This action could not finish. Try again.");
    expect(storeErrorMessage({ error: "conflict" })).toMatch(/changed/);
  });
  it("limits launch paths to owner app folders", () => {
    expect(safeLaunchPath("apps/sample-notes")).toBe(true);
    for (const path of ["/etc/passwd", "apps/../system", "https://evil.test", "apps/a\\b"]) expect(safeLaunchPath(path)).toBe(false);
  });
  it("requires capabilities consent and exact installation job shape", async () => {
    const gatewayFetch = vi.fn().mockResolvedValue({ id: listing.id, status: "building" });
    const client = createStoreClient({ gatewayFetch });
    expect((await client.install(listing.slug, listing.currentVersion.id, listing.capabilitiesDigest)).status).toBe("building");
    expect(JSON.parse(gatewayFetch.mock.calls[0][1].body).consent.capabilitiesDigest).toBe(listing.capabilitiesDigest);
    gatewayFetch.mockResolvedValue({ id: listing.id, status: "building", error: "raw path" });
    await expect(client.installJob(listing.id)).rejects.toThrow();
  });
});
