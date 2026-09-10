// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TerminalSessionSidebar } from "../../desktop/src/renderer/src/features/terminal/TerminalSessionSidebar.js";

describe("TerminalSessionSidebar", () => {
  it("opens sessions from a non-squashing, scrollable list with status dots", () => {
    const stableRef = `tws_${"a".repeat(32)}:tt_${"1".repeat(32)}`;
    const secondRef = `tws_${"a".repeat(32)}:tt_${"2".repeat(32)}`;
    const onSelect = vi.fn();
    const onCreate = vi.fn();
    const onDelete = vi.fn();
    const { container } = render(
      <TerminalSessionSidebar
        sessions={[
          { name: stableRef, workspaceId: `tws_${"a".repeat(32)}`, tabId: `tt_${"1".repeat(32)}`, revision: 1, workspaceRevision: 1, cwd: "projects/matrix-os", subtitle: "swift-willow", status: "active", updatedAt: new Date(Date.now() - 5 * 60_000).toISOString() },
          { name: secondRef, workspaceId: `tws_${"a".repeat(32)}`, tabId: `tt_${"2".repeat(32)}`, revision: 1, workspaceRevision: 1, cwd: "", subtitle: "quiet-pine", status: "exited" },
        ]}
        selectedName={null}
        creating={false}
        disabled={false}
        onCreate={onCreate}
        onSelect={onSelect}
        onPin={vi.fn()}
        onDelete={onDelete}
      />,
    );

    expect(screen.getByRole("heading", { name: "Terminal" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New shell session" }));
    expect(onCreate).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Open swift-willow" }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: stableRef, subtitle: "swift-willow" }));
    expect(screen.queryByText(stableRef)).toBeNull();
    expect(screen.getByText("5 minutes ago")).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for swift-willow" }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ name: stableRef }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.getByText("~/projects/matrix-os")).toBeTruthy();
    expect(container.querySelector("[data-terminal-session-status]")).toBeNull();
    expect(screen.getByRole("list", { name: "Terminal sessions" }).className).toContain("overflow-y-auto");
    expect(screen.getByRole("button", { name: "Shell theme" })).toBeTruthy();
  });
});
