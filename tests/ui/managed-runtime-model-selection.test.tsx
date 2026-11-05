// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { CanonicalProviderCatalogSchema, canonicalProviderModelCanBeSelected, managedPiBotModelChoices } from "@matrix-os/contracts";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";
import { deriveCanonicalProviderChoices } from "../../packages/ui/src/canonical-provider-choice";
import { applyCanonicalComposerPreference, canonicalComposerSelectionIsAvailable, createCanonicalComposerSelection } from "../../packages/ui/src/canonical-composer-selection";
import { onboardingActiveAi, onboardingSelection } from "../../packages/ui/src/onboarding-widget/host/catalog";
import { ProviderModelPicker } from "@desktop/renderer/src/features/chat/ProviderModelPicker";

function outageCatalog() {
  const catalog = createCanonicalProviderCatalogFixture();
  const base = catalog.instances[0]!;
  catalog.drivers.push({ kind: "matrix_pi", displayName: "Pi", adapterVersion: "1.0.0", capabilityClass: "system_agent" });
  catalog.instances.push({ ...base, id: "matrix_pi_default", driverKind: "matrix_pi", displayName: "Matrix AI",
    connectionLabel: "Matrix AI", availability: "unavailable", connectionState: "unavailable", unavailabilityReason: "runtime_unavailable",
    defaultSelection: undefined, models: ["claude-sonnet-5", "cloudflare:@cf/zai-org/glm-5.3-flash"].map((id, index) => ({
      ...base.models[0]!, id, displayName: index === 0 ? "Claude Sonnet 5" : "GLM 5.3 Flash", availability: "unavailable" as const,
    })) });
  return CanonicalProviderCatalogSchema.parse(catalog);
}
afterEach(cleanup);

it("lets the owner choose a discovered Matrix model while its runtime is unavailable, without admitting execution", () => {
  const catalog = outageCatalog();
  const managed = catalog.instances[1]!;
  expect(canonicalProviderModelCanBeSelected(managed, managed.models[1]!.id)).toBe(true);
  const intent = createCanonicalComposerSelection(catalog, managed.id)!;
  expect(intent).toMatchObject({ instanceId: managed.id, model: managed.models[0]!.id });
  const restored = applyCanonicalComposerPreference(catalog, intent, { model: managed.models[1]!.id, options: [], permissionMode: "supervised" });
  expect(restored.model).toBe(managed.models[1]!.id);
  expect(canonicalComposerSelectionIsAvailable(catalog, restored)).toBe(false);
  expect(createCanonicalComposerSelection(catalog)?.instanceId).toBe("codex_fixture");
  expect(managedPiBotModelChoices(catalog)).toEqual([]);
  expect(deriveCanonicalProviderChoices(catalog).filter(choice => choice.instanceId === managed.id)).toEqual([]);
  expect(deriveCanonicalProviderChoices(catalog, { allowUnavailableManagedModels: true }).filter(choice => choice.instanceId === managed.id)).toHaveLength(2);
  // Onboarding starts tasks automatically and must retain runnable-only defaults.
  expect(onboardingSelection(catalog, "matrix")).toBeNull();
  expect(onboardingActiveAi(catalog, "matrix")).toBe("codex");
  expect(CanonicalProviderCatalogSchema.safeParse({ ...catalog, instances: [{ ...managed, defaultSelection: { instanceId: managed.id, model: managed.models[0]!.id } }] }).success).toBe(false);
});

