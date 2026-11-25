// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import React, { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Ribbon, type RibbonTab } from "../../../home/apps/_shared/office-ui";

afterEach(cleanup);

function makeTabs(spies: Record<string, ReturnType<typeof vi.fn>>, bold = false): RibbonTab[] {
  return [
    {
      id: "file",
      label: "File",
      mode: "backstage",
      backstage: { items: [{ id: "new", label: "New", render: () => <p>Blank document</p> }] },
    },
    {
      id: "home",
      label: "Home",
      groups: [
        {
          id: "clipboard",
          label: "Clipboard",
          items: [
            {
              kind: "split",
              id: "paste",
              label: "Paste",
              size: "large",
              shortcut: "Ctrl+V",
              onClick: spies.paste,
              menu: [
                { id: "paste-text", label: "Paste as plain text" },
                { id: "paste-link", label: "Paste as link" },
              ],
              onMenuSelect: spies.pasteMenu,
            },
            {
              kind: "stack",
              id: "clip-stack",
              rows: [
                [{ kind: "button", id: "cut", label: "Cut", shortcut: "Ctrl+X", onClick: spies.cut }],
                [{ kind: "button", id: "copy", label: "Copy", shortcut: "Ctrl+C", onClick: spies.copy }],
              ],
            },
          ],
        },
        {
          id: "font",
          label: "Font",
          items: [
            {
              kind: "select",
              id: "family",
              label: "Font",
              value: "Inter",
              options: [
                { value: "Inter", label: "Inter" },
                { value: "Georgia", label: "Georgia" },
              ],
              onChange: spies.family,
            },
            { kind: "toggle", id: "bold", label: "Bold", shortcut: "Ctrl+B", pressed: bold, onToggle: spies.bold, icon: <b>B</b>, showLabel: false },
            { kind: "separator", id: "sep" },
            { kind: "toggle", id: "italic", label: "Italic", shortcut: "Ctrl+I", pressed: false, onToggle: spies.italic, icon: <i>I</i>, showLabel: false },
          ],
          launcher: { label: "Font settings", onClick: spies.launcher },
        },
      ],
    },
    {
      id: "insert",
      label: "Insert",
      groups: [
        {
          id: "tables",
          label: "Tables",
          items: [
            { kind: "menu", id: "table", label: "Table", size: "large", menu: [{ id: "2x2", label: "2 by 2 table" }], onMenuSelect: spies.table },
          ],
        },
      ],
    },
  ];
}

function Harness({ spies, initialCollapsed = false }: { spies: Record<string, ReturnType<typeof vi.fn>>; initialCollapsed?: boolean }) {
  const [active, setActive] = useState("home");
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [bold, setBold] = useState(false);
  const tabs = makeTabs({ ...spies, bold: vi.fn((next: boolean) => { spies.bold(next); setBold(next); }) }, bold);
  return (
    <>
      <Ribbon
        tabs={tabs}
        activeTab={active}
        onTabChange={(id) => { spies.tab(id); setActive(id); }}
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((value) => !value)}
        leading={<span>Lead</span>}
        trailing={<button type="button">Share</button>}
      />
      <textarea aria-label="Document" />
    </>
  );
}

function spies() {
  return {
    paste: vi.fn(), pasteMenu: vi.fn(), cut: vi.fn(), copy: vi.fn(), family: vi.fn(),
    bold: vi.fn(), italic: vi.fn(), table: vi.fn(), tab: vi.fn(), launcher: vi.fn(),
  };
}

