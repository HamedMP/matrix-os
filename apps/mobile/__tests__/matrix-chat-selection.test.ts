import { defaultCatalogSelection, defaultTurnModes } from "@/lib/canonical-chat-selection";
import { createCanonicalProviderCatalogFixture } from "../../../tests/contracts/fixtures/canonical-chat";

import {
  GPT,
  PLAN,
  apiKeyInstance,
  catalogOf,
  codexInstance,
  planAgentInstance,
  planBinding,
  planInstance,
} from "./model-test-catalog";
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

it("does not default or admit a legacy Matrix SDK binding from an older catalog", () => {
  const catalog = createCanonicalProviderCatalogFixture();
  const base = catalog.instances[0]!;
  const selection = { instanceId: "kernel_matrix_included", model: base.models[0]!.id };
  catalog.instances = [{ ...base, id: selection.instanceId, driverKind: "kernel", defaultSelection: selection }];
  expect(defaultCatalogSelection(catalog)).toBeNull();
  expect(defaultTurnModes(catalog, selection)).toBeNull();
});

it("never starts a chat on a route that only agents run on, nor by default on an account of the person's own", () => {
  const ownAccounts = [planAgentInstance(), planInstance(), apiKeyInstance()];

  expect(defaultCatalogSelection(catalogOf(...ownAccounts))).toBeNull();
  expect(defaultCatalogSelection(catalogOf(...ownAccounts, codexInstance()))).toEqual(GPT);
});

it("sends on the person's own subscription only while the selection is bound to the account the catalog lists", () => {
  const catalog = catalogOf(planInstance());

  expect(defaultTurnModes(catalog, { ...PLAN, options: planBinding() }))
    .toEqual({ interactionMode: "default", permissionMode: "supervised" });
  expect(defaultTurnModes(catalog, { ...PLAN, options: planBinding("acct_other") })).toBeNull();
  expect(defaultTurnModes(catalog, PLAN)).toBeNull();
});
