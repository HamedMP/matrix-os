// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CanonicalProviderCatalog } from "@matrix-os/contracts";
import { useCanonicalComposerSelection } from "@desktop/renderer/src/features/chat/use-canonical-composer-selection";
import { canonicalComposerSelectionIsAvailable } from "../../packages/ui/src/canonical-composer-selection.js";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useProviderPreferences } from "@desktop/renderer/src/features/settings/provider-preferences";
import { resetProviderPreferences } from "./provider-preferences-test-utils";
import { providerCatalog } from "./canonical-chat-workspace-test-utils";

const instanceId = "matrix_pi_default";
const selected = "@cf/zai-org/glm-5.3-flash";
const peer = "@cf/openai/gpt-oss-20b";
function catalog(ready: string | null): CanonicalProviderCatalog {
  const base = providerCatalog.instances[0]!;
  return { revision: `health-${ready}`, drivers: [{ kind: "matrix_pi", displayName: "Pi", adapterVersion: "1", capabilityClass: "system_agent" }],
    instances: [{ ...base, id: instanceId, driverKind: "matrix_pi", displayName: "Matrix AI", connectionLabel: "Matrix AI",
      availability: ready ? "available" : "unavailable", options: [],
      models: [selected, peer].map(id => ({ ...base.models[0]!, id, displayName: id, availability: id === ready ? "available" : "unavailable" })),
      defaultSelection: ready ? { instanceId, model: ready } : undefined }] };
}
beforeEach(() => {
  useConnection.setState(useConnection.getInitialState(), true);
  resetProviderPreferences({ hydrated: true, lastComposerInstanceId: instanceId,
    composerSelections: { [instanceId]: { model: selected, options: [], permissionMode: "supervised" } } });
  window.operator = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) };
});
afterEach(cleanup);

it.each([peer, null])("retains a remembered funded model on cold open when health is %s", async ready => {
  const current = catalog(ready);
  const { result } = renderHook(() => useCanonicalComposerSelection({ catalog: current, catalogReady: true,
    initializeImmediately: true, chatId: null }));
  await waitFor(() => expect(result.current.selection?.model).toBe(selected));
  expect(canonicalComposerSelectionIsAvailable(current, result.current.selection)).toBe(false);
  expect(useProviderPreferences.getState().composerSelections[instanceId]?.model).toBe(selected);
});

it("preserves the chosen funded model across peer health changes and enables it only on current health", async () => {
  const { result, rerender } = renderHook(({ current }) => useCanonicalComposerSelection({ catalog: current,
    catalogReady: true, initializeImmediately: true, chatId: null }), { initialProps: { current: catalog(selected) } });
  await waitFor(() => expect(result.current.selection?.model).toBe(selected));
  act(() => result.current.onSelectionChange(result.current.selection!));
  rerender({ current: catalog(peer) });
  expect(result.current.selection?.model).toBe(selected);
  expect(canonicalComposerSelectionIsAvailable(catalog(peer), result.current.selection)).toBe(false);
  rerender({ current: catalog(selected) });
  expect(result.current.selection?.model).toBe(selected);
  expect(canonicalComposerSelectionIsAvailable(catalog(selected), result.current.selection)).toBe(true);
});
