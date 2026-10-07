// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useChatProviderState } from "../../shell/src/components/chat-app-provider-setup";
import { ordinaryPlanCatalog, planId, planBinding } from "../ui/ordinary-chatgpt-plan-fixture";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });
it("Web preserves a stale saved Chat binding until explicit selection of the current account", async () => {
 const catalog = ordinaryPlanCatalog(), old = planBinding.map(option => option.id === "accountId" ? { ...option, value: "old-account" } : option);
 vi.stubGlobal("fetch", vi.fn(async () => Response.json(catalog)));
 const hook = renderHook(() => useChatProviderState({ instanceId: planId, model: "gpt-owner", options: old }, planId));
 await waitFor(() => expect(hook.result.current.loading).toBe(false));
 expect(hook.result.current.selected).toBeNull();
 expect(hook.result.current.displaySelection).toEqual({ instanceId: planId, modelId: "gpt-owner" });
 act(() => hook.result.current.select(hook.result.current.choices.find(choice => choice.instanceId === planId)!));
 expect(hook.result.current.selected?.selectedOptions).toEqual(planBinding);
});
it("Web does not automatically select a personal plan when it is the sole executable source", async () => {
 const catalog = ordinaryPlanCatalog(); catalog.instances = [catalog.instances[1]!];
 vi.stubGlobal("fetch", vi.fn(async () => Response.json(catalog)));
 const hook = renderHook(() => useChatProviderState());
 await waitFor(() => expect(hook.result.current.loading).toBe(false));
 expect(hook.result.current.choices).toHaveLength(1); expect(hook.result.current.selected).toBeNull();
 act(() => hook.result.current.select(hook.result.current.choices[0]!));
 expect(hook.result.current.selected?.instanceId).toBe(planId);
});
it("Web refuses cached personal execution after failed catalog refresh and recovers through existing refresh", async () => {
 const catalog = ordinaryPlanCatalog();
 const fetch = vi.fn().mockResolvedValueOnce(Response.json(catalog)).mockRejectedValueOnce(new Error("CatalogUnavailable")).mockResolvedValueOnce(Response.json(catalog));
 vi.stubGlobal("fetch", fetch);
 const hook = renderHook(() => useChatProviderState({ instanceId: planId, model: "gpt-owner", options: planBinding }, planId));
 await waitFor(() => expect(hook.result.current.loading).toBe(false)); expect(hook.result.current.selected?.instanceId).toBe(planId);
 act(() => hook.result.current.refresh());
 await waitFor(() => expect(hook.result.current.unavailable).toBe(true));
 expect(hook.result.current.selected).toBeNull();
 expect(hook.result.current.choices.some(choice => choice.instanceId === planId)).toBe(false);
 act(() => hook.result.current.refresh());
 await waitFor(() => expect(hook.result.current.unavailable).toBe(false));
 expect(hook.result.current.selected?.selectedOptions).toEqual(planBinding);
});
it("Web never fills a missing saved personal binding from a newly observed account", async () => {
 const catalog = ordinaryPlanCatalog();
 localStorage.setItem("matrix:canonical-chat-provider-selection", JSON.stringify({ key: `${planId}:gpt-owner` }));
 vi.stubGlobal("fetch", vi.fn(async () => Response.json(catalog)));
 const hook = renderHook(() => useChatProviderState());
 await waitFor(() => expect(hook.result.current.loading).toBe(false));
 expect(hook.result.current.selected).toBeNull();
});
it("Web excludes the separate recipe-only Bot source from ordinary Chat choices", async () => {
 const catalog = ordinaryPlanCatalog(), plan = catalog.instances[1]!;
 catalog.drivers.push({ kind: "matrix_bot", displayName: "Matrix Bot", adapterVersion: "1.0.0", capabilityClass: "system_agent" });
 catalog.instances.push({ ...plan, id: "matrix_chatgpt_plan", driverKind: "matrix_bot", supports: { ...plan.supports, rootChat: false }, defaultSelection: { ...plan.defaultSelection!, instanceId: "matrix_chatgpt_plan" } });
 vi.stubGlobal("fetch", vi.fn(async () => Response.json(catalog)));
 const hook = renderHook(() => useChatProviderState());
 await waitFor(() => expect(hook.result.current.loading).toBe(false));
 expect(hook.result.current.choices.some(choice => choice.instanceId === "matrix_chatgpt_plan")).toBe(false);
});
it("Web retains an explicitly chosen personal source when disconnect removes its models", async () => {
 const catalog = ordinaryPlanCatalog(), disconnected = ordinaryPlanCatalog();
 disconnected.instances[1]!.availability = "unavailable"; disconnected.instances[1]!.models = []; disconnected.instances[1]!.defaultSelection = undefined;
 vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(catalog)).mockResolvedValueOnce(Response.json(disconnected)));
 const hook = renderHook(() => useChatProviderState());
 await waitFor(() => expect(hook.result.current.loading).toBe(false));
 act(() => hook.result.current.select(hook.result.current.choices.find(choice => choice.instanceId === planId)!));
 expect(hook.result.current.selected?.instanceId).toBe(planId);
 act(() => hook.result.current.refresh());
 await waitFor(() => expect(hook.result.current.catalog?.instances[1]?.availability).toBe("unavailable"));
 expect(hook.result.current.selected).toBeNull();
 expect(hook.result.current.displaySelection).toEqual({ instanceId: planId, modelId: "gpt-owner" });
 expect(hook.result.current.selectionStatus).toBe("Unavailable");
});
