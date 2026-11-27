// @vitest-environment jsdom

import React, { useState } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Trash2 } from "lucide-react";
import {
  AvatarGroup,
  Badge,
  Button,
  Checkbox,
  DropdownMenu,
  getInitials,
  IconButton,
  iconStrokeWidth,
  LineTabs,
  rovingIndex,
  SegmentedControl,
  TabPanel,
  type CheckedState,
  type MenuEntry,
} from "../../desktop/src/renderer/src/design/ds";
import { DESKTOP_Z_INDEX } from "../../desktop/src/renderer/src/design/layering";
import { dsCn } from "../../desktop/src/renderer/src/design/ds/cn";

afterEach(cleanup);

describe("design-system Icon", () => {
  it("keeps strokes at least 1.25px on screen below 16px", () => {
    expect(iconStrokeWidth("sm")).toBe(2);
    expect(iconStrokeWidth("md")).toBe(2);
    expect(iconStrokeWidth("xs")).toBeCloseTo(2.142857, 5);
    expect(iconStrokeWidth("xxs")).toBe(2.5);
  });
});

describe("design-system Button", () => {
  it("renders a real button that does not submit forms by default", () => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(<form onSubmit={onSubmit}><Button variant="primary">Save</Button></form>);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save" }).dataset.variant).toBe("primary");
  });

  it("gives icon-only buttons an accessible name", () => {
    render(<Tooltip.Provider><IconButton label="Move to Trash"><Trash2 /></IconButton></Tooltip.Provider>);
    expect(screen.getByRole("button", { name: "Move to Trash" })).toBeTruthy();
  });

  it("keeps its label colour and text size together", () => {
    render(<Button variant="primary" size="sm">New</Button>);
    const classes = screen.getByRole("button", { name: "New" }).className.split(" ");
    expect(classes).toContain("text-ds-primary-foreground");
    expect(classes).toContain("text-ds-ui");
  });

  it("does not fire when disabled", () => {
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>Delete</Button>);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("design-system class merging", () => {
  it("treats ds text sizes and ds text colours as different groups", () => {
    expect(dsCn("text-ds-foreground text-ds-ui")).toBe("text-ds-foreground text-ds-ui");
    expect(dsCn("text-ds-ui text-ds-ui-sm")).toBe("text-ds-ui-sm");
    expect(dsCn("text-ds-foreground text-ds-muted-foreground")).toBe("text-ds-muted-foreground");
  });
});

describe("design-system Badge", () => {
  it("defaults to the neutral tint", () => {
    render(<Badge>Managed</Badge>);
    expect(screen.getByText("Managed").dataset.variant).toBe("neutral");
  });
});

describe("design-system Checkbox", () => {
  function Harness({ initial }: { initial: CheckedState }) {
    const [checked, setChecked] = useState<CheckedState>(initial);
    return <Checkbox aria-label="Select all" checked={checked} onCheckedChange={(next) => setChecked(next)} />;
  }

  it("reports indeterminate as mixed and checks everything on click", () => {
    render(<Harness initial="indeterminate" />);
    const box = screen.getByRole("checkbox", { name: "Select all" });
    expect(box.getAttribute("aria-checked")).toBe("mixed");
    fireEvent.click(box);
    expect(box.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(box);
    expect(box.getAttribute("aria-checked")).toBe("false");
  });

  it("toggles with Space and Enter without reaching a parent key handler", () => {
    const onParentKeyDown = vi.fn();
    render(<div onKeyDown={onParentKeyDown}><Harness initial={false} /></div>);
    const box = screen.getByRole("checkbox", { name: "Select all" });
    expect(fireEvent.keyDown(box, { key: " " })).toBe(false);
    expect(box.getAttribute("aria-checked")).toBe("true");
    expect(fireEvent.keyDown(box, { key: "Enter" })).toBe(false);
    expect(box.getAttribute("aria-checked")).toBe("false");
    expect(onParentKeyDown).not.toHaveBeenCalled();
  });
});

describe("roving focus", () => {
  it("wraps and supports Home and End", () => {
    expect(rovingIndex("ArrowRight", 2, 3)).toBe(0);
    expect(rovingIndex("ArrowLeft", 0, 3)).toBe(2);
    expect(rovingIndex("Home", 2, 3)).toBe(0);
    expect(rovingIndex("End", 0, 3)).toBe(2);
    expect(rovingIndex("ArrowDown", 0, 3)).toBeNull();
    expect(rovingIndex("ArrowDown", 0, 3, "vertical")).toBe(1);
  });
});

describe("design-system SegmentedControl", () => {
  function Harness() {
    const [view, setView] = useState<"grid" | "list" | "columns">("grid");
    return (
      <SegmentedControl
        label="View"
        value={view}
        onChange={setView}
        iconOnly
        options={[{ value: "grid", label: "Grid" }, { value: "list", label: "List" }, { value: "columns", label: "Columns" }]}
      />
    );
  }

  it("exposes one checked radio with a single tab stop and moves with arrows", () => {
    render(<Harness />);
    const group = screen.getByRole("radiogroup", { name: "View" });
    const grid = within(group).getByRole("radio", { name: "Grid" });
    expect(grid.getAttribute("aria-checked")).toBe("true");
    expect(within(group).getByRole("radio", { name: "List" }).tabIndex).toBe(-1);
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    const list = within(group).getByRole("radio", { name: "List" });
    expect(list.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(list);
  });
});

describe("design-system LineTabs", () => {
  function Harness() {
    const [tab, setTab] = useState("preview");
    const tabs = [{ id: "preview", label: "Preview" }, { id: "details", label: "Details" }];
    return (
      <>
        <LineTabs label="File details" idPrefix="t" tabs={tabs} value={tab} onChange={setTab} />
        {tabs.map((item) => <TabPanel key={item.id} idPrefix="t" id={item.id} active={item.id === tab}>{item.label} body</TabPanel>)}
      </>
    );
  }

  it("links tabs to panels and shows only the selected panel", () => {
    render(<Harness />);
    const preview = screen.getByRole("tab", { name: "Preview" });
    expect(preview.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(preview.id);
    fireEvent.keyDown(preview, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Details" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").textContent).toBe("Details body");
  });
});

describe("design-system DropdownMenu", () => {
  it("renders labelled groups, a radio check and a last destructive row", () => {
    const onTrash = vi.fn();
    const onApp = vi.fn();
    const entries: MenuEntry[] = [
      { kind: "item", id: "open", label: "Open", shortcut: "↵", onSelect: vi.fn() },
      { kind: "separator", id: "s1" },
      { kind: "label", id: "edit", label: "Edit" },
      { kind: "radio", id: "apps", value: "editor", onValueChange: onApp, options: [{ value: "editor", label: "Editor" }, { value: "preview", label: "Preview" }] },
      { kind: "separator", id: "s2" },
      { kind: "item", id: "trash", label: "Move to Trash", destructive: true, onSelect: onTrash },
    ];
    render(<DropdownMenu trigger={<button type="button">More</button>} entries={entries} />);
    const open = () => fireEvent.pointerDown(screen.getByRole("button", { name: "More" }), { button: 0, ctrlKey: false });
    open();
    const menu = screen.getByRole("menu", { name: "More" });
    expect(within(menu).getByText("Edit")).toBeTruthy();
    expect(within(menu).getByRole("menuitemradio", { name: "Editor" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Preview" }));
    expect(onApp).toHaveBeenCalledWith("preview");
    open();
    const items = Array.from(screen.getByRole("menu").querySelectorAll<HTMLElement>("[role^='menuitem']"));
    expect(items.at(-1)?.textContent).toContain("Move to Trash");
    fireEvent.click(items.at(-1)!);
    expect(onTrash).toHaveBeenCalledTimes(1);
  });
});

describe("design-system popover layering", () => {
  it("puts menus on the shared popover layer", () => {
    render(<DropdownMenu trigger={<button type="button">Open</button>} entries={[{ kind: "item", id: "a", label: "A", onSelect: vi.fn() }]} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Open" }), { button: 0, ctrlKey: false });
    expect(screen.getByRole("menu").style.zIndex).toBe(String(DESKTOP_Z_INDEX.popover));
    expect(screen.getByRole("menu").className).toContain("ds-menu-surface");
  });
});

describe("design-system Avatar", () => {
  it("derives initials and collapses extra members into +N", () => {
    expect(getInitials("Nima Naderi")).toBe("NN");
    expect(getInitials("hamed")).toBe("HA");
    expect(getInitials("  ")).toBe("");
    render(<AvatarGroup label="Members" names={["Ada Lovelace", "Grace Hopper", "Alan Turing", "Kay Rows", "Ed Sun"]} max={3} />);
    const group = screen.getByRole("group", { name: "Members" });
    expect(within(group).getAllByRole("img")).toHaveLength(3);
    expect(group.textContent).toContain("+2");
  });
});
