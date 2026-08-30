// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TerminalSessionSidebar } from "../../desktop/src/renderer/src/features/terminal/TerminalSessionSidebar.js";

describe("TerminalSessionSidebar", () => {
  it("opens sessions from a non-squashing, scrollable list with active paths and no status dots", () => {
    const onSelect = vi.fn();
    const onCreate = vi.fn();
    const onDelete = vi.fn();
    const { container } = render(
      <TerminalSessionSidebar
        sessions={[
          { name: "swift-willow", status: "active", cwd: "projects/matrix-os", updatedAt: new Date(Date.now() - 5 * 60_000).toISOString() },
          { name: "quiet-pine", status: "exited" },
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
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: "swift-willow" }));
    expect(screen.getByText("5 minutes ago")).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for swift-willow" }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ name: "swift-willow" }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.getByText("~/projects/matrix-os")).toBeTruthy();
    expect(container.querySelector("[data-terminal-session-status]")).toBeNull();
    expect(screen.getByRole("list", { name: "Terminal sessions" }).className).toContain("overflow-y-auto");
    expect(screen.queryByRole("button", { name: "Shell theme" })).toBeNull();
  });
});
