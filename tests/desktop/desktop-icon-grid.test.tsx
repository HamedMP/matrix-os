// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { MessageSquare } from "@desktop/renderer/src/lib/hugeicons";
import DesktopIconGrid from "@desktop/renderer/src/features/desktop-shell/DesktopIconGrid";

it("removes a Desktop icon from its context menu", () => {
  const onRemove = vi.fn();
  render(
    <DesktopIconGrid
      destinations={[{
        id: "work",
        path: "__chat__",
        kind: "work",
        icon: MessageSquare,
        name: "Chat",
        open: vi.fn(),
      }]}
      placements={[{ path: "__chat__", x: 20, y: 20 }]}
      onMove={vi.fn()}
      onRemove={onRemove}
    />,
  );

  fireEvent.contextMenu(screen.getByRole("button", { name: "Chat" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Remove Chat from Desktop" }));

  expect(onRemove).toHaveBeenCalledWith("__chat__");
});

it("shows packaged artwork on the Desktop without adding a square tile", () => {
  render(
    <DesktopIconGrid
      destinations={[{
        id: "work", path: "__chat__", kind: "work", icon: MessageSquare,
        iconUrl: "/icons/chat.png", name: "Chat", open: vi.fn(),
      }]}
      placements={[{ path: "__chat__", x: 20, y: 20 }]}
      onMove={vi.fn()}
      onRemove={vi.fn()}
    />,
  );

  const tile = screen.getByRole("button", { name: "Chat" });
  expect(tile.querySelector("img")?.getAttribute("src")).toBe("/icons/chat.png");
  expect(tile.querySelector("img")?.className).toContain("object-contain");
  expect(tile.querySelector("[data-desktop-app-icon]")).toBeNull();
});
