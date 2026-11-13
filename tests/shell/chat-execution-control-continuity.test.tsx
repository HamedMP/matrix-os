// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";
import { useChatProviderState } from "../../shell/src/components/chat-app-provider-setup";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear(); });
it("retains the submitted modes when a draft becomes a bound Chat and isolates the next Chat", async () => {
  const catalog = createCanonicalProviderCatalogFixture();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(catalog)));
  const selection = { instanceId: "codex_fixture", model: "gpt-5.6-sol" };
  const controls = { chatId: "chat_one", runId: "run_one", selection, interactionMode: "plan", permissionMode: "full_access" };
  const { result, rerender } = renderHook(({ chatId, scopeKey, executionControls }: { chatId?: string; scopeKey?: string; executionControls?: typeof controls }) =>
    useChatProviderState(chatId ? selection : undefined, chatId ? selection.instanceId : undefined, { chatId, scopeKey, executionControls }),
  { initialProps: {} as { chatId?: string; scopeKey?: string; executionControls?: typeof controls } });
  await waitFor(() => expect(result.current.loading).toBe(false));
  act(() => result.current.selectPermissionMode("full_access"));
  act(() => result.current.selectInteractionMode("plan"));
  expect(result.current.selected?.permissionMode).toBe("full_access");
  rerender({ chatId: "chat_one", executionControls: controls });
  expect(result.current.selected?.permissionMode).toBe("full_access");
  expect(result.current.selected?.interactionMode).toBe("plan");
  act(() => result.current.selectPermissionMode("supervised"));
  rerender({ chatId: "chat_two" });
  expect(result.current.selected?.interactionMode).toBe("default");
  act(() => result.current.selectPermissionMode("full_access"));
  rerender({ chatId: "chat_three" });
  expect(result.current.selected?.permissionMode).toBe("supervised");
  act(() => result.current.selectPermissionMode("full_access"));
  rerender({ chatId: "chat_three", scopeKey: "another_runtime" });
  expect(result.current.selected?.permissionMode).toBe("supervised");
});
