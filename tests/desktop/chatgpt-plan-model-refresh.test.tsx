// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CanonicalProviderCatalog } from "@matrix-os/contracts";
import { ProviderModelPicker } from "@desktop/renderer/src/features/chat/ProviderModelPicker";
import { canonicalComposerSelectionIsAvailable } from "@desktop/renderer/src/features/chat/canonical-composer-state";
import { useCanonicalComposerSelection } from "@desktop/renderer/src/features/chat/use-canonical-composer-selection";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useProviderPreferences } from "@desktop/renderer/src/features/settings/provider-preferences";
import { ordinaryPlanCatalog, planBinding, planId } from "../ui/ordinary-chatgpt-plan-fixture";

const explicitSelection = { instanceId: planId, model: "gpt-owner", options: planBinding, interactionMode: "default", permissionMode: "supervised" };
function refreshedCatalog(state: "removed" | "unavailable") {
 const catalog = ordinaryPlanCatalog(), instance = catalog.instances[1]!, previous = instance.models[0]!;
 catalog.revision = "refreshed_models";
 catalog.instances = catalog.instances.map(source => ({ ...source, catalogRevision: catalog.revision }));
 const plan = catalog.instances[1]!;
 plan.models = [...(state === "unavailable" ? [{ ...previous, availability: "unavailable" as const }] : []),
  { ...previous, id: "gpt-replacement", displayName: "Replacement GPT" }];
 plan.defaultSelection = { instanceId: planId, model: "gpt-replacement", options: planBinding };
 return catalog;
}
beforeEach(() => {
 vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
 useConnection.setState(useConnection.getInitialState(), true);
 useProviderPreferences.setState({ ...useProviderPreferences.getInitialState(), hydrated: true }, true);
 window.operator = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function DraftComposer({ catalog }: { catalog: CanonicalProviderCatalog }) {
 const { selection, onSelectionChange } = useCanonicalComposerSelection({ catalog, catalogReady: true, initializeImmediately: true, chatId: null });
 return <><ProviderModelPicker catalog={catalog} selection={selection} instanceLocked={false} onChange={onSelectionChange}/>
  <output data-testid="selection">{JSON.stringify(selection)}</output>
  <button disabled={!canonicalComposerSelectionIsAvailable(catalog, selection)}>Send</button></>;
}

it.each(["removed", "unavailable"] as const)("retains a touched new Chat's exact subscription model when refreshed discovery marks it %s, until an explicit picker selection", state => {
 const initial = ordinaryPlanCatalog(), refreshed = refreshedCatalog(state);
 expect(refreshed.instances[1]?.defaultSelection?.options).toEqual(planBinding);
 const view = render(<DraftComposer catalog={initial}/>);
 fireEvent.click(screen.getByRole("button", { name: "Choose model and provider" }));
 fireEvent.click(screen.getByRole("button", { name: "Matrix AI agent, Available" }));
 fireEvent.click(screen.getByRole("option", { name: "Owner GPT via Matrix AI · ChatGPT subscription" }));
 expect(JSON.parse(screen.getByTestId("selection").textContent!)).toEqual(explicitSelection);
 expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
 view.rerender(<DraftComposer catalog={refreshed}/>);
 expect(JSON.parse(screen.getByTestId("selection").textContent!)).toEqual(explicitSelection);
 expect(screen.getByRole("button", { name: "Choose model and provider" })).toHaveTextContent("Unavailable");
 expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
 fireEvent.click(screen.getByRole("button", { name: "Choose model and provider" }));
 fireEvent.click(screen.getByRole("option", { name: "Replacement GPT via Matrix AI · ChatGPT subscription" }));
 expect(JSON.parse(screen.getByTestId("selection").textContent!)).toEqual({ ...explicitSelection, model: "gpt-replacement" });
 expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
 view.rerender(<DraftComposer catalog={{ ...refreshed, revision: "second_refresh" }}/>);
 expect(JSON.parse(screen.getByTestId("selection").textContent!)).toEqual({ ...explicitSelection, model: "gpt-replacement" });
});

it.each(["removed", "unavailable"] as const)("keeps the saved Chat model when discovery marks it %s", state => {
 const props = { catalog: ordinaryPlanCatalog(), catalogReady: true, initializeImmediately: true, chatId: "saved_plan_chat",
  currentSelection: explicitSelection, boundInstanceId: planId };
 const hook = renderHook(value => useCanonicalComposerSelection(value), { initialProps: props });
 hook.rerender({ ...props, catalog: refreshedCatalog(state) });
 expect(hook.result.current.selection).toEqual(explicitSelection);
 expect(canonicalComposerSelectionIsAvailable(refreshedCatalog(state), hook.result.current.selection)).toBe(false);
});

it.each(["auth", "runtime", "chat"] as const)("resets touched subscription intent across %s scope changes", boundary => {
 const initial = ordinaryPlanCatalog(), savedNative = { instanceId: "codex_fixture", model: "gpt-5.6-sol" };
 const props = { catalog: initial, catalogReady: true, initializeImmediately: true, chatId: "draft_one", currentSelection: savedNative, boundInstanceId: undefined };
 const hook = renderHook(value => useCanonicalComposerSelection(value), { initialProps: props });
 act(() => hook.result.current.onSelectionChange(explicitSelection));
 hook.rerender({ ...props, catalog: refreshedCatalog("removed") });
 expect(hook.result.current.selection).toEqual(explicitSelection);
 if (boundary === "auth") act(() => useConnection.setState({ authGeneration: 1 }));
 if (boundary === "runtime") act(() => useConnection.setState({ runtimeSlot: "other" }));
 hook.rerender({ ...props, chatId: boundary === "chat" ? "draft_two" : props.chatId, catalog: refreshedCatalog("removed") });
 expect(hook.result.current.selection?.instanceId).toBe(savedNative.instanceId);
 expect(hook.result.current.selection?.model).toBe(savedNative.model);
});
it.each(["removed", "unavailable"] as const)("retains a hydrated personal-source model after remount when it is %s", state => {
 useProviderPreferences.setState({ lastComposerInstanceId: planId, composerSelections: {
  [planId]: { model: "gpt-owner", options: planBinding, permissionMode: "full_access" },
 } });
 const catalog = refreshedCatalog(state);
 const hook = renderHook(() => useCanonicalComposerSelection({ catalog, catalogReady: true, initializeImmediately: true, chatId: null }));
 expect(hook.result.current.selection).toEqual({ ...explicitSelection, permissionMode: "full_access" });
 expect(canonicalComposerSelectionIsAvailable(catalog, hook.result.current.selection)).toBe(false);
});
it("does not automatically choose personal subscription for an untouched empty draft", () => {
 const catalog = ordinaryPlanCatalog(); catalog.instances = [catalog.instances[1]!];
 const hook = renderHook(() => useCanonicalComposerSelection({ catalog, catalogReady: true, initializeImmediately: true, chatId: null }));
 expect(hook.result.current.selection).toBeNull();
});
it("retains a remembered missing model as unavailable without rebinding a changed personal account", () => {
 useProviderPreferences.setState({ lastComposerInstanceId: planId, composerSelections: {
  [planId]: { model: "gpt-owner", options: planBinding.map(row => row.id === "accountId" ? { ...row, value: "previous-account" } : row), permissionMode: "supervised" },
 } });
 const catalog = refreshedCatalog("removed");
 const hook = renderHook(() => useCanonicalComposerSelection({ catalog, catalogReady: true, initializeImmediately: true, chatId: null }));
 expect(hook.result.current.selection?.model).toBe("gpt-owner");
 expect(hook.result.current.selection?.options[0]?.value).toBe("previous-account");
 expect(canonicalComposerSelectionIsAvailable(catalog, hook.result.current.selection)).toBe(false);
});
it("keeps the existing missing-model default behavior for unrelated native provider preferences", () => {
 useProviderPreferences.setState({ lastComposerInstanceId: "codex_fixture", composerSelections: {
  codex_fixture: { model: "native-missing-model", options: [], permissionMode: "supervised" },
 } });
 const catalog = ordinaryPlanCatalog();
 const hook = renderHook(() => useCanonicalComposerSelection({ catalog, catalogReady: true, initializeImmediately: true, chatId: null }));
 expect(hook.result.current.selection?.instanceId).toBe("codex_fixture");
 expect(hook.result.current.selection?.model).toBe("gpt-5.6-sol");
});
it("does not override a required native instance with remembered unavailable personal intent", () => {
 useProviderPreferences.setState({ lastComposerInstanceId: planId, composerSelections: {
  [planId]: { model: "gpt-owner", options: planBinding, permissionMode: "supervised" },
 } });
 const catalog = refreshedCatalog("removed");
 const hook = renderHook(() => useCanonicalComposerSelection({ catalog, catalogReady: true, initializeImmediately: true, chatId: null, boundInstanceId: "codex_fixture" }));
 expect(hook.result.current.selection?.instanceId).toBe("codex_fixture");
});

it.each(["accountId", "grantRevision"] as const)("keeps touched personal intent unavailable until an explicit picker choice binds the current %s", bindingId => {
 const catalog = ordinaryPlanCatalog();
 const view = render(<DraftComposer catalog={catalog}/>);
 fireEvent.click(screen.getByRole("button", { name: "Choose model and provider" }));
 fireEvent.click(screen.getByRole("button", { name: "Matrix AI agent, Available" }));
 fireEvent.click(screen.getByRole("option", { name: "Owner GPT via Matrix AI · ChatGPT subscription" }));
 const refreshed = ordinaryPlanCatalog(), source = refreshed.instances[1]!;
 const binding = planBinding.map(option => option.id === bindingId ? { ...option, value: bindingId === "accountId" ? "account-b" : "4" } : option);
 source.defaultSelection!.options = binding;
 source.options = binding.map(option => ({ id: option.id, label: option.id, kind: "enum", placement: "advanced", values: [{ value: option.value, label: option.value }], defaultValue: option.value }));
 view.rerender(<DraftComposer catalog={refreshed}/>);
 expect(JSON.parse(screen.getByTestId("selection").textContent!)).toEqual(explicitSelection);
 expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
 fireEvent.click(screen.getByRole("button", { name: "Choose model and provider" }));
 fireEvent.click(screen.getByRole("option", { name: "Owner GPT via Matrix AI · ChatGPT subscription" }));
 expect(JSON.parse(screen.getByTestId("selection").textContent!)).toEqual({ ...explicitSelection, options: binding });
 expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
 expect(useProviderPreferences.getState().composerSelections[planId]?.options).toEqual(binding);
});

it("retains personal intent through an untrusted read, a disconnected catalog and exact-source recovery", () => {
 const props = { catalog: ordinaryPlanCatalog(), catalogReady: true, initializeImmediately: true, chatId: null };
 const hook = renderHook(value => useCanonicalComposerSelection(value), { initialProps: props });
 act(() => hook.result.current.onSelectionChange(explicitSelection));
 hook.rerender({ ...props, catalogReady: false, catalog: { ...props.catalog, instances: [] } });
 expect(hook.result.current.selection).toBeNull();
 const disconnected = { ...props.catalog, instances: [props.catalog.instances[0]!] };
 hook.rerender({ ...props, catalog: disconnected });
 expect(hook.result.current.selection).toEqual(explicitSelection);
 expect(canonicalComposerSelectionIsAvailable(disconnected, hook.result.current.selection)).toBe(false);
 hook.rerender(props);
 expect(hook.result.current.selection).toEqual(explicitSelection);
 expect(canonicalComposerSelectionIsAvailable(props.catalog, hook.result.current.selection)).toBe(true);
});
