import { expect, it } from "vitest";
import { botModelRoutingLabel, managedPiBotModelChoices } from "@matrix-os/contracts";
import { createCanonicalProviderCatalogFixture } from "../fixtures/canonical-chat.js";

it("shares exact model choices and unavailable saved-route copy across shells", () => {
  const catalog = createCanonicalProviderCatalogFixture();
  const base = catalog.instances[0]!;
  const selection = { instanceId: "matrix_pi_default", model: "cloudflare:@cf/zai-org/glm-5.3-flash" };
  catalog.instances = [{ ...base, id: selection.instanceId, driverKind: "matrix_pi", connectionLabel: "Matrix AI",
    models: [{ ...base.models[0]!, id: selection.model, displayName: "GLM 5.3 Flash" }] }];
  expect(managedPiBotModelChoices(catalog)).toEqual([{ selection, label: "GLM 5.3 Flash · Matrix AI · Pi" }]);
  expect(botModelRoutingLabel(selection, catalog)).toBe("Matrix AI · GLM 5.3 Flash");
  catalog.instances[0]!.availability = "unavailable";
  expect(managedPiBotModelChoices(catalog)).toEqual([]);
  expect(botModelRoutingLabel(selection, catalog)).toBe("Matrix AI · GLM 5.3 Flash · unavailable");
  expect(botModelRoutingLabel({ instanceId: "matrix_bot_default", model: "auto" }, catalog)).toBe("Model routing: automatic");
  expect(botModelRoutingLabel(undefined, catalog)).toBe("Checking bot model…");
});
