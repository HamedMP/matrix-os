// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";
import { useChatProviderState } from "../../shell/src/components/chat-app-provider-setup";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

it.each(["codex_fixture", "codex:fixture"])("keeps separate defaults across switching and reload (%s)", async instanceId => {
  localStorage.clear();
  const catalog = createCanonicalProviderCatalogFixture();
  const codex = catalog.instances[0]!;
  codex.id = instanceId;
  codex.defaultSelection = { instanceId, model: codex.models[0]!.id };
  codex.options = [{ id: "effort", label: "Reasoning", kind: "enum", placement: "composer",
    values: [{ value: "low", label: "Low" }, { value: "high", label: "High" }], defaultValue: "low" }];
  const claude = { ...codex, id: "claude_code_fixture", driverKind: "claude_code" as const,
    displayName: "Claude Code", defaultSelection: undefined };
  catalog.drivers.push({ ...catalog.drivers[0]!, kind: "claude_code", displayName: "Claude Code" });
  catalog.instances.push(claude);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(catalog))));
  const hook = renderHook(() => useChatProviderState());
  await waitFor(() => expect(hook.result.current.selected?.instanceId).toBe(codex.id));
  act(() => hook.result.current.selectOption("effort", "high"));
  act(() => hook.result.current.selectPermissionMode("full_access"));
  act(() => hook.result.current.select(hook.result.current.choices.find(c => c.instanceId === claude.id)!));
  expect(hook.result.current.selected?.permissionMode).toBe("supervised");
  act(() => hook.result.current.select(hook.result.current.choices.find(c => c.instanceId === codex.id)!));
  expect(hook.result.current.selected).toMatchObject({ permissionMode: "full_access",
    selectedOptions: [{ id: "effort", value: "high" }] });
  hook.unmount();
  const reloaded = renderHook(() => useChatProviderState());
  await waitFor(() => expect(reloaded.result.current.selected?.instanceId).toBe(codex.id));
  expect(reloaded.result.current.selected?.permissionMode).toBe("full_access");
  act(() => reloaded.result.current.select(reloaded.result.current.choices.find(c => c.instanceId === claude.id)!));
  expect(reloaded.result.current.selected).toMatchObject({ permissionMode: "supervised",
    selectedOptions: [{ id: "effort", value: "low" }] });
});

it("merges stale tab writes and synchronizes mounted composers", async () => {
  const { rememberProviderPreference, readSavedProviderPreferences } = await import("../../shell/src/components/chat-provider-preferences");
  const catalog = createCanonicalProviderCatalogFixture();
  const codex = catalog.instances[0]!;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(catalog))));
  const hook = renderHook(() => useChatProviderState());
  await waitFor(() => expect(hook.result.current.selected?.instanceId).toBe(codex.id));
  act(() => {
    rememberProviderPreference({}, codex.id, { key: `${codex.id}:${codex.models[0]!.id}`, permissionMode: "full_access" });
  });
  await waitFor(() => expect(hook.result.current.selected?.permissionMode).toBe("full_access"));
  rememberProviderPreference({}, "claude_other", { key: "claude_other:model", permissionMode: "auto" });
  expect(readSavedProviderPreferences()[codex.id]?.permissionMode).toBe("full_access");
  // The browser's storage event supplies updates from another tab.
  act(() => {
    localStorage.setItem("matrix:canonical-chat-provider-preferences", JSON.stringify({
      [codex.id]: { key: `${codex.id}:${codex.models[0]!.id}`, permissionMode: "supervised" },
    }));
    window.dispatchEvent(new StorageEvent("storage", { key: "matrix:canonical-chat-provider-preferences" }));
  });
  await waitFor(() => expect(hook.result.current.selected?.permissionMode).toBe("supervised"));
});
