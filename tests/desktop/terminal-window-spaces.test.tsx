// @vitest-environment jsdom
import React, { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AllSpacesRow, SpaceRows, defaultSpaceColor, orderedSpaces, type SpaceItem,
} from "@desktop/renderer/src/features/terminal-window/SidebarSpaces";
import type { SpaceStyle } from "@desktop/renderer/src/features/terminal-window/use-sidebar-prefs";

// Hamed, 2026-11-22: Herdr's Spaces. A machine's spaces as compact rows with a colored letter
// avatar; choosing one filters the terminals, "All" clears it; each can be renamed, recolored,
// given an icon and reordered, as the viewer's own.
afterEach(cleanup);

function Host({ onFilter = vi.fn() }: { onFilter?: (item: SpaceItem | null) => void }) {
  const [styles, setStyles] = useState<Record<string, SpaceStyle>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string[]>([]);
  const items = orderedSpaces([{ space: "matrix-os", count: 3 }, { space: "chat", count: 2 }, { space: "pipeline", count: 1 }], "vps", order);
  return (
    <>
      <AllSpacesRow chosen={selected === null} count={6} onChoose={() => { setSelected(null); onFilter(null); }} />
      <SpaceRows machineName="vps" items={items} styles={styles} selected={selected}
        onSelect={(item) => { setSelected(item.id); onFilter(item); }}
        expanded={expanded} onToggleExpanded={(id) => setExpanded((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id])}
        renderTerminals={(item) => <ul aria-label={`${item.space} terminals`}><li>terminal in {item.space}</li></ul>}
        onStyle={(id, style) => setStyles((current) => { const next = { ...current }; if (style) next[id] = style; else delete next[id]; return next; })}
        onReorder={setOrder} />
    </>
  );
}

const spaceButtons = () => within(screen.getByRole("list", { name: "vps spaces" })).getAllByRole("button").filter((button) => button.hasAttribute("aria-pressed"));
const names = () => spaceButtons().map((button) => button.textContent?.replace(/\d+$/, "").slice(1));
const rowItems = () => within(screen.getByRole("list", { name: "vps spaces" })).getAllByRole("listitem").filter((item) => item.parentElement?.getAttribute("aria-label") === "vps spaces");
const openMenu = (label: string) => fireEvent.pointerDown(screen.getByRole("button", { name: `${label} options` }), { button: 0, ctrlKey: false });

describe("Terminal window Spaces", () => {
  it("shows each space with a lettered avatar and count, filters on a click, and clears with All", () => {
    const onFilter = vi.fn();
    render(<Host onFilter={onFilter} />);
    expect(names()).toEqual(["matrix-os", "chat", "pipeline"]);
    expect(spaceButtons()[0]!.textContent).toBe("Mmatrix-os3");
    fireEvent.click(spaceButtons()[1]!);
    expect(onFilter).toHaveBeenLastCalledWith(expect.objectContaining({ space: "chat" }));
    expect(spaceButtons()[1]!.getAttribute("aria-pressed")).toBe("true");
    const all = screen.getByRole("button", { name: /All/ });
    expect(all.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(all);
    expect(onFilter).toHaveBeenLastCalledWith(null);
    expect(all.getAttribute("aria-pressed")).toBe("true");
  });

  it("renames, recolors, gives an icon and reorders a space from its menu", () => {
    render(<Host />);
    openMenu("chat");
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
    const field = screen.getByRole("textbox", { name: "Space name" });
    fireEvent.change(field, { target: { value: "Chat app" } });
    fireEvent.submit(field.closest("form")!);
    expect(names()).toEqual(["matrix-os", "Chat app", "pipeline"]);

    openMenu("Chat app");
    fireEvent.click(screen.getByRole("menuitem", { name: "Red color" }));
    const avatar = spaceButtons()[1]!.querySelector("span[aria-hidden=true]") as HTMLElement;
    expect(avatar.style.background).toBe("rgb(239, 68, 68)");

    openMenu("Chat app");
    fireEvent.click(screen.getByRole("menuitem", { name: "🚀 icon" }));
    expect(spaceButtons()[1]!.textContent).toContain("🚀");

    openMenu("Chat app");
    fireEvent.click(screen.getByRole("menuitem", { name: "Move up" }));
    expect(names()[0]).toContain("Chat app");
  });

  it("opens the menu on a right-click and reorders by dragging", () => {
    render(<Host />);
    const rows = rowItems().map((item) => item.firstElementChild as HTMLElement);
    fireEvent.contextMenu(rows[2]!);
    expect(screen.getByRole("menu", { name: "pipeline options" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("menu", { name: "pipeline options" }), { key: "Escape" });
    fireEvent.dragStart(rows[2]!);
    fireEvent.dragOver(rows[0]!);
    fireEvent.drop(rows[0]!);
    expect(names()).toEqual(["pipeline", "matrix-os", "chat"]);
  });

  // Hamed, 2026-11-22: the chevron only lists a space's terminals inline; it never filters.
  it("lists a space's terminals inline from its chevron without making it active", () => {
    const onFilter = vi.fn();
    render(<Host onFilter={onFilter} />);
    fireEvent.click(screen.getByRole("button", { name: "Show chat terminals" }));
    expect(screen.getByRole("list", { name: "chat terminals" }).textContent).toBe("terminal in chat");
    expect(onFilter).not.toHaveBeenCalled();
    expect(spaceButtons().every((button) => button.getAttribute("aria-pressed") === "false")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Hide chat terminals" }));
    expect(screen.queryByRole("list", { name: "chat terminals" })).toBeNull();
  });

  it("keeps a space's default color steady for its name", () => {
    expect(defaultSpaceColor("matrix-os")).toBe(defaultSpaceColor("matrix-os"));
  });
});
