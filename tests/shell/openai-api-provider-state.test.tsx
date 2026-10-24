// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useChatProviderState } from "../../shell/src/components/chat-app-provider-setup";
import { ordinaryOpenAiCatalog, openAiBinding, openAiApiId } from "../ui/ordinary-openai-api-fixture";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });
it("Web changing models preserves the explicitly selected current OpenAI wire API", async () => {
 vi.stubGlobal("fetch", vi.fn(async () => Response.json(ordinaryOpenAiCatalog())));
 const hook = renderHook(() => useChatProviderState({ instanceId: openAiApiId, model: "gpt-4.1", options: openAiBinding }, openAiApiId));
 await waitFor(() => expect(hook.result.current.loading).toBe(false));
 expect(hook.result.current.selected?.selectedOptions).toEqual(openAiBinding);
 act(() => hook.result.current.select(hook.result.current.choices.find(c => c.instanceId === openAiApiId && c.modelId === "gpt-4.1-mini")!));
 expect(hook.result.current.selected?.selectedOptions).toEqual(openAiBinding);
});
