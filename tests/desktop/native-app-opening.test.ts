// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { wireNativeAppOpening } from "../../desktop/src/renderer/src/lib/native-app-opening";
import { useNativeAppChatNavigation } from "../../desktop/src/renderer/src/features/chat/native-app-chat-navigation";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import { useDesktopSurfaces } from "../../desktop/src/renderer/src/stores/desktop-surfaces";
import type { EventPayload } from "../../desktop/src/shared/ipc-contract";

const native = vi.hoisted(() => ({ onEvent: vi.fn() }));
vi.mock("../../desktop/src/renderer/src/lib/operator", () => ({ invoke: vi.fn(), onEvent: native.onEvent }));
afterEach(() => {
  useTabs.setState(useTabs.getInitialState(), true);
  useDesktopSurfaces.setState(useDesktopSurfaces.getInitialState(), true);
  useConnection.setState(useConnection.getInitialState(), true);
  useNativeAppChatNavigation.setState(useNativeAppChatNavigation.getInitialState(), true);
  vi.restoreAllMocks(); vi.clearAllMocks();
});
it.each(["closed", "open", "minimized"] as const)("opens and queues native Chat recipes when Chat is %s", (state) => {
  useConnection.setState({ status: "signed-in", runtimeSlot: "primary", authGeneration: 7 });
  const workId = useTabs.getState().openTab({ kind: "work", title: "Chat", workRoute: "chat", closable: false });
  useDesktopSurfaces.getState().reconcileTabs([workId], { width: 1600, height: 1000 });
  if (state === "closed") useDesktopSurfaces.getState().closeSurface(workId);
  if (state === "minimized") useDesktopSurfaces.getState().minimizeSurface(workId);
  wireNativeAppOpening();
  const receive = native.onEvent.mock.calls.find(([channel]) => channel === "app:open-chat")![1] as
    (event: EventPayload<"app:open-chat">) => void;
  receive({ requestId: `request-${state}`, view: "recipes", recipeId: "company-brain", runtimeSlot: "primary", authGeneration: 7 });
  expect(useTabs.getState().activeTabId).toBe(workId);
  expect(useDesktopSurfaces.getState().surfaces[workId]?.mode).not.toBe("closed");
  expect(useDesktopSurfaces.getState().surfaces[workId]?.mode).not.toBe("minimized");
  expect(useNativeAppChatNavigation.getState().pending).toMatchObject({
    requestId: `request-${state}`,
    recipeId: "company-brain",
    targetTabId: workId,
  });
});
it("clears a queued Chat request when its runtime authority changes before Chat is ready", () => {
  useConnection.setState({ status: "signed-in", runtimeSlot: "primary", authGeneration: 7 });
  wireNativeAppOpening();
  const receive = native.onEvent.mock.calls.find(([channel]) => channel === "app:open-chat")![1] as
    (event: EventPayload<"app:open-chat">) => void;
  receive({ requestId: "request-runtime-switch", view: "recipes", recipeId: "company-brain", runtimeSlot: "primary", authGeneration: 7 });
  expect(useNativeAppChatNavigation.getState().pending?.requestId).toBe("request-runtime-switch");
  useConnection.setState({ runtimeSlot: "secondary", authGeneration: 8 });
  expect(useNativeAppChatNavigation.getState().pending).toBeNull();
});
it("clears the matching queued Chat request when main cancels revoked app authority", () => {
  useConnection.setState({ status: "signed-in", runtimeSlot: "primary", authGeneration: 7 });
  wireNativeAppOpening();
  const receive = native.onEvent.mock.calls.find(([channel]) => channel === "app:open-chat")![1] as
    (event: EventPayload<"app:open-chat">) => void;
  receive({ requestId: "request-app-navigation", view: "recipes", recipeId: "company-brain", runtimeSlot: "primary", authGeneration: 7 });
  const cancel = native.onEvent.mock.calls.find(([channel]) => channel === "app:open-chat-cancel")![1] as
    (event: { requestId: string }) => void;
  cancel({ requestId: "request-app-navigation" });
  expect(useNativeAppChatNavigation.getState().pending).toBeNull();
});
it("opens a normal installed-app tab only in the matching signed-in scope and removes its listener", () => {
  const cleanup = vi.fn(); native.onEvent.mockReturnValue(cleanup);
  const openTab = vi.fn(); useTabs.setState({ openTab });
  useConnection.setState({ status: "signed-in", runtimeSlot: "primary", authGeneration: 7 });
  const dispose = wireNativeAppOpening();
  const [channel, receive] = native.onEvent.mock.calls[0] as [string, (event: EventPayload<"app:open">) => void];
  expect(channel).toBe("app:open");
  const event = { slug: "planner", name: "Planner", appIdentity: "owner/planner", runtimeSlot: "primary", authGeneration: 7 };
  receive(event);
  expect(openTab).toHaveBeenCalledWith({ kind: "app", slug: "planner", title: "Planner", appIdentity: "owner/planner" });
  receive({ ...event, runtimeSlot: "other" }); receive({ ...event, authGeneration: 6 });
  useConnection.setState({ status: "signed-out" }); receive(event);
  expect(openTab).toHaveBeenCalledTimes(1);
  dispose(); expect(cleanup).toHaveBeenCalledTimes(3);
});

