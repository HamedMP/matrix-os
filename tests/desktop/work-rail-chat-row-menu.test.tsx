// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkRailChatRow } from "@desktop/renderer/src/features/work/work-rail/WorkRailChatRow";
import { canonicalChatRecord } from "./canonical-chat-workspace-test-utils";

afterEach(cleanup);

function setup() {
  const onSelect = vi.fn();
  const onPin = vi.fn();
  render(<WorkRailChatRow record={canonicalChatRecord} active={false} pinning={false} placement="recent"
    renaming={false} renamePending={false} renameDisabled={false} onSelect={onSelect}
    onRenameStart={vi.fn()} onRenameCommit={vi.fn()} onRenameCancel={vi.fn()}
    onPin={onPin} onDelete={vi.fn()} />);
  const title = screen.getByRole("button", { name: canonicalChatRecord.chat.title });
  const row = title.closest("[data-chat-title-row]")!;
  const trigger = screen.getByRole("button", { name: `Actions for ${canonicalChatRecord.chat.title}` });
  return { title, row, trigger, onSelect, onPin };
}

it.each(["Escape", "selection"])("reserves action space for the right-click menu until %s closure without opening the ellipsis dropdown", async (close) => {
  const { title, row, trigger, onSelect, onPin } = setup();
  expect(row.hasAttribute("data-menu-open")).toBe(false);
  fireEvent.contextMenu(title, { clientX: 120, clientY: 160 });
  const menu = await screen.findByRole("menu");
  expect(screen.getByRole("menuitem", { name: "Copy chat ID" })).toBeTruthy();
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(screen.getAllByRole("menu")).toHaveLength(1);
  expect(row.getAttribute("data-menu-open")).toBe("true");
  fireEvent.pointerLeave(row);
  expect(row.getAttribute("data-menu-open")).toBe("true");
  if (close === "Escape") fireEvent.keyDown(menu, { key: "Escape" });
  else fireEvent.click(screen.getByRole("menuitem", { name: "Pin" }));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(row.hasAttribute("data-menu-open")).toBe(false);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(onSelect).not.toHaveBeenCalled();
  expect(onPin).toHaveBeenCalledTimes(close === "selection" ? 1 : 0);

  // The separately controlled ellipsis remains usable after context-menu closure.
  fireEvent.keyDown(trigger, { key: "Enter" });
  await screen.findByRole("menu");
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(row.getAttribute("data-menu-open")).toBe("true");
  expect(screen.queryByRole("menuitem", { name: "Copy chat ID" })).toBeNull();
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(row.hasAttribute("data-menu-open")).toBe(false);
});
