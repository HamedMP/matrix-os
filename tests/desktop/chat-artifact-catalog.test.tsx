// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { useChatArtifactActions } from "../../desktop/src/renderer/src/features/chat/use-chat-artifact-actions";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
const { refetch } = vi.hoisted(() => ({ refetch: vi.fn(async () => undefined) }));
vi.mock("../../desktop/src/renderer/src/features/apps/apps.api", () => ({ useAppsQuery: () => ({ data: [{ slug: "chart", name: "Chart", path: "apps/chart/index.html" }], refetch }) }));
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import { useDesktopSurfaces } from "../../desktop/src/renderer/src/stores/desktop-surfaces";
import { useNativeDesktopMode } from "../../desktop/src/renderer/src/stores/native-desktop-mode";
beforeEach(() => {
  useTabs.setState(useTabs.getInitialState(), true);
  useDesktopSurfaces.setState(useDesktopSurfaces.getInitialState(), true);
  useNativeDesktopMode.setState({ mode: "desktop", hydrated: true });
});
afterEach(() => vi.clearAllMocks());
function makeDetail(status: "running" | "completed"): CanonicalChatDetailResponse {
  const { snapshot } = createCanonicalChatFixture("completed");
  return { record: { chat: snapshot.chat }, messages: snapshot.messages, turns: snapshot.turns,
    runs: snapshot.runs.map((run) => ({ ...run, status })), activities: snapshot.activities };
}

it("refreshes the installed catalog when a Chat run settles so a newly built app becomes launchable", async () => {
  const { rerender } = renderHook(({ detail }) => useChatArtifactActions(null, detail, []), { initialProps: { detail: makeDetail("running") } });
  expect(refetch).not.toHaveBeenCalled();
  rerender({ detail: makeDetail("completed") });
  await waitFor(() => expect(refetch).toHaveBeenCalledOnce());
  rerender({ detail: makeDetail("completed") });
  expect(refetch).toHaveBeenCalledOnce();
});

it("launches relative apps only from home and honors a persisted project run root", () => {
  const { result } = renderHook(() => useChatArtifactActions(null, makeDetail("running"), []));
  expect(result.current.resolveApp("apps/chart")?.name).toBe("Chart");
  expect(result.current.resolveApp("apps/chart", { kind: "worktree", projectId: "project_1", worktreeId: "wt_1" })).toBeNull();
  expect(result.current.resolveApp("~/apps/chart", { kind: "project", projectId: "project_1" })?.name).toBe("Chart");
});

it.each([false, true])("keeps a maximized Chat in the tab workspace when launching an app (already open: %s)", (alreadyOpen) => {
  const tabs = useTabs.getState();
  const chatId = tabs.openTab({ kind: "chat", title: "Chat", chatId: "chat_qa", chatView: "conversation" });
  if (alreadyOpen) tabs.openTab({ kind: "app", slug: "chart", title: "Chart" });
  tabs.focusTab(chatId);
  const surfaces = useDesktopSurfaces.getState();
  surfaces.reconcileTabs(useTabs.getState().tabs.map(t => t.id), { width: 1440, height: 800 });
  surfaces.maximizeToTab(chatId);
  const retainedChat = useTabs.getState().tabs.find(t => t.id === chatId);
  const { result } = renderHook(() => useChatArtifactActions(null, makeDetail("running"), []));
  expect(result.current.openApp("apps/chart")).toBe(true);
  const appId = useTabs.getState().activeTabId!;
  expect(useDesktopSurfaces.getState().workspaceView).toBe("tabs");
  expect(useDesktopSurfaces.getState().surfaces[appId]?.mode).toBe("tab");
  expect(useDesktopSurfaces.getState().surfaces[chatId]?.mode).toBe("tab");
  expect(useTabs.getState().tabs.find(t => t.id === chatId)).toEqual(retainedChat);
});
it.each(["desktop", "canvas"] as const)("preserves window launches from a floating Chat in %s", (mode) => {
  useNativeDesktopMode.setState({ mode });
  const chatId = useTabs.getState().openTab({ kind: "chat", title: "Chat" });
  useDesktopSurfaces.getState().reconcileTabs([chatId], { width: 1440, height: 800 });
  const { result } = renderHook(() => useChatArtifactActions(null, makeDetail("running"), []));
  expect(result.current.openApp("apps/chart")).toBe(true);
  expect(useDesktopSurfaces.getState().workspaceView).toBe("desktop");
  expect(useDesktopSurfaces.getState().surfaces[chatId]?.mode).toBe("window");
});
