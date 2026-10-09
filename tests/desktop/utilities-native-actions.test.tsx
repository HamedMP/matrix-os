// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import NativeDesktopShell from "@desktop/renderer/src/features/desktop-shell/NativeDesktopShell";
import Utilities from "../../home/apps/utilities/src/App";
import { useTabs } from "@desktop/renderer/src/stores/tabs";
import { useDesktopSurfaces } from "@desktop/renderer/src/stores/desktop-surfaces";
import { useDesktopAppDrawer } from "@desktop/renderer/src/stores/desktop-app-drawer";
import { useNativeDesktopMode } from "@desktop/renderer/src/stores/native-desktop-mode";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useUi } from "@desktop/renderer/src/stores/ui";
import { desktopQueryClient } from "@desktop/renderer/src/lib/query-client";
import { resetDesktopIconsRuntime, useDesktopIcons } from "@desktop/renderer/src/stores/desktop-icons";

vi.mock("../../home/apps/utilities/src/WorkspaceRouter", () => ({ WorkspaceRouter: () => <textarea aria-label="Draft"/> }));
vi.mock("@desktop/renderer/src/features/mission-control/TabContent", () => ({
  TabPane: ({ tab }: { tab: { slug?: string } }) => tab.slug === "utilities" ? <Utilities/> : <p>Other app content</p>,
  TabErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@desktop/renderer/src/features/onboarding/GettingStartedPopover", () => ({ default: () => null }));
let deliver!: (request: { requestId: string; type: "request" | "cancel" }) => void;
let resolveClose!: (reply: { ok: boolean }) => void;
beforeEach(() => {
  for (const store of [useTabs, useDesktopSurfaces, useDesktopAppDrawer, useNativeDesktopMode, useConnection, useUi, useDesktopIcons]) store.setState(store.getInitialState(), true);
  resetDesktopIconsRuntime(); desktopQueryClient.clear(); useNativeDesktopMode.setState({ hydrated: true });
  window.operator = {
    invoke: vi.fn(async channel => {
      if (channel === "state:get") return { value: { mode: "desktop" } };
      if (channel !== "embed:close-utilities") return { ok: true };
      const promise = new Promise<{ ok: boolean }>(resolve => { resolveClose = resolve; });
      deliver({ requestId: "native-request", type: "request" });
      return promise;
    }), on: () => () => undefined,
  };
  Object.defineProperty(window, "MatrixOS", { configurable: true, value: { utilitiesClose: {
    onCloseRequest: (listener: typeof deliver) => { deliver = listener; return () => undefined; },
    respondToClose: async (_id: string, allow: boolean) => { resolveClose({ ok: allow }); return { ok: true }; },
  } } });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => { cleanup(); Reflect.deleteProperty(window, "MatrixOS"); vi.restoreAllMocks(); });
it.each([true, false])("bulk close retains the same dirty Utilities view (Utilities first=%s)", async first => {
  const utility = () => useTabs.getState().openTab({ kind: "app", slug: "utilities", title: "Utilities" });
  const other = () => useTabs.getState().openTab({ kind: "settings", title: "Settings" });
  const id = first ? utility() : (other(), utility());
  if (first) other();
  render(<NativeDesktopShell overlayOpen={false}/>);
  fireEvent.click(screen.getByText("Word Counter", { selector: "strong" }).closest("button")!);
  const input = screen.getByLabelText("Draft") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "preserve this input" } });
  act(() => useDesktopAppDrawer.getState().setOpen(true));
  fireEvent.click(screen.getByRole("button", { name: "Close all open apps" }));
  expect(screen.getByRole("dialog", { name: "Close Utilities?" })).toBeTruthy();
  expect(useTabs.getState().tabs.map(tab => tab.id)).toEqual([id]);
  expect(useTabs.getState().activeTabId).toBe(id);
  expect(useDesktopSurfaces.getState().surfaces[id]?.mode).not.toBe("closed");
  fireEvent.click(screen.getByRole("button", { name: "Keep working" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Close Utilities?" })).toBeNull());
  expect(screen.getByLabelText("Draft")).toBe(input); expect(input.value).toBe("preserve this input");
  act(() => useDesktopAppDrawer.getState().setOpen(true));
  fireEvent.click(screen.getByRole("button", { name: "Close app drawer" }));
  expect(useTabs.getState().tabs.map(tab => tab.id)).toEqual([id]);
  act(() => useDesktopAppDrawer.getState().setOpen(true));
  fireEvent.click(screen.getByRole("button", { name: "Close all open apps" }));
  fireEvent.click(screen.getByRole("button", { name: "Close Utilities", exact: true }));
  await waitFor(() => expect(useTabs.getState().tabs).toHaveLength(0));
});
