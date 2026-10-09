// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderModelPicker } from "@desktop/renderer/src/features/chat/ProviderModelPicker";
import { useCanonicalComposerSelection } from "@desktop/renderer/src/features/chat/use-canonical-composer-selection";
import { useProviderPreferences } from "@desktop/renderer/src/features/settings/provider-preferences";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { createLocalStore } from "@desktop/main/persistence/local-store";
import { ComposerOptionPreferenceSchema, ProviderPreferencesSchema } from "@desktop/shared/provider-preferences";
import { ordinaryApiCatalog, apiBinding, apiId } from "../ui/ordinary-anthropic-api-fixture";
beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); useConnection.setState(useConnection.getInitialState(), true); useProviderPreferences.setState(useProviderPreferences.getInitialState(), true); window.operator = { invoke: vi.fn(async () => ({ value: null })), on: vi.fn(() => () => undefined) }; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const stale = apiBinding.map(o => o.id === "connectionRevision" ? { ...o, value: "2" } : o);
it("selects the current API binding explicitly and renders the Matrix AI rabbit", () => {
 const change = vi.fn(); render(<ProviderModelPicker catalog={ordinaryApiCatalog()} selection={{ instanceId: apiId, model: "claude-owner", options: stale, interactionMode: "default", permissionMode: "supervised" }} instanceLocked onChange={change}/>);
 const trigger = screen.getByRole("button", { name: "Choose model and provider" }); expect(trigger).toHaveTextContent("Unavailable"); expect(trigger.querySelector('[data-provider-glyph="kernel"]')).not.toBeNull();
 fireEvent.click(trigger); fireEvent.click(screen.getByRole("option", { name: "Owner Claude via Matrix AI · Anthropic API" }));
 expect(change).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ instanceId: apiId, options: apiBinding }));
});
it("persists and hydrates exact API preference through the actual local store after replacement", async () => {
 const dir = await mkdtemp(join(tmpdir(), "matrix-api-preference-"));
 try {
  const store = createLocalStore({ dir }); window.operator.invoke = vi.fn(async (channel, payload) => { if (channel === "state:set") { await store.set("providerPreferences", ProviderPreferencesSchema.parse((payload as { value: unknown }).value)); return { ok: true }; } return { value: await store.get("providerPreferences") }; });
  useProviderPreferences.getState().setComposerSelection({ instanceId: apiId, model: "claude-owner", options: stale, interactionMode: "default", permissionMode: "supervised" });
  await waitFor(async () => expect(await store.get("providerPreferences")).toMatchObject({ lastComposerInstanceId: apiId }));
  useProviderPreferences.setState(useProviderPreferences.getInitialState(), true);
  const catalog = ordinaryApiCatalog();
  const hook = renderHook(() => useCanonicalComposerSelection({ catalog, catalogReady: true, initializeImmediately: true, chatId: null }));
  await waitFor(() => expect(hook.result.current.selection?.instanceId).toBe(apiId));
  expect(hook.result.current.selection).toMatchObject({ instanceId: apiId, model: "claude-owner", options: stale });
 } finally { await rm(dir, { recursive: true, force: true }); }
});
it("preserves an explicit draft generation across source replacement and catalog refresh", async () => {
 const initial = { catalog: ordinaryApiCatalog(), catalogReady: true, initializeImmediately: true, chatId: null };
 const hook = renderHook(props => useCanonicalComposerSelection(props), { initialProps: initial });
 await waitFor(() => expect(useProviderPreferences.getState().hydrated).toBe(true));
 act(() => hook.result.current.onSelectionChange({ instanceId: apiId, model: "claude-owner", options: stale, interactionMode: "default", permissionMode: "supervised" }));
 hook.rerender({ ...initial, catalog: { ...initial.catalog, revision: "replaced" } }); expect(hook.result.current.selection?.options).toEqual(stale);
});
it("allows exact canonical API binding option names while rejecting arbitrary camel-case and oversized values", () => {
 for (const option of apiBinding) expect(ComposerOptionPreferenceSchema.safeParse(option).success).toBe(true);
 for (const id of ["ConnectionRevision", "credentialGenerationExtra", "credentialGeneration/../"]) expect(ComposerOptionPreferenceSchema.safeParse({ id, value: "1" }).success).toBe(false);
 expect(ComposerOptionPreferenceSchema.safeParse({ id: "credentialGeneration", value: "a".repeat(129) }).success).toBe(false);
});
