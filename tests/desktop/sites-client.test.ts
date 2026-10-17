import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../desktop/src/renderer/src/lib/api";
import { AppError } from "../../desktop/src/shared/app-error";
import { createDesktopSiteClient } from "../../desktop/src/renderer/src/features/app-sites/site-client";
import { SiteClientError, siteActionError, type SiteClient } from "../../shell/src/lib/site-client";

const metadata = { title: "Launch", description: "", slug: null, baseRevision: 1 };
const actions: { name: string; call: (client: SiteClient, signal: AbortSignal) => Promise<unknown> }[] = [
  { name: "load", call: (client, signal) => client.get("launch", signal) },
  { name: "review configuration", call: (client, signal) => client.getConfig("launch", signal) },
  { name: "publish", call: (client, signal) => client.deploy("launch", { ...metadata, reviewedConfig: { data: {}, forms: [] } }, signal) },
  { name: "save metadata", call: (client, signal) => client.update("launch", metadata, signal) },
  { name: "unpublish", call: (client, signal) => client.unpublish("launch", 1, signal) },
  { name: "restore", call: (client, signal) => client.rollback("launch", { versionId: "11111111-1111-4111-8111-111111111111", baseRevision: 1 }, signal) },
  { name: "read submissions", call: (client, signal) => client.submissions("launch", null, signal) },
  { name: "export submissions", call: (client, signal) => client.exportSubmissions("launch", null, signal) },
  { name: "delete submission", call: (client, signal) => client.deleteSubmission("launch", "11111111-1111-4111-8111-111111111111", signal) },
];
describe("Electron site transport error parity", () => {
  it("logs only fixed categories when normalizing known and unknown transport failures", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bound = { patch: vi.fn().mockRejectedValueOnce(new AppError("server", { httpStatus: 409 })).mockRejectedValueOnce({ private: "visitor fields" }) };
    const api = { forRuntime: () => bound } as unknown as ReturnType<typeof createApiClient>;
    const client = createDesktopSiteClient(api, "primary");
    await expect(client.update("launch", metadata, new AbortController().signal)).rejects.toBeInstanceOf(SiteClientError);
    await expect(client.update("launch", metadata, new AbortController().signal)).rejects.toEqual({ private: "visitor fields" });
    expect(warning.mock.calls).toEqual([["[desktop-sites] request failed", "Error"], ["[desktop-sites] request failed", "UnknownError"]]);
    warning.mockRestore();
  });
  it.each(actions)("preserves conflicts and request limits for $name", async ({ call }) => {
    for (const status of [409, 429]) {
      const fetchFn = vi.fn(async () => new Response(JSON.stringify({ error: "postgres://private/credential" }), { status }));
      const api = createApiClient({ baseUrl: "https://app.matrix-os.com", getRuntimeSlot: () => "primary", fetchFn });
      const client = createDesktopSiteClient(api, "preview");
      const error = await call(client, new AbortController().signal).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(SiteClientError);
      expect(error).toHaveProperty("status", status);
      expect(siteActionError(error)).toBe(status === 409 ? "The URL is unavailable or this publication changed. Refresh and try again." : "Too many requests. Please try again shortly.");
      expect(fetchFn.mock.calls[0]?.[0]).toContain("runtime=preview");
      expect(siteActionError(error)).not.toContain("private");
    }
  });
  it("preserves missing-publication semantics", async () => {
    const api = createApiClient({ baseUrl: "https://app.matrix-os.com", getRuntimeSlot: () => "primary", fetchFn: async () => new Response(null, { status: 404 }) });
    await expect(createDesktopSiteClient(api, "primary").get("launch", new AbortController().signal)).resolves.toBeNull();
  });
  it.each([400, 409, 429, 599])("maps canonical HTTP status %i without changing the shared AppError contract", async (httpStatus) => {
    const failure = new AppError("server", { httpStatus });
    const bound = { patch: vi.fn().mockRejectedValue(failure) };
    const api = { forRuntime: () => bound } as unknown as ReturnType<typeof createApiClient>;
    const client = createDesktopSiteClient(api, "primary");
    const error: unknown = await client.update("launch", metadata, new AbortController().signal).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(SiteClientError);
    expect(error).toHaveProperty("status", httpStatus);
    expect(failure).not.toHaveProperty("status");
  });
  it.each([undefined, 0, 200, 599.5, 600, NaN])("preserves errors without safe canonical HTTP status %s", async (httpStatus) => {
    const failure = new AppError("server", httpStatus === undefined ? undefined : { httpStatus });
    const bound = { patch: vi.fn().mockRejectedValue(failure) };
    const api = { forRuntime: () => bound } as unknown as ReturnType<typeof createApiClient>;
    const client = createDesktopSiteClient(api, "primary");
    await expect(client.update("launch", metadata, new AbortController().signal)).rejects.toBe(failure);
  });
});
