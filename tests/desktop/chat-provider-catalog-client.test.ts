import { describe, expect, it, vi } from "vitest";
import { CanonicalProviderCatalogSchema } from "@matrix-os/contracts";
import type { ApiClient } from "../../desktop/src/renderer/src/lib/api";
import { fetchCanonicalProviderCatalog } from "../../desktop/src/renderer/src/features/chat/chat-provider-catalog";

function apiReturning(value: unknown): ApiClient {
  return {
    baseUrl: "https://platform.test",
    get: vi.fn(async () => value),
  } as unknown as ApiClient;
}

describe("Desktop canonical Provider catalog client", () => {
  it("loads and validates the bounded gateway catalog", async () => {
    const catalog = CanonicalProviderCatalogSchema.parse({
      revision: "catalog_empty",
      drivers: [],
      instances: [],
    });
    const api = apiReturning(catalog);

    await expect(fetchCanonicalProviderCatalog(api)).resolves.toEqual(catalog);
    expect(api.get).toHaveBeenCalledWith("/api/chat-providers");
  });

  it("can force a live provider refresh after terminal configuration", async () => {
    const catalog = CanonicalProviderCatalogSchema.parse({
      revision: "catalog_refreshed",
      drivers: [],
      instances: [],
    });
    const api = apiReturning(catalog);

    await fetchCanonicalProviderCatalog(api, true);

    expect(api.get).toHaveBeenCalledWith("/api/chat-providers?refresh=true");
  });

  it("rejects malformed gateway data instead of projecting it into controls", async () => {
    const api = apiReturning({ revision: "catalog_bad", drivers: [], instances: "secret" });
    await expect(fetchCanonicalProviderCatalog(api)).rejects.toThrow();
  });
});
