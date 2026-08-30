// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TerminalSessionSidebar } from "../../desktop/src/renderer/src/features/terminal/TerminalSessionSidebar.js";

describe("TerminalSessionSidebar", () => {
  it("opens sessions from a non-squashing, scrollable list with status dots", () => {
    const stableRef = `tws_${"a".repeat(32)}:tt_${"1".repeat(32)}`;
    const onSelect = vi.fn();
    const onCreate = vi.fn();
    const onDelete = vi.fn();
    const { container } = render(
      <TerminalSessionSidebar
        sessions={[
          { name: stableRef, subtitle: "swift-willow", status: "active", updatedAt: new Date(Date.now() - 5 * 60_000).toISOString() },
          { name: "quiet-pine", status: "exited" },
        ]}
        selectedName={null}
        creating={false}
        disabled={false}
        onCreate={onCreate}
        onSelect={onSelect}
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
    fireEvent.mouseEnter(screen.getByRole("button", { name: "Open swift-willow" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete swift-willow" }));
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ name: stableRef }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-terminal-session-status="active"]')).toBeTruthy();
    expect(container.querySelector('[data-terminal-session-status="inactive"]')).toBeTruthy();
    expect(screen.getByRole("list", { name: "Terminal sessions" }).className).toContain("overflow-y-auto");
    expect(screen.queryByRole("button", { name: "Shell theme" })).toBeNull();
  });
});
