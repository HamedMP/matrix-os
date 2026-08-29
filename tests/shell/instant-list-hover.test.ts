import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

const webListSurfaces = [
  "shell/src/components/ChatApp.tsx",
  "shell/src/components/ChatPopover.tsx",
  "shell/src/components/AppTile.tsx",
  "shell/src/components/desktop/WebDesktopHeader.tsx",
  "shell/src/components/desktop/WebDesktopSurface.tsx",
  "shell/src/components/preview-window/PreviewWindow.tsx",
  "shell/src/components/terminal/TerminalSidebarItems.tsx",
  "shell/src/components/terminal/DesktopTerminalSidebar.tsx",
  "shell/src/components/file-browser/FileBrowserSidebar.tsx",
  "shell/src/components/file-browser/FileIcon.tsx",
  "shell/src/components/file-browser/ListView.tsx",
  "shell/src/components/file-browser/ColumnView.tsx",
  "shell/src/components/file-browser/SearchResults.tsx",
  "shell/src/components/file-browser/TrashView.tsx",
] as const;

const desktopListSurfaces = [
  "desktop/src/renderer/src/features/mission-control/SidebarPrimitives.tsx",
  "desktop/src/renderer/src/features/mission-control/ProjectSidebarRow.tsx",
  "desktop/src/renderer/src/features/mission-control/RecentViews.tsx",
  "desktop/src/renderer/src/features/chat/HermesConversationIndex.tsx",
  "desktop/src/renderer/src/features/chat/ConversationContextPicker.tsx",
  "desktop/src/renderer/src/features/chat/ProviderModelPicker.tsx",
  "desktop/src/renderer/src/features/terminal/TerminalSessionSidebar.tsx",
  "desktop/src/renderer/src/features/files/browser-views.tsx",
  "desktop/src/renderer/src/features/files/QuickOpen.tsx",
  "desktop/src/renderer/src/features/settings/SettingsView.tsx",
  "desktop/src/renderer/src/features/project/ProjectThreadList.tsx",
  "desktop/src/renderer/src/features/project/ProjectOverview.tsx",
  "desktop/src/renderer/src/features/desktop-shell/DesktopIconGrid.tsx",
  "desktop/src/renderer/src/features/runtime/RuntimeComputerMenu.tsx",
] as const;

describe("instant OS list hover", () => {
  it.each([
    "shell/src/app/globals.css",
    "desktop/src/renderer/src/design/index.css",
  ])("defines a zero-latency hover transition contract in %s", (path) => {
    const css = read(path);
    const rule = css.match(/\[data-instant-list-hover\]\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(rule).toContain("transition: none !important");
  });

  it("does not let the native hover contract override selected row fills", () => {
    const css = read("desktop/src/renderer/src/design/index.css");
    const hoverRule =
      css.match(/\[data-instant-list-hover\]:hover\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(hoverRule).not.toContain("background");
  });

  it.each(webListSurfaces)("opts the web OS list surface into instant hover: %s", (path) => {
    expect(read(path)).toContain("data-instant-list-hover");
  });

  it.each(desktopListSurfaces)("opts the native desktop list surface into instant hover: %s", (path) => {
    expect(read(path)).toContain("data-instant-list-hover");
  });

  it("keeps Terminal card drag motion while removing delayed highlight paint", () => {
    const css = read("shell/src/app/globals.css");
    const terminalRule = css.match(
      /\.terminal-session-card\[data-instant-list-hover\]\s*\{([^}]*)\}/,
    )?.[1] ?? "";

    expect(terminalRule).toContain("opacity 120ms ease");
    expect(terminalRule).toContain("transform 150ms ease");
    expect(terminalRule).not.toContain("background-color");
    expect(css).toMatch(
      /\.terminal-session-card\[data-instant-list-hover\]:hover\s*\{[^}]*background:\s*var\(--terminal-drawer-card-bg\)\s*!important/,
    );
  });
});
