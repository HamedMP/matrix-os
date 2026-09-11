// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DesktopEditorWorkspace from "@desktop/renderer/src/features/editor/DesktopEditorWorkspace";
import { useDesktopEditor } from "@desktop/renderer/src/features/editor/desktop-editor-store";
import { useConnection } from "@desktop/renderer/src/stores/connection";

vi.mock("@desktop/renderer/src/features/files/ComputerFileBrowser", () => ({
  default: ({ onOpenFile }: { onOpenFile?: (path: string) => void }) => (
    <button type="button" onClick={() => onOpenFile?.("projects/app/src/main.ts")}>Browse main.ts</button>
  ),
}));

vi.mock("@desktop/renderer/src/features/editor/MonacoEditorHost", () => ({
  default: ({ path, active }: { path: string; active: boolean }) => (
    <div data-active={String(active)}>Editing {path}</div>
  ),
}));

describe("DesktopEditorWorkspace", () => {
  beforeEach(() => {
    useDesktopEditor.setState(useDesktopEditor.getInitialState(), true);
    useConnection.setState(useConnection.getInitialState(), true);
    useConnection.setState({ runtimeSlot: "primary", authGeneration: 1 });
  });

  afterEach(() => cleanup());

  it("opens browser selections as retained Monaco tabs", async () => {
    render(<DesktopEditorWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: "Browse main.ts" }));

    expect(await screen.findByRole("tab", { name: "main.ts" })).toBeTruthy();
    const editor = screen.getByText("Editing projects/app/src/main.ts");
    expect(editor.getAttribute("data-active")).toBe("true");
    const retainedPane = editor.closest("[data-retained-pane]");
    expect(retainedPane?.className).toContain("absolute");
    expect(retainedPane?.className).toContain("inset-0");
    expect(retainedPane?.className).toContain("min-w-0");
  });

  it("clears open documents when the selected runtime identity changes", async () => {
    render(<DesktopEditorWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: "Browse main.ts" }));
    await screen.findByText("Editing projects/app/src/main.ts");

    act(() => useConnection.setState({ authGeneration: 2 }));

    await waitFor(() => expect(screen.queryByText("Editing projects/app/src/main.ts")).toBeNull());
    expect(screen.getByText("Choose a file to start editing.")).toBeTruthy();
  });
});