it.each(["credit_required", "credit_reserved", "budget_exceeded"] as const)("keeps %s models blocked even with runtime-unavailable observations", connectionState => {
  const instance = { ...outageCatalog().instances[1]!, connectionState };
  expect(canonicalProviderModelCanBeSelected(instance, instance.models[0]!.id)).toBe(false);
});
it.each(["credit_required", "credit_reserved", "budget_exceeded"] as const)("does not treat a contradictory available descriptor as permission past %s", connectionState => {
  const instance = { ...outageCatalog().instances[1]!, availability: "available" as const, unavailabilityReason: undefined, connectionState };
  instance.models = instance.models.map(model => ({ ...model, availability: "available" }));
  expect(canonicalProviderModelCanBeSelected(instance, instance.models[0]!.id)).toBe(false);
});
it.each(["disabled_in_settings", "settings_unavailable", "authentication_required", "runtime_not_runnable"] as const)("keeps %s models blocked", unavailabilityReason => {
  const instance = { ...outageCatalog().instances[1]!, unavailabilityReason };
  expect(canonicalProviderModelCanBeSelected(instance, instance.models[0]!.id)).toBe(false);
});
it("rejects generic unavailable, wrong-driver, absent models and unqualified discovery", () => {
  const instance = outageCatalog().instances[1]!;
  for (const candidate of [{ ...instance, id: "other" }, { ...instance, driverKind: "pi" as const }, { ...instance, unavailabilityReason: undefined }, { ...instance, connectionState: undefined }]) {
    expect(canonicalProviderModelCanBeSelected(candidate, candidate.models[0]!.id)).toBe(false);
  }
  expect(canonicalProviderModelCanBeSelected(instance, "retired-or-not-authorized")).toBe(false);
});
it("selects either outage model in the Electron picker and retains its unavailable execution status", () => {
  const catalog = outageCatalog();
  const changed = vi.fn();
  const view = render(<ProviderModelPicker catalog={catalog} selection={null} instanceLocked={false} onChange={changed} />);
  fireEvent.click(screen.getByRole("button", { name: "Choose model and provider" }));
  fireEvent.click(screen.getByRole("button", { name: "Matrix AI agent, Matrix AI unavailable" }));
  const glm = screen.getByRole("option", { name: "GLM 5.3 Flash via Matrix AI" });
  expect(glm).toBeEnabled();
  fireEvent.click(glm);
  expect(changed).toHaveBeenCalledWith(expect.objectContaining({ instanceId: "matrix_pi_default", model: "cloudflare:@cf/zai-org/glm-5.3-flash" }));
  view.rerender(<ProviderModelPicker catalog={catalog} selection={changed.mock.calls[0]![0]} instanceLocked={false} onChange={changed} />);
  expect(screen.getByRole("button", { name: "Choose model and provider" })).toHaveAttribute("data-model", "cloudflare:@cf/zai-org/glm-5.3-flash");
  expect(screen.getByRole("button", { name: "Choose model and provider" }).title).toContain("Unavailable");
});

it("keeps checking Codex disabled beside selectable unavailable Matrix intent", () => {
  const catalog = outageCatalog();
  const native = catalog.instances[0]!;
  native.availability = "unavailable";
  native.observationState = "checking";
  native.unavailabilityReason = "runtime_unavailable";
  delete native.defaultSelection;
  native.models.forEach(model => { model.availability = "unavailable"; });
  CanonicalProviderCatalogSchema.parse(catalog);
  expect(canonicalProviderModelCanBeSelected(native, native.models[0]!.id)).toBe(false);
  const selected = { instanceId: native.id, model: native.models[0]!.id, options: [],
    interactionMode: native.supports.interactionModes[0]!, permissionMode: native.supports.permissionModes[0]! };
  const changed = vi.fn();
  render(<ProviderModelPicker catalog={catalog} selection={selected} instanceLocked={false} onChange={changed} />);
  const trigger = screen.getByRole("button", { name: "Choose model and provider" });
  expect(trigger.title).toContain("Checking Codex access…");
  fireEvent.click(trigger);
  const nativeRow = screen.getByRole("option", { name: /GPT-5.6-Sol.*Codex/ });
  expect(nativeRow).toBeDisabled();
  fireEvent.click(nativeRow);
  expect(changed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Matrix AI agent, Matrix AI unavailable" }));
  const managedRow = screen.getByRole("option", { name: "GLM 5.3 Flash via Matrix AI" });
  expect(managedRow).toBeEnabled();
  fireEvent.click(managedRow);
  expect(changed).toHaveBeenCalledWith(expect.objectContaining({ instanceId: "matrix_pi_default", model: "cloudflare:@cf/zai-org/glm-5.3-flash" }));
  expect(canonicalComposerSelectionIsAvailable(catalog, changed.mock.calls[0]![0])).toBe(false);
});
