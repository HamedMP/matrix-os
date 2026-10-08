// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProviderModelPicker } from "@desktop/renderer/src/features/chat/ProviderModelPicker";
import { useCanonicalComposerSelection } from "@desktop/renderer/src/features/chat/use-canonical-composer-selection";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { ordinaryPlanCatalog, planBinding, planId } from "../ui/ordinary-chatgpt-plan-fixture";
beforeEach(() => {
 vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
 useConnection.setState(useConnection.getInitialState(), true);
 window.operator = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const stale = planBinding.map(option => option.id === "grantRevision" ? { ...option, value: "2" } : option);
it("Electron explicit model selection replaces the stale grant with current qualified binding", () => {
 const change = vi.fn();
 render(<ProviderModelPicker catalog={ordinaryPlanCatalog()} selection={{ instanceId: planId, model: "gpt-owner", options: stale, interactionMode: "default", permissionMode: "supervised" }} instanceLocked onChange={change}/>);
 const trigger = screen.getByRole("button", { name: "Choose model and provider" });
 expect(trigger).toHaveTextContent("Unavailable");
 fireEvent.click(trigger);
 fireEvent.click(screen.getByRole("option", { name: "Owner GPT via Matrix AI · ChatGPT subscription" }));
 expect(change).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ instanceId: planId, model: "gpt-owner", options: planBinding }));
});
it("Electron keeps the saved Chat binding across catalog refresh and restores only explicit new intent", () => {
 const catalog = ordinaryPlanCatalog(), currentSelection = { instanceId: planId, model: "gpt-owner", options: stale };
 const props = { catalog, catalogReady: true, initializeImmediately: true, chatId: "chat_plan", currentSelection, boundInstanceId: planId };
 const hook = renderHook(value => useCanonicalComposerSelection(value), { initialProps: props });
 expect(hook.result.current.selection?.options).toEqual(stale);
 hook.rerender({ ...props, catalog: { ...catalog, revision: "refresh" } });
 expect(hook.result.current.selection?.options).toEqual(stale);
 act(() => hook.result.current.onSelectionChange({ ...currentSelection, options: planBinding, interactionMode: "default", permissionMode: "supervised" }));
 hook.rerender({ ...props, catalog: { ...catalog, revision: "refresh2" } });
 expect(hook.result.current.selection?.options).toEqual(planBinding);
 act(() => useConnection.setState({ authGeneration: 1 }));
 expect(hook.result.current.selection?.options).toEqual(stale);
});
it("Electron never silently rebinds an explicitly selected draft when the account changes", () => {
 const catalog = ordinaryPlanCatalog(), currentSelection = undefined;
 const props = { catalog, catalogReady: true, initializeImmediately: true, chatId: null, currentSelection, boundInstanceId: undefined };
 const hook = renderHook(value => useCanonicalComposerSelection(value), { initialProps: props });
 act(() => hook.result.current.onSelectionChange({ instanceId: planId, model: "gpt-owner", options: planBinding, interactionMode: "default", permissionMode: "supervised" }));
 const changed = ordinaryPlanCatalog(); changed.instances[1]!.defaultSelection!.options = stale;
 changed.instances[1]!.options = changed.instances[1]!.options.map(option => ({ ...option, defaultValue: stale.find(row => row.id === option.id)!.value, values: [{ value: stale.find(row => row.id === option.id)!.value, label: option.label }] }));
 hook.rerender({ ...props, catalog: changed });
 expect(hook.result.current.selection?.options).toEqual(planBinding);
});
it("Electron explicit subscription choice repairs unsupported execution controls without changing valid ones", () => {
 const change = vi.fn();
 render(<ProviderModelPicker catalog={ordinaryPlanCatalog()} selection={{ instanceId: planId, model: "gpt-owner", options: stale, interactionMode: "old-mode", permissionMode: "old-permission" }} instanceLocked onChange={change}/>);
 fireEvent.click(screen.getByRole("button", { name: "Choose model and provider" }));
 fireEvent.click(screen.getByRole("option", { name: "Owner GPT via Matrix AI · ChatGPT subscription" }));
 expect(change).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ instanceId: planId, options: planBinding, interactionMode: "default", permissionMode: "supervised" }));
});

it("Electron selected personal model identifies Matrix AI and subscription funding with the rabbit", () => {
 render(<ProviderModelPicker catalog={ordinaryPlanCatalog()} selection={{ instanceId: planId, model: "gpt-owner", options: planBinding, interactionMode: "default", permissionMode: "supervised" }} instanceLocked onChange={vi.fn()}/>);
 const trigger = screen.getByRole("button", { name: "Choose model and provider" });
 expect(trigger).toHaveAttribute("title", "Owner GPT · Matrix AI · ChatGPT subscription");
 expect(trigger.querySelector('[data-provider-glyph="kernel"]')).not.toBeNull();
 expect(trigger.querySelector('[data-provider-glyph="codex"]')).toBeNull();
 fireEvent.click(trigger);
 expect(screen.getByRole("button", { name: "Matrix AI agent, Available" })).toHaveAttribute("aria-pressed", "true");
 expect(screen.queryByRole("button", { name: /ChatGPT subscription agent/ })).toBeNull();
 expect(screen.getByRole("searchbox")).not.toHaveFocus();
});
