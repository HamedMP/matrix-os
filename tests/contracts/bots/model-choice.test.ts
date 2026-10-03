import { expect, it } from "vitest";
import { botModelRoutingLabel, canonicalProviderFundingState, isManagedPiBotRoute, managedPiBotModelChoices } from "@matrix-os/contracts";
import { createCanonicalProviderCatalogFixture } from "../fixtures/canonical-chat.js";

it("shares exact model choices and unavailable saved-route copy across shells", () => {
  const catalog = createCanonicalProviderCatalogFixture();
  const base = catalog.instances[0]!;
  const selection = { instanceId: "matrix_pi_default", model: "cloudflare:@cf/zai-org/glm-5.3-flash" };
  catalog.instances = [{ ...base, id: selection.instanceId, driverKind: "matrix_pi", connectionLabel: "Matrix AI",
    models: [{ ...base.models[0]!, id: selection.model, displayName: "GLM 5.3 Flash" }] }];
  expect(managedPiBotModelChoices(catalog)).toEqual([{ selection, label: "GLM 5.3 Flash · Matrix AI" }]);
  expect(botModelRoutingLabel(selection, catalog)).toBe("Matrix AI · GLM 5.3 Flash");
  catalog.instances[0]!.availability = "unavailable";
  expect(managedPiBotModelChoices(catalog)).toEqual([]);
  expect(botModelRoutingLabel(selection, catalog)).toBe("Matrix AI · GLM 5.3 Flash · unavailable");
  expect(botModelRoutingLabel({ instanceId: "matrix_bot_default", model: "auto" }, catalog)).toBe("Model routing: automatic");
  expect(botModelRoutingLabel(undefined, catalog)).toBe("Checking bot model…");
});

it("identifies the exact managed Pi route without optional presentation labels", () => {
  const route = { instanceId: "matrix_pi_default", driverKind: "matrix_pi" };
  expect(isManagedPiBotRoute(route)).toBe(true);
  expect(isManagedPiBotRoute({ ...route, connectionLabel: "Renamed connection" })).toBe(true);
  expect(isManagedPiBotRoute({ ...route, instanceId: "pi_default", connectionLabel: "Matrix AI" })).toBe(false);
  expect(isManagedPiBotRoute({ ...route, driverKind: "pi", connectionLabel: "Matrix AI" })).toBe(false);
  expect(isManagedPiBotRoute({ ...route, driverKind: "kernel", connectionLabel: "Matrix AI" })).toBe(false);
});

it("projects only currently available advertised models when labels are not negotiated", () => {
  const catalog = createCanonicalProviderCatalogFixture();
  const base = catalog.instances[0]!;
  catalog.instances = [{ ...base, id: "matrix_pi_default", driverKind: "matrix_pi",
    models: [{ ...base.models[0]!, id: "claude-sonnet-5", displayName: "Claude Sonnet 5" },
      { ...base.models[0]!, id: "unavailable-model", availability: "unavailable" }] }];
  expect(managedPiBotModelChoices(catalog)).toEqual([{ selection: { instanceId: "matrix_pi_default", model: "claude-sonnet-5" },
    label: "Claude Sonnet 5 · Matrix AI" }]);
  catalog.instances[0]!.availability = "auth_required";
  expect(managedPiBotModelChoices(catalog)).toEqual([]);
});

it("explains reserved credit for saved Bot choices without creating an executable choice", () => {
  const catalog = createCanonicalProviderCatalogFixture();
  const base = catalog.instances[0]!;
  const selection = { instanceId: "matrix_pi_default", model: "claude-sonnet-5" };
  catalog.instances = [{ ...base, id: selection.instanceId, driverKind: "matrix_pi", availability: "unavailable", connectionState: "credit_reserved",
    defaultSelection: undefined, models: [{ ...base.models[0]!, id: selection.model, displayName: "Claude Sonnet 5", availability: "unavailable" }] }];
  expect(botModelRoutingLabel(selection, catalog)).toBe("Matrix AI · Claude Sonnet 5 · credit reserved");
  expect(managedPiBotModelChoices(catalog)).toEqual([]);
  for (const reason of ["disabled_in_settings", "settings_unavailable"] as const) {
    catalog.instances[0]!.unavailabilityReason = reason;
    expect(canonicalProviderFundingState(catalog.instances[0]!)).toBeUndefined();
    expect(botModelRoutingLabel(selection, catalog)).toBe("Matrix AI · Claude Sonnet 5 · unavailable");
  }
  expect(botModelRoutingLabel(selection)).toBe("Matrix AI · claude-sonnet-5");
  delete catalog.instances[0]!.unavailabilityReason;
  expect(botModelRoutingLabel({ ...selection, model: "revoked-model" }, catalog)).toBe("Matrix AI · revoked-model · unavailable");
  catalog.instances = [];
  expect(botModelRoutingLabel(selection, catalog)).toBe("Matrix AI · claude-sonnet-5 · unavailable");
});
