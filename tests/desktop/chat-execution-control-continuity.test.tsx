// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCanonicalComposerSelection } from "@desktop/renderer/src/features/chat/use-canonical-composer-selection";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { resetProviderPreferences } from "./provider-preferences-test-utils";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";

beforeEach(() => {
  useConnection.setState(useConnection.getInitialState(), true);
  resetProviderPreferences({ hydrated: true, composerSelections: {
    codex_fixture: { model: "gpt-5.6-sol", options: [], permissionMode: "supervised" },
  } });
  window.operator = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) };
});
afterEach(cleanup);
it("restores accepted Chat controls instead of global preferences and fences local edits by Chat", async () => {
  const catalog = createCanonicalProviderCatalogFixture();
  const selection = { instanceId: "codex_fixture", model: "gpt-5.6-sol" };
  const controls = { chatId: "chat_one", runId: "run_one", selection, interactionMode: "plan", permissionMode: "full_access" };
  const hook = renderHook(({ chatId, executionControls }: { chatId: string; executionControls?: typeof controls }) =>
    useCanonicalComposerSelection({ catalog, catalogReady: true, initializeImmediately: true,
      chatId, currentSelection: selection, boundInstanceId: selection.instanceId, executionControls }),
  { initialProps: { chatId: "chat_one", executionControls: controls } as { chatId: string; executionControls?: typeof controls } });
  await waitFor(() => expect(hook.result.current.selection?.permissionMode).toBe("full_access"));
  expect(hook.result.current.selection?.interactionMode).toBe("plan");
  act(() => hook.result.current.onSelectionChange({ ...hook.result.current.selection!, permissionMode: "full_access" }));
  hook.rerender({ chatId: "chat_two" });
  await waitFor(() => expect(hook.result.current.selection?.permissionMode).toBe("supervised"));
});
