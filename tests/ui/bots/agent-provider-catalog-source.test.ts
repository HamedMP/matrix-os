import { expect, it, vi } from "vitest";
import { createAgentProviderCatalogSource } from "../../../packages/ui/src/chat-agents/agent-provider-catalog-source.js";
import { createCanonicalProviderCatalogFixture } from "../../contracts/fixtures/canonical-chat.js";

it("preserves a trusted host catalog while reporting a background refresh failure", () => {
  const catalog = createCanonicalProviderCatalogFixture();
  const refresh = vi.fn();
  const source = createAgentProviderCatalogSource({
    catalog,
    hasTrustedCatalog: true,
    loading: false,
    refreshError: true,
    refresh,
  });

  expect(source.catalog).toBe(catalog);
  expect(source.error).toBe("Models could not be refreshed. Your draft is still here.");
  expect(source.refresh).toBe(refresh);
});

it("fails closed when the host has no trusted catalog", () => {
  const source = createAgentProviderCatalogSource({
    catalog: createCanonicalProviderCatalogFixture(),
    hasTrustedCatalog: false,
    loading: false,
    refreshError: true,
    refresh: vi.fn(),
  });

  expect(source.catalog).toBeNull();
  expect(source.error).toBe("Models could not be refreshed. Your draft is still here.");
});

it("blocks while settings changes suspend catalog trust before refresh completes", () => {
  const source = createAgentProviderCatalogSource({
    catalog: createCanonicalProviderCatalogFixture(),
    hasTrustedCatalog: false,
    loading: false,
    refreshError: false,
    refresh: vi.fn(),
  });

  expect(source.catalog).toBeNull();
  expect(source.loading).toBe(true);
  expect(source.error).toBe("");
});
