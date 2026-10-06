// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { DesktopWindow } from "@/components/desktop/DesktopWindow";
import { CanvasWindow } from "@/components/canvas/CanvasWindow";
import { useWindowManager, type AppWindow } from "@/hooks/useWindowManager";
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ userId: "owner", sessionId: "session" }),
  useOrganization: () => ({ organization: null }),
}));
vi.mock("@/components/AppViewer", () => ({
  AppViewer: () => <div data-testid="generic-app-fallback" />,
}));
vi.mock("@/components/ChatApp", () => ({ ChatApp: () => null }));
vi.mock("@/components/terminal/TerminalApp", () => ({
  TerminalApp: () => null,
}));
vi.mock("@/components/file-browser/FileBrowser", () => ({
  FileBrowser: () => null,
}));
vi.mock("@/components/preview-window/PreviewWindow", () => ({
  PreviewWindow: () => null,
}));
vi.mock("@/components/system-activity/ActivityMonitorApp", () => ({
  ActivityMonitorApp: () => null,
}));
const win: AppWindow = {
  id: "memory-window",
  title: "Memory",
  path: "__memory-workspace__",
  x: 0,
  y: 0,
  width: 1000,
  height: 700,
  minimized: false,
  zIndex: 1,
};
const source = {
  id: "eddf57a7-5d85-4cdb-a7e6-3291a949d3ca",
  title: "Preview note",
  content: "Synthetic original source.",
  preview: "Synthetic original source.",
  kind: "note",
  collection: "Trial",
  revision: 1,
  occurredAt: null,
  updatedAt: "2026-10-05T12:00:00Z",
  ingestion: { hindsight: "ready", openviking: "ready" },
};
beforeEach(() => {
  useWindowManager.setState({
    windows: [win],
    focusedWindowId: win.id,
    fullscreenWindowId: null,
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.includes("/api/memory-workspace/sources/")
        ? Response.json({ source })
        : Response.json({
            sources: [source],
            totalSources: 1,
            filteredSources: 1,
            collections: [{ name: "Trial", count: 1 }],
            collectionsTruncated: false,
            hasMore: false,
            nextCursor: null,
            engines: [
              { id: "hindsight", status: "configured" },
              { id: "openviking", status: "configured" },
            ],
            jobs: [],
          }),
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("Memory app window parity", () => {
  it.each(["Web Desktop", "Web Canvas"] as const)(
    "%s renders the actual Library and reader instead of a generic app fallback",
    async (surface) => {
      const noop = vi.fn();
      render(
        surface === "Web Canvas" ? (
          <CanvasWindow win={win} />
        ) : (
          <DesktopWindow
            win={win}
            dockPosition="bottom"
            fullscreenWindowId={null}
            interacting={false}
            minimizingIds={new Set()}
            onAnimateMinimize={noop}
            onCloseWindow={noop}
            onDragEnd={noop}
            onDragMove={noop}
            onDragStart={noop}
            onFocusWindow={noop}
            onOpenWindow={noop}
            onResizeInteractionChange={noop}
            onToggleFullscreen={noop}
          />
        ),
      );
      expect(screen.queryByTestId("generic-app-fallback")).toBeNull();
      fireEvent.click(
        await screen.findByRole("button", { name: /Preview note/ }),
      );
      await screen.findByRole("heading", { name: "Preview note" });
      expect(screen.getByRole("button", { name: "Use in Chat" })).toBeTruthy();
      expect(
        screen.getByText("Synthetic original source.", { selector: "p" }),
      ).toBeTruthy();
    },
  );
});
