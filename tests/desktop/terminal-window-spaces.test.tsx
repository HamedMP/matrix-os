// @vitest-environment jsdom
import React, { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AllSpacesRow, SpaceList, defaultSpaceColor, inOrder, type SpaceEntry,
} from "@desktop/renderer/src/features/terminal-window/SidebarSpaces";
import type { SpaceStyle } from "@desktop/renderer/src/features/terminal-window/use-sidebar-prefs";

// Hamed, 2026-11-22: Herdr's Spaces. Each machine is a space: one row with a colored letter (or
// icon) badge and its name; a computer's real projects sit under it behind a chevron that only
// machines with projects have. Choosing a row filters the terminals, "All" clears it; each row can
// be renamed, recolored, given an icon and reordered, as the viewer's own.
afterEach(cleanup);

function Host({ onFilter = vi.fn() }: { onFilter?: (id: string | null) => void }) {
  const [styles, setStyles] = useState<Record<string, SpaceStyle>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string[]>([]);
  const choose = (id: string | null) => { setSelected(id); onFilter(id); };
  const entry = (id: string, name: string, count: number, extra: Partial<SpaceEntry> = {}): SpaceEntry => ({
    id, name, count, selected: selected === id, available: true, onSelect: () => choose(id), ...extra,
  });
  const machines = inOrder([
    entry("local", "This Mac", 3),
    entry("computer:neo", "hamedmp", 4, {
      detail: "Main Computer · Available",
      expansion: {
        label: "hamedmp projects",
        content: <SpaceList label="hamedmp spaces" indent entries={[entry("computer:neo|web", "web", 2)]} styles={styles}
          expanded={expanded} onToggleExpanded={vi.fn()} onStyle={vi.fn()} onReorder={vi.fn()} />,
      },
    }),
    entry("ssh:box", "box", 1),
  ], (item) => item.id, order);
  return (
    <>
      <AllSpacesRow chosen={selected === null} count={8} onChoose={() => choose(null)} />
      <SpaceList label="Machines" entries={machines} styles={styles}
        expanded={expanded} onToggleExpanded={(id) => setExpanded((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id])}
        onStyle={(id, style) => setStyles((current) => { const next = { ...current }; if (style) next[id] = style; else delete next[id]; return next; })}
        onReorder={setOrder} />
    </>
  );
}

const machineButtons = () => within(screen.getByRole("list", { name: "Machines" })).getAllByRole("button")
  .filter((button) => button.hasAttribute("aria-pressed") && button.closest("ul")?.getAttribute("aria-label") === "Machines");
const names = () => machineButtons().map((button) => button.title.replace(/ \(.*\)$/, ""));
const openMenu = (label: string) => fireEvent.pointerDown(screen.getByRole("button", { name: `${label} options` }), { button: 0, ctrlKey: false });

describe("Terminal window Spaces", () => {
  it("shows each machine as a space with a lettered badge, filters on a click, and clears with All", () => {
    const onFilter = vi.fn();
    render(<Host onFilter={onFilter} />);
    expect(names()).toEqual(["This Mac", "hamedmp", "box"]);
    expect(machineButtons()[0]!.textContent).toBe("TThis Mac3");
    fireEvent.click(machineButtons()[1]!);
    expect(onFilter).toHaveBeenLastCalledWith("computer:neo");
    expect(machineButtons()[1]!.getAttribute("aria-pressed")).toBe("true");
    const all = screen.getByRole("button", { name: /^∗?All/ });
    fireEvent.click(all);
    expect(onFilter).toHaveBeenLastCalledWith(null);
    expect(all.getAttribute("aria-pressed")).toBe("true");
  });

  // Fault detected (Hamed, 2026-11-22): every machine showed a useless home/main row and a chevron.
  it("has no home or main rows, and a chevron only on a machine with projects", () => {
    render(<Host />);
    expect(screen.queryByText("home")).toBeNull();
    expect(screen.queryByText("main")).toBeNull();
    expect(screen.queryByRole("button", { name: /Show This Mac/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Show box/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show hamedmp projects" }));
    expect(within(screen.getByRole("list", { name: "hamedmp spaces" })).getByText("web")).toBeTruthy();
  });

  it("renames, recolors, gives an icon and reorders a machine from its menu", () => {
    render(<Host />);
    openMenu("hamedmp");
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
    const field = screen.getByRole("textbox", { name: "Space name" });
    fireEvent.change(field, { target: { value: "Main" } });
    fireEvent.submit(field.closest("form")!);
    expect(names()).toEqual(["This Mac", "Main", "box"]);

    openMenu("Main");
    fireEvent.click(screen.getByRole("menuitem", { name: "Red color" }));
    const badge = machineButtons()[1]!.querySelector("span[aria-hidden=true]") as HTMLElement;
    expect(badge.style.background).toBe("rgb(239, 68, 68)");

    openMenu("Main");
    fireEvent.click(screen.getByRole("menuitem", { name: "🚀 icon" }));
    expect(machineButtons()[1]!.textContent).toContain("🚀");

    openMenu("Main");
    fireEvent.click(screen.getByRole("menuitem", { name: "Move up" }));
    expect(names()[0]).toBe("Main");
  });

  it("opens the menu on a right-click and reorders by dragging", () => {
    render(<Host />);
    const rows = machineButtons().map((button) => button.parentElement as HTMLElement);
    fireEvent.contextMenu(rows[2]!);
    expect(screen.getByRole("menu", { name: "box options" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("menu", { name: "box options" }), { key: "Escape" });
    fireEvent.dragStart(rows[2]!);
    fireEvent.dragOver(rows[0]!);
    fireEvent.drop(rows[0]!);
    expect(names()).toEqual(["box", "This Mac", "hamedmp"]);
  });

  it("keeps a space's default color steady for its name", () => {
    expect(defaultSpaceColor("matrix-os")).toBe(defaultSpaceColor("matrix-os"));
  });
});
