// @vitest-environment jsdom
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Shared mock of the file-browser zustand store: the XP desktop icons reuse
// the store's navigation/view-request actions, so the Recycle Bin lands in
// the trash view exactly like the explorer's own Trash link and My Computer /
// My Documents land on the home folder.
const store = vi.hoisted(() => ({
  navigate: vi.fn(),
  requestView: vi.fn(),
  pendingView: null as "files" | "trash" | null,
  consumeViewRequest: vi.fn(),
}));

vi.mock("@/hooks/useFileBrowser", () => ({
  useFileBrowser: (selector: (value: typeof store) => unknown) => selector(store),
}));

import { XpDesktopIcons } from "../../shell/src/components/desktop/XpDesktopIcons.js";

function setDesign(style: string) {
  document.documentElement.setAttribute("data-theme-style", style);
}

// The useThemeStyle hook mirrors data-theme-style via an effect + a
// MutationObserver whose callbacks are microtasks; flush both inside act.
async function renderIcons(onOpenApp = vi.fn()) {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<XpDesktopIcons onOpenApp={onOpenApp} />);
    await Promise.resolve();
  });
  return { ...result, onOpenApp };
}

describe("XpDesktopIcons", () => {
  // Reset before (not after) each test, mirroring windows-taskbar.test.tsx:
  // removing the attribute while icons are still mounted would fire
  // useThemeStyle's MutationObserver outside act().
  beforeEach(() => {
    vi.clearAllMocks();
    document.documentElement.removeAttribute("data-theme-style");
    store.pendingView = null;
  });

  it("renders nothing for non-XP designs", async () => {
    for (const style of ["flat", "neumorphic", "macos-glass", "win11"]) {
      setDesign(style);
      const { container, unmount } = await renderIcons();
      expect(container.innerHTML).toBe("");
      unmount();
    }
  });

  it("renders My Computer, My Documents and Recycle Bin under winxp", async () => {
    setDesign("winxp");
    const { container } = await renderIcons();

    expect(container.querySelector("[data-xp-desktop-icons]")).toBeTruthy();
    expect(screen.getByRole("button", { name: "My Computer" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "My Documents" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Recycle Bin" })).toBeTruthy();
  });

  it("opens the Files app at the home location via the taskbar handler on My Computer double-click", async () => {
    setDesign("winxp");
    const onOpenApp = vi.fn();
    await renderIcons(onOpenApp);

    fireEvent.doubleClick(screen.getByRole("button", { name: "My Computer" }));

    expect(onOpenApp).toHaveBeenCalledWith("__file-browser__", "Files");
    expect(store.navigate).toHaveBeenCalledWith("");
    expect(store.requestView).toHaveBeenCalledWith("files");
  });

  it("opens the Files app via the same handler on My Documents double-click", async () => {
    setDesign("winxp");
    const onOpenApp = vi.fn();
    await renderIcons(onOpenApp);

    fireEvent.doubleClick(screen.getByRole("button", { name: "My Documents" }));

    expect(onOpenApp).toHaveBeenCalledWith("__file-browser__", "Files");
    expect(store.navigate).toHaveBeenCalledWith("");
    expect(store.requestView).toHaveBeenCalledWith("files");
  });

  it("requests the trash view before opening Files on Recycle Bin double-click", async () => {
    setDesign("winxp");
    const onOpenApp = vi.fn();
    await renderIcons(onOpenApp);

    fireEvent.doubleClick(screen.getByRole("button", { name: "Recycle Bin" }));

    expect(store.requestView).toHaveBeenCalledWith("trash");
    expect(store.navigate).not.toHaveBeenCalled();
    expect(onOpenApp).toHaveBeenCalledWith("__file-browser__", "Files");
  });

  it("single-click selects an icon without opening it, and moves the selection between icons", async () => {
    setDesign("winxp");
    const onOpenApp = vi.fn();
    await renderIcons(onOpenApp);

    const computer = screen.getByRole("button", { name: "My Computer" });
    fireEvent.click(computer);
    expect(computer.getAttribute("data-selected")).toBe("true");
    expect(onOpenApp).not.toHaveBeenCalled();

    const documents = screen.getByRole("button", { name: "My Documents" });
    fireEvent.click(documents);
    expect(documents.getAttribute("data-selected")).toBe("true");
    expect(computer.getAttribute("data-selected")).toBeNull();
    expect(onOpenApp).not.toHaveBeenCalled();
  });

  it("Enter opens the selected icon, arrows move the selection, Escape clears it", async () => {
    setDesign("winxp");
    const onOpenApp = vi.fn();
    await renderIcons(onOpenApp);

    const computer = screen.getByRole("button", { name: "My Computer" });
    computer.focus();
    fireEvent.keyDown(computer, { key: "ArrowDown" });

    const documents = screen.getByRole("button", { name: "My Documents" });
    expect(documents.getAttribute("data-selected")).toBe("true");
    expect(document.activeElement).toBe(documents);

    fireEvent.keyDown(documents, { key: "ArrowDown" });
    const recycleBin = screen.getByRole("button", { name: "Recycle Bin" });
    expect(recycleBin.getAttribute("data-selected")).toBe("true");
    expect(document.activeElement).toBe(recycleBin);

    fireEvent.keyDown(recycleBin, { key: "Enter" });
    expect(store.requestView).toHaveBeenCalledWith("trash");
    expect(onOpenApp).toHaveBeenCalledWith("__file-browser__", "Files");

    fireEvent.keyDown(recycleBin, { key: "Escape" });
    expect(recycleBin.getAttribute("data-selected")).toBeNull();
  });

  it("ArrowUp from the top icon keeps the first icon selected", async () => {
    setDesign("winxp");
    await renderIcons();

    const computer = screen.getByRole("button", { name: "My Computer" });
    fireEvent.click(computer);
    fireEvent.keyDown(computer, { key: "ArrowUp" });

    expect(computer.getAttribute("data-selected")).toBe("true");
  });

  it("clears the selection on pointer down outside the icons", async () => {
    setDesign("winxp");
    await renderIcons();

    const computer = screen.getByRole("button", { name: "My Computer" });
    fireEvent.click(computer);
    expect(computer.getAttribute("data-selected")).toBe("true");

    fireEvent.pointerDown(document.body);
    expect(computer.getAttribute("data-selected")).toBeNull();
  });
});
