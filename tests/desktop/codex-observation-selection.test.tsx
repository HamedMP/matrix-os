// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { CanonicalProviderCatalog } from "@matrix-os/contracts";
import { useCanonicalComposerSelection } from "@desktop/renderer/src/features/chat/use-canonical-composer-selection";
import { ProviderModelPicker } from "@desktop/renderer/src/features/chat/ProviderModelPicker";
import { canonicalComposerSelectionIsAvailable } from "../../packages/ui/src/canonical-composer-selection.js";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { resetProviderPreferences } from "./provider-preferences-test-utils";
import { providerCatalog } from "./canonical-chat-workspace-test-utils";
const selection = { instanceId: "codex_default", model: "gpt-5.6-sol", options: [], interactionMode: "default", permissionMode: "supervised" };
function catalog(checking: boolean): CanonicalProviderCatalog {
  const base = providerCatalog.instances[0]!;
  const native = { ...base, id: selection.instanceId, displayName: "Codex", availability: checking ? "unavailable" as const : "available" as const,
    ...(checking ? { observationState: "checking" as const, unavailabilityReason: "runtime_unavailable" as const } : {}),
    models: base.models.map(model => ({ ...model, availability: checking ? "unavailable" as const : "available" as const })),
    defaultSelection: checking ? undefined : { instanceId: selection.instanceId, model: selection.model } };
  return { ...providerCatalog, instances: [native, { ...base, id: "matrix_pi_default", driverKind: "matrix_pi", connectionLabel: "Matrix AI", defaultSelection: undefined }] };
}
beforeEach(() => {
  useConnection.setState(useConnection.getInitialState(), true);
  resetProviderPreferences({ hydrated: true, lastComposerInstanceId: selection.instanceId,
    composerSelections: { [selection.instanceId]: { model: selection.model, options: [], permissionMode: "supervised" } } });
  window.operator = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) };
});
afterEach(cleanup);
it("restores the remembered Codex selection on a cold checking observation instead of switching to Matrix AI", async () => {
  const { result, rerender } = renderHook(({ current }) => useCanonicalComposerSelection({ catalog: current, catalogReady: true, initializeImmediately: true, chatId: null }), { initialProps: { current: catalog(true) } });
  await waitFor(() => expect(result.current.selection).toMatchObject(selection));
  expect(canonicalComposerSelectionIsAvailable(catalog(true), result.current.selection)).toBe(false);
  rerender({ current: catalog(false) });
  await waitFor(() => expect(result.current.selection).toMatchObject(selection));
  expect(canonicalComposerSelectionIsAvailable(catalog(false), result.current.selection)).toBe(true);
});
it("retains a bound chat's model and permissions while showing disabled checking rows", () => {
  const change = vi.fn();
  render(<ProviderModelPicker catalog={catalog(true)} selection={selection} instanceLocked onChange={change} />);
  const trigger = screen.getByRole("button", { name: "Choose model and provider" });
  expect(trigger).toHaveTextContent("Checking Codex access…");
  fireEvent.click(trigger);
  const model = screen.getByRole("option", { name: /GPT-5.6-Sol.*Codex/ });
  expect(model).toBeDisabled();
  fireEvent.click(model);
  expect(change).not.toHaveBeenCalled();
});
