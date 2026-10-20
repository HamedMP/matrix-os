// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DesktopSurfaceFrame from "../../desktop/src/renderer/src/features/desktop-shell/DesktopSurfaceFrame";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";
import type { DesktopSurfaceMode } from "../../desktop/src/renderer/src/stores/desktop-surfaces";

const publishing = vi.hoisted(() => ({ client: { get: vi.fn(async () => null), getConfig: vi.fn(async () => ({ data: {}, forms: [] })) } }));
vi.mock("../../desktop/src/renderer/src/features/app-sites/site-client", () => ({ createDesktopSiteClient: () => publishing.client }));
vi.mock("../../desktop/src/renderer/src/lib/operator", () => ({
  invoke: vi.fn(async (channel: string) => channel === "embed:open" ? { embedId: "notes-embed", state: "ready" } : { ok: true }),
  onEvent: vi.fn(() => () => undefined),
}));
// Unrelated tab renderers are outside this app-publishing regression. The actual
// DesktopSurfaceFrame, TabPane, EmbedHost, publishing button and overlay store run.
vi.mock("../../desktop/src/renderer/src/features/workspace/TaskWorkspace", () => ({ default: () => null }));
vi.mock("../../desktop/src/renderer/src/features/terminal/TerminalView", () => ({ default: () => null }));
vi.mock("../../desktop/src/renderer/src/features/mission-control/HomeTab", () => ({ default: () => null }));
vi.mock("../../desktop/src/renderer/src/features/embeds/AppLauncher", () => ({ default: () => null }));
vi.mock("../../desktop/src/renderer/src/features/terminal/TerminalsTab", () => ({ default: () => null }));
vi.mock("../../desktop/src/renderer/src/features/files/FilesWorkspace", () => ({ default: () => null }));
vi.mock("../../desktop/src/renderer/src/features/work/WorkTab", () => ({ default: () => null }));
vi.mock("../../desktop/src/renderer/src/features/browser/BrowserTab", () => ({ default: () => null }));
vi.mock("../../desktop/src/renderer/src/features/editor/DesktopEditorWorkspace", () => ({ default: () => null }));
vi.mock("../../desktop/src/renderer/src/features/notes/NotesWorkspace", () => ({ default: () => null }));
vi.mock("../../desktop/src/renderer/src/features/chat/DesktopChatCollaboration", () => ({ default: () => null }));
vi.mock("../../desktop/src/renderer/src/features/settings/SettingsView", () => ({ default: () => null, SettingsSidebar: () => null, isSettingsSectionId: () => false }));
vi.mock("../../desktop/src/renderer/src/features/work/HostedWorkSidebar", () => ({ HostedWorkSidebar: () => null, HOSTED_WORK_SIDEBAR_WIDTH: 248 }));
vi.mock("../../desktop/src/renderer/src/features/terminal/DesktopSharedTerminal", () => ({ DesktopSharedTerminal: () => null }));

function ParentSurface({ presentation, mode, shown = true }: { presentation: "desktop" | "canvas"; mode: DesktopSurfaceMode; shown?: boolean }) {
  // MissionControl derives this same input from the real renderer overlay lease.
  const overlayOpen = useUi(state => state.rendererOverlayCount > 0);
  return <DesktopSurfaceFrame
    tab={{ id: "notes", kind: "app", title: "Notes", slug: "notes" }}
    surface={{ tabId: "notes", mode: shown ? mode : "minimized", restoreMode: mode === "tab" ? "tab" : "window", bounds: { x: 20, y: 20, width: 640, height: 480 }, zIndex: 1 }}
    active={shown} tabWorkspaceActive={mode === "tab"} overlayOpen={overlayOpen} presentation={presentation}
    onFocus={() => undefined} onClose={() => undefined} onMinimize={() => undefined}
    onMaximize={() => undefined} onBoundsChange={() => undefined}
  />;
}

beforeEach(() => {
  useConnection.setState(useConnection.getInitialState(), true);
  useUi.setState(useUi.getInitialState(), true);
  useConnection.setState({ runtimeSlot: "primary", api: {} as NonNullable<ReturnType<typeof useConnection.getState>["api"]> });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 20, y: 20, left: 20, top: 20, right: 660, bottom: 500, width: 640, height: 480, toJSON: () => ({}) } as DOMRect);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("app publishing through the owning desktop surface", () => {
  it.each([
    ["desktop", "tab"],
    ["desktop", "window"],
    ["canvas", "window"],
  ] as const)("keeps the %s %s publishing dialog mounted across its own overlay and closes it when hidden", async (presentation, mode) => {
    const view = render(<ParentSurface presentation={presentation} mode={mode} />);
    fireEvent.click(screen.getByRole("button", { name: "Publish app" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Publish app" })).not.toBeNull());
    expect(useUi.getState().rendererOverlayCount).toBe(1);
    // Preserve another surface's independent lease when this owner disappears.
    act(() => useUi.getState().acquireRendererOverlay());
    expect(useUi.getState().rendererOverlayCount).toBe(2);
    view.rerender(<ParentSurface presentation={presentation} mode={mode} shown={false} />);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Publish app" })).toBeNull());
    expect(useUi.getState().rendererOverlayCount).toBe(1);
    act(() => useUi.getState().releaseRendererOverlay());
    view.rerender(<ParentSurface presentation={presentation} mode={mode} />);
    expect(screen.queryByRole("dialog", { name: "Publish app" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Publish app" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Publish app" })).not.toBeNull());
    expect(useUi.getState().rendererOverlayCount).toBe(1);
    view.unmount();
    expect(useUi.getState().rendererOverlayCount).toBe(0);
  });
});
