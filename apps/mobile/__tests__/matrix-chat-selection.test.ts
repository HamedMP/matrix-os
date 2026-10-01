import { defaultCatalogSelection, defaultTurnModes } from "@/lib/canonical-chat-selection";
import { createCanonicalProviderCatalogFixture } from "../../../tests/contracts/fixtures/canonical-chat";
jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

it("uses Matrix Pi for a new Native Chat and refuses a revoked or unavailable saved model", () => {
  const catalog = createCanonicalProviderCatalogFixture();
  const base = catalog.instances[0]!;
  const selected = { instanceId: "matrix_pi_default", model: "cloudflare:@cf/zai-org/glm-5.3-flash" };
  catalog.instances.push({ ...base, id: selected.instanceId, driverKind: "matrix_pi", connectionLabel: "Matrix AI", defaultSelection: selected,
    models: [{ ...base.models[0]!, id: selected.model }] });
  expect(defaultCatalogSelection(catalog)).toEqual(selected);
  expect(defaultTurnModes(catalog, selected)).not.toBeNull();
  catalog.instances[1]!.models[0]!.availability = "unavailable";
  expect(defaultTurnModes(catalog, selected)).toBeNull();
});
