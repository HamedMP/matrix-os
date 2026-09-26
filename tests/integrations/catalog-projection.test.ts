import { describe, expect, it } from "vitest";
import { projectIntegrationCatalog } from "../../packages/gateway/src/integrations/catalog-projection.js";
import { listServices } from "../../packages/gateway/src/integrations/registry.js";

describe("scoped integration catalog projection", () => {
  it("keeps only reviewed read actions and excludes presets without exact account selection", async () => {
    const full = listServices();
    const projected = await projectIntegrationCatalog({ services: full, readOnly: true,
      uid: "owner", capabilityIdentityFailed: false, authoritative: true,
      logoUrl: (service) => service.logoUrl });
    const gmail = projected.find((service) => service.id === "gmail")!;
    expect(gmail.actions.list_labels).toBeDefined();
    expect(gmail.actions.send_email).toBeUndefined();
    expect(projected.find((service) => service.id === "granola")).toBeUndefined();
    expect(full.find((service) => service.id === "gmail")?.actions.send_email).toBeDefined();
  });
});