describe("Ribbon tabs", () => {
  it("renders a tab row with the active tab's groups and labels underneath", () => {
    render(<Harness spies={spies()} />);
    const tablist = screen.getByRole("tablist", { name: "Ribbon" });
    expect(within(tablist).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["File", "Home", "Insert"]);
    const home = screen.getByRole("tab", { name: "Home" });
    expect(home.getAttribute("aria-selected")).toBe("true");
    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe(home.id);
    expect(within(panel).getByRole("group", { name: "Clipboard" })).toBeTruthy();
    expect(within(panel).getByRole("group", { name: "Font" })).toBeTruthy();
    expect(screen.getByText("Lead")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Share" })).toBeTruthy();
  });

  it("switches tabs on click", () => {
    const s = spies();
    render(<Harness spies={s} />);
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    expect(s.tab).toHaveBeenCalledWith("insert");
    expect(screen.getByRole("group", { name: "Tables" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Clipboard" })).toBeNull();
  });

  it("moves focus across tabs with a roving tabindex and activates with Enter", () => {
    const s = spies();
    render(<Harness spies={s} />);
    const home = screen.getByRole("tab", { name: "Home" });
    const insert = screen.getByRole("tab", { name: "Insert" });
    const file = screen.getByRole("tab", { name: "File" });
    expect(home.tabIndex).toBe(0);
    expect(insert.tabIndex).toBe(-1);
    home.focus();
    fireEvent.keyDown(home, { key: "ArrowRight" });
    expect(document.activeElement).toBe(insert);
    expect(insert.tabIndex).toBe(0);
    expect(home.tabIndex).toBe(-1);
    fireEvent.keyDown(insert, { key: "ArrowRight" });
    expect(document.activeElement).toBe(file);
    fireEvent.keyDown(file, { key: "End" });
    expect(document.activeElement).toBe(insert);
    fireEvent.keyDown(insert, { key: "Enter" });
    expect(s.tab).toHaveBeenCalledWith("insert");
  });

  it("moves into the panel with ArrowDown and keeps one tab stop per group", () => {
    render(<Harness spies={spies()} />);
    const home = screen.getByRole("tab", { name: "Home" });
    home.focus();
    fireEvent.keyDown(home, { key: "ArrowDown" });
    const paste = screen.getByRole("button", { name: "Paste" });
    expect(document.activeElement).toBe(paste);
    expect(paste.tabIndex).toBe(0);
    expect(screen.getByRole("button", { name: "Copy" }).tabIndex).toBe(-1);
    const font = screen.getByRole("group", { name: "Font" });
    const buttonStops = Array.from(font.querySelectorAll<HTMLElement>("button")).filter((el) => el.tabIndex === 0);
    expect(buttonStops.map((el) => el.getAttribute("aria-label") ?? el.textContent)).toEqual(["Bold"]);
    // Arrow keys edit a field, so it keeps its own tab stop and never traps the group's buttons.
    expect(screen.getByRole("combobox", { name: "Font" }).tabIndex).toBe(0);
  });

  it("moves with arrow keys within a group", () => {
    render(<Harness spies={spies()} />);
    const bold = screen.getByRole("button", { name: "Bold" });
    const italic = screen.getByRole("button", { name: "Italic" });
    bold.focus();
    fireEvent.keyDown(bold, { key: "ArrowRight" });
    expect(document.activeElement).toBe(italic);
    expect(italic.tabIndex).toBe(0);
    expect(bold.tabIndex).toBe(-1);
    fireEvent.keyDown(italic, { key: "Home" });
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Font" }));
  });

  it("gives every control a name and a tooltip with its shortcut", () => {
    render(<Harness spies={spies()} />);
    const copy = screen.getByRole("button", { name: "Copy" });
    expect(copy.getAttribute("title")).toBe("Copy (Ctrl+C)");
    expect(copy.getAttribute("aria-keyshortcuts")).toBe("Ctrl+C");
    expect(screen.getByRole("button", { name: "Bold" }).getAttribute("title")).toBe("Bold (Ctrl+B)");
    expect(screen.getByRole("combobox", { name: "Font" }).getAttribute("title")).toBe("Font");
  });
});

describe("Ribbon items", () => {
  it("fires buttons, toggles and selects", () => {
    const s = spies();
    render(<Harness spies={s} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(s.copy).toHaveBeenCalledTimes(1);
    const bold = screen.getByRole("button", { name: "Bold" });
    expect(bold.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(bold);
    expect(s.bold).toHaveBeenCalledWith(true);
    expect(screen.getByRole("button", { name: "Bold" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(screen.getByRole("combobox", { name: "Font" }), { target: { value: "Georgia" } });
    expect(s.family).toHaveBeenCalledWith("Georgia");
    fireEvent.click(screen.getByRole("button", { name: "Font settings" }));
    expect(s.launcher).toHaveBeenCalledTimes(1);
  });

  it("runs a split button's primary action and its menu items", () => {
    const s = spies();
    render(<Harness spies={s} />);
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));
    expect(s.paste).toHaveBeenCalledTimes(1);
    const arrow = screen.getByRole("button", { name: "Paste options" });
    expect(arrow.getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.click(arrow);
    const menu = screen.getByRole("menu", { name: "Paste options" });
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Paste as plain text" }));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Paste as link" }));
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Paste as link" }));
    expect(s.pasteMenu).toHaveBeenCalledWith("paste-link");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(arrow);
  });

  it("closes a menu on Escape and returns focus, and toggles it from the same button", () => {
    const s = spies();
    render(<Harness spies={s} />);
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    const table = screen.getByRole("button", { name: "Table" });
    fireEvent.click(table);
    expect(table.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(table);
    fireEvent.click(table);
    fireEvent.click(table);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(table);
    fireEvent.click(screen.getByRole("menuitem", { name: "2 by 2 table" }));
    expect(s.table).toHaveBeenCalledWith("2x2");
  });
});

describe("Ribbon collapse", () => {
  it("collapses on double-click and from the chevron, keeping only the tabs", () => {
    render(<Harness spies={spies()} />);
    fireEvent.doubleClick(screen.getByRole("tab", { name: "Home" }));
    expect(screen.queryByRole("tabpanel")).toBeNull();
    const expand = screen.getByRole("button", { name: "Pin the ribbon" });
    fireEvent.click(expand);
    expect(screen.getByRole("tabpanel")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Collapse the ribbon" }));
    expect(screen.queryByRole("tabpanel")).toBeNull();
  });

  it("shows the ribbon as an overlay after a tab click until focus leaves", () => {
    const s = spies();
    render(<Harness spies={s} initialCollapsed />);
    expect(screen.queryByRole("tabpanel")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    const panel = screen.getByRole("tabpanel");
    expect(panel.className).toContain("is-overlay");
    const table = screen.getByRole("button", { name: "Table" });
    table.focus();
    const doc = screen.getByRole("textbox", { name: "Document" });
    act(() => {
      fireEvent.focusOut(table, { relatedTarget: doc });
    });
    expect(screen.queryByRole("tabpanel")).toBeNull();
  });

  it("keeps the overlay while focus moves into its menus, and closes it on Escape", () => {
    render(<Harness spies={spies()} initialCollapsed />);
    const insert = screen.getByRole("tab", { name: "Insert" });
    fireEvent.click(insert);
    const table = screen.getByRole("button", { name: "Table" });
    fireEvent.click(table);
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByRole("tabpanel")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.getByRole("tabpanel")).toBeTruthy();
    fireEvent.keyDown(table, { key: "Escape" });
    expect(screen.queryByRole("tabpanel")).toBeNull();
    expect(document.activeElement).toBe(insert);
  });

  it("closes the overlay when the open tab is clicked again or the pointer goes down outside", () => {
    render(<Harness spies={spies()} initialCollapsed />);
    const home = screen.getByRole("tab", { name: "Home" });
    fireEvent.click(home);
    expect(screen.getByRole("tabpanel")).toBeTruthy();
    fireEvent.click(home);
    expect(screen.queryByRole("tabpanel")).toBeNull();
    fireEvent.click(home);
    fireEvent.mouseDown(screen.getByRole("textbox", { name: "Document" }));
    expect(screen.queryByRole("tabpanel")).toBeNull();
  });
});
