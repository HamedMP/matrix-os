import { expect, it } from "vitest";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat.js";
import { deriveCanonicalProviderChoices } from "../../packages/ui/src/canonical-provider-choice.js";
import { deriveChatPickerEntries, chatPickerEntryForSelection } from "../../packages/ui/src/chat-picker-entries.js";
import { createCanonicalComposerSelection } from "../../desktop/src/renderer/src/features/chat/canonical-composer-state.js";

it("keeps a healthy Matrix Pi generation model selectable when its peer is unavailable", () => {
  const catalog = createCanonicalProviderCatalogFixture();
  const base = catalog.instances[0]!;
  const selected = { instanceId: "matrix_pi_default", model: "cloudflare:@cf/zai-org/glm-5.3-flash" };
  catalog.instances.push({ ...base, id: selected.instanceId, driverKind: "matrix_pi", connectionLabel: "Matrix AI", displayName: "Pi",
    defaultSelection: selected, models: [{ ...base.models[0]!, id: selected.model, displayName: "GLM 5.3 Flash" },
      { ...base.models[0]!, id: "anthropic:claude-sonnet-5", availability: "unavailable" }] });
  const choices = deriveCanonicalProviderChoices(catalog).filter(choice => choice.instanceId === selected.instanceId);
  expect(choices).toHaveLength(1);
  expect(choices[0]).toMatchObject({ instanceId: selected.instanceId, modelId: selected.model, driverKind: "matrix_pi", connectionLabel: "Matrix AI" });
  expect(createCanonicalComposerSelection(catalog)).toMatchObject(selected);
  expect(chatPickerEntryForSelection(deriveChatPickerEntries(catalog), selected.instanceId)).toBe("matrix-ai");
});

it("uses managed Pi for a new Sonnet Chat while retaining a historical kernel binding", () => {
  const catalog = createCanonicalProviderCatalogFixture();
  const base = catalog.instances[0]!;
  const legacy = { ...base, id: "kernel_matrix_included", driverKind: "kernel" as const, connectionLabel: "Matrix AI",
    defaultSelection: { instanceId: "kernel_matrix_included", model: base.models[0]!.id } };
  const pi = { ...base, id: "matrix_pi_default", driverKind: "matrix_pi" as const, connectionLabel: "Matrix AI",
    defaultSelection: { instanceId: "matrix_pi_default", model: base.models[0]!.id } };
  catalog.instances = [legacy, pi];
  expect(createCanonicalComposerSelection(catalog)?.instanceId).toBe(pi.id);
  expect(createCanonicalComposerSelection(catalog, legacy.id)?.instanceId).toBe(legacy.id);
});