it.each([
  ["minimized", "window", "window", "desktop"],
  ["minimized", "tab", "tab", "tabs"],
  ["closed", "window", "window", "desktop"],
  ["closed", "tab", "window", "desktop"],
] as const)("restores an existing %s Cloud desktop from %s presentation", (mode, restoreMode, expectedMode, workspaceView) => {
  const browserId = useTabs.getState().openTab({ kind: "app", slug: "browser-lab", title: "Browser", appIdentity: "matrix-browser" });
  const cloudId = useTabs.getState().openTab({ kind: "app", slug: "browser-lab", title: "Cloud desktop", appIdentity: "matrix-cloud-desktop" });
  const surfaces = useDesktopSurfaces.getState();
  surfaces.reconcileTabs([browserId, cloudId], { width: 1600, height: 1000 });
  const bounds = { x: 83, y: 91, width: 920, height: 710 };
  surfaces.setSurfaceBounds(cloudId, bounds, { width: 1600, height: 1000 });
  if (restoreMode === "tab") surfaces.maximizeToTab(cloudId);
  if (mode === "minimized") surfaces.minimizeSurface(cloudId);
  else surfaces.closeSurface(cloudId);
  surfaces.maximizeToTab(browserId);
  useTabs.getState().focusTab(browserId);
  useConnection.setState({ status: "signed-in", runtimeSlot: "pr-2526", authGeneration: 7 });
  wireNativeAppOpening();
  const receive = native.onEvent.mock.calls[0]![1] as (event: EventPayload<"app:open">) => void;
  const request = { slug: "browser-lab", name: "Cloud desktop", appIdentity: "matrix-cloud-desktop", runtimeSlot: "pr-2526", authGeneration: 7 };
  const before = useDesktopSurfaces.getState();
  receive({ ...request, runtimeSlot: "primary" });
  receive({ ...request, authGeneration: 6 });
  expect(useTabs.getState().activeTabId).toBe(browserId);
  expect(useDesktopSurfaces.getState()).toBe(before);
  receive(request);
  expect(useTabs.getState().activeTabId).toBe(cloudId);
  expect(useTabs.getState().tabs).toHaveLength(2);
  expect(useDesktopSurfaces.getState().surfaces[cloudId]).toMatchObject({ mode: expectedMode, bounds });
  expect(useDesktopSurfaces.getState().workspaceView).toBe(workspaceView);
});

it("lets the normal shell reconciliation create a newly opened native app surface", () => {
  useConnection.setState({ status: "signed-in", runtimeSlot: "pr-2526", authGeneration: 7 });
  wireNativeAppOpening();
  const receive = native.onEvent.mock.calls[0]![1] as (event: EventPayload<"app:open">) => void;
  receive({ slug: "browser-lab", name: "Cloud desktop", appIdentity: "matrix-cloud-desktop", runtimeSlot: "pr-2526", authGeneration: 7 });
  const id = useTabs.getState().activeTabId!;
  expect(useDesktopSurfaces.getState().surfaces[id]).toBeUndefined();
  useDesktopSurfaces.getState().reconcileTabs([id], { width: 1600, height: 1000 });
  expect(useDesktopSurfaces.getState().surfaces[id]?.mode).toBe("window");
});
