// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useChatProviderState } from "../../shell/src/components/chat-app-provider-setup";
import { ordinaryApiCatalog, apiBinding, apiId } from "../ui/ordinary-anthropic-api-fixture";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });
it("Web repairs an API key binding only on explicit selection and refuses cached execution after failed refresh", async () => {
 const catalog = ordinaryApiCatalog(), stale = apiBinding.map(o => o.id === "connectionRevision" ? { ...o, value: "2" } : o);
 vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(catalog)).mockRejectedValueOnce(new Error("CatalogUnavailable")));
 const hook = renderHook(() => useChatProviderState({ instanceId: apiId, model: "claude-owner", options: stale }, apiId));
 await waitFor(() => expect(hook.result.current.loading).toBe(false)); expect(hook.result.current.selected).toBeNull();
 act(() => hook.result.current.select(hook.result.current.choices.find(c => c.instanceId === apiId)!)); expect(hook.result.current.selected?.selectedOptions).toEqual(apiBinding);
 act(() => hook.result.current.refresh()); await waitFor(() => expect(hook.result.current.unavailable).toBe(true)); expect(hook.result.current.selected).toBeNull();
});
it("Web preserves an unavailable explicit API intent rather than choosing funded or replacement models", async () => {
 const catalog = ordinaryApiCatalog(); catalog.instances = [catalog.instances[0]!];
 localStorage.setItem("matrix:canonical-chat-provider-selection", JSON.stringify({ key: `${apiId}:claude-owner`, options: apiBinding }));
 vi.stubGlobal("fetch", vi.fn(async () => Response.json(catalog)));
 const hook = renderHook(() => useChatProviderState()); await waitFor(() => expect(hook.result.current.loading).toBe(false));
 expect(hook.result.current.selected).toBeNull(); expect(hook.result.current.displaySelection).toEqual({ instanceId: apiId, modelId: "claude-owner" });
});
