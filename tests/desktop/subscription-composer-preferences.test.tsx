// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLocalStore } from "@desktop/main/persistence/local-store";
import { ComposerOptionPreferenceSchema, ProviderPreferencesSchema } from "@desktop/shared/provider-preferences";
import { useProviderPreferences } from "@desktop/renderer/src/features/settings/provider-preferences";
import { useCanonicalComposerSelection } from "@desktop/renderer/src/features/chat/use-canonical-composer-selection";
import { canonicalComposerSelectionIsAvailable } from "@desktop/renderer/src/features/chat/canonical-composer-state";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { ordinaryPlanCatalog, planBinding, planId } from "../ui/ordinary-chatgpt-plan-fixture";

beforeEach(() => {
 useConnection.setState(useConnection.getInitialState(), true);
 useProviderPreferences.setState(useProviderPreferences.getInitialState(), true);
 window.operator = { invoke: vi.fn(async () => ({ value: null })), on: vi.fn(() => () => undefined) };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const preferences = { defaultProviderId: null, lastComposerInstanceId: planId,
 composerSelections: { [planId]: { model: "gpt-owner", options: planBinding, permissionMode: "supervised" } } };

it("allows exactly the canonical subscription binding option IDs while preserving preference bounds", () => {
 expect(ProviderPreferencesSchema.safeParse(preferences).success).toBe(true);
 for (const id of ["accountId", "grantRevision", "effort"]) expect(ComposerOptionPreferenceSchema.safeParse({ id, value: "high" }).success).toBe(true);
 for (const id of ["accountID", "grantrevisionX", "AccountId", "../accountId", "a".repeat(81)]) expect(ComposerOptionPreferenceSchema.safeParse({ id, value: "high" }).success).toBe(false);
 expect(ComposerOptionPreferenceSchema.safeParse({ id: "accountId", value: "a".repeat(129) }).success).toBe(false);
 expect(ProviderPreferencesSchema.safeParse({ ...preferences, composerSelections: { [planId]: { ...preferences.composerSelections[planId], options: Array.from({ length: 17 }, (_, index) => ({ id: `option_${index}`, value: true })) } } }).success).toBe(false);
 expect(ProviderPreferencesSchema.safeParse({ ...preferences, composerSelections: { [planId]: { ...preferences.composerSelections[planId], permissionMode: "FullAccess" } } }).success).toBe(false);
});

it("does not enable a replacement source while a cold personal preference read is pending", async () => {
 let resolveRead!: (value: { value: typeof preferences }) => void;
 const read = new Promise<{ value: typeof preferences }>(resolve => { resolveRead = resolve; });
 window.operator.invoke = vi.fn(() => read);
 const catalog = ordinaryPlanCatalog();
 catalog.instances[1]!.models = [];
 const hook = renderHook(() => useCanonicalComposerSelection({ catalog, catalogReady: true, initializeImmediately: true, chatId: null }));
 expect(hook.result.current.selection).toBeNull();
 expect(canonicalComposerSelectionIsAvailable(catalog, hook.result.current.selection)).toBe(false);
 await act(async () => { resolveRead({ value: preferences }); await read; });
 await waitFor(() => expect(useProviderPreferences.getState().hydrated).toBe(true));
 expect(hook.result.current.selection).toEqual({ instanceId: planId, model: "gpt-owner", options: planBinding, interactionMode: "default", permissionMode: "supervised" });
 expect(canonicalComposerSelectionIsAvailable(catalog, hook.result.current.selection)).toBe(false);
});

it.each(["success", "failure"] as const)("retains an explicit current choice across an in-flight cold preference read %s", async outcome => {
 let resolveRead!: (value: { value: typeof preferences }) => void;
 let rejectRead!: (reason: Error) => void;
 const read = new Promise<{ value: typeof preferences }>((resolve, reject) => { resolveRead = resolve; rejectRead = reject; });
 window.operator.invoke = vi.fn((channel) => channel === "state:get" ? read : Promise.resolve({ ok: true }));
 const catalog = ordinaryPlanCatalog();
 const hook = renderHook(() => useCanonicalComposerSelection({ catalog, catalogReady: true, initializeImmediately: true, chatId: null }));
 const choice = { instanceId: planId, model: "gpt-owner", options: planBinding, interactionMode: "default", permissionMode: "supervised" };
 act(() => hook.result.current.onSelectionChange(choice));
 expect(hook.result.current.selection).toEqual(choice);
 await act(async () => {
  if (outcome === "success") resolveRead({ value: { ...preferences, lastComposerInstanceId: "codex_fixture" } });
  else rejectRead(new Error("state bridge unavailable"));
  await read.catch(() => undefined);
 });
 await waitFor(() => expect(useProviderPreferences.getState().hydrated).toBe(true));
 expect(hook.result.current.selection).toEqual(choice);
 expect(canonicalComposerSelectionIsAvailable(catalog, hook.result.current.selection)).toBe(true);
 expect(useProviderPreferences.getState().lastComposerInstanceId).toBe(planId);
});

it.each(["removed", "unavailable", "source_removed", "account_changed", "grant_changed"] as const)("persists through the real local store and hydrates the exact personal model/binding when %s", async state => {
 const dir = await mkdtemp(join(tmpdir(), "matrix-subscription-preference-"));
 try {
  const store = createLocalStore({ dir });
  window.operator.invoke = vi.fn(async (channel, payload) => {
   if (channel === "state:set") { await store.set("providerPreferences", ProviderPreferencesSchema.parse((payload as { value: unknown }).value)); return { ok: true }; }
   return { value: await store.get("providerPreferences") };
  });
  useProviderPreferences.getState().setComposerSelection({ instanceId: planId, ...preferences.composerSelections[planId], interactionMode: "default" });
  await waitFor(async () => expect(await store.get("providerPreferences")).toEqual(preferences));
  useProviderPreferences.setState(useProviderPreferences.getInitialState(), true);
  const catalog = ordinaryPlanCatalog(), plan = catalog.instances[1]!, previous = plan.models[0]!;
  catalog.revision = "hydrated_new_catalog"; catalog.instances.forEach(instance => { instance.catalogRevision = catalog.revision; });
  plan.models = [...(state === "unavailable" ? [{ ...previous, availability: "unavailable" as const }] : []), { ...previous, id: "gpt-replacement", displayName: "Replacement GPT" }];
  plan.defaultSelection = { instanceId: planId, model: "gpt-replacement", options: planBinding };
  if (state === "source_removed") catalog.instances = [catalog.instances[0]!];
  if (state === "account_changed" || state === "grant_changed") {
   const options = planBinding.map(option => option.id === (state === "account_changed" ? "accountId" : "grantRevision") ? { ...option, value: state === "account_changed" ? "account-b" : "4" } : option);
   plan.defaultSelection.options = options;
   plan.options = options.map(option => ({ id: option.id, label: option.id, kind: "enum", placement: "advanced", values: [{ value: option.value, label: option.value }], defaultValue: option.value }));
  }
  const hook = renderHook(() => useCanonicalComposerSelection({ catalog, catalogReady: true, initializeImmediately: true, chatId: null }));
  await act(async () => { await useProviderPreferences.getState().hydrate(); });
  await waitFor(() => expect(useProviderPreferences.getState().hydrated).toBe(true));
  expect(hook.result.current.selection).toEqual({ instanceId: planId, model: "gpt-owner", options: planBinding, interactionMode: "default", permissionMode: "supervised" });
  expect(canonicalComposerSelectionIsAvailable(catalog, hook.result.current.selection)).toBe(false);
  expect(useProviderPreferences.getState().composerSelections[planId]?.options).toEqual(planBinding);
 } finally { await rm(dir, { recursive: true, force: true }); }
});
