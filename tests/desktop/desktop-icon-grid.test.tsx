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
