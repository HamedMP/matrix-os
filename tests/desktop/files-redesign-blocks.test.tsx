// @vitest-environment jsdom

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Folder, Trash2 } from "lucide-react";
import {
  clearSelection,
  clickSelection,
  EMPTY_SELECTION,
  headerCheckState,
  reconcileSelection,
  selectAll,
} from "../../desktop/src/renderer/src/features/files/redesign/selection-model";
import {
  countSummary,
  entryMeta,
  kindLabel,
  renameSelectionEnd,
  tileToneForFile,
} from "../../desktop/src/renderer/src/features/files/redesign/file-presentation";
import { FileCard, type EntryHandlers } from "../../desktop/src/renderer/src/features/files/redesign/FileCard";
import { FileRow, FileTable } from "../../desktop/src/renderer/src/features/files/redesign/FileTable";
import { SelectionBar } from "../../desktop/src/renderer/src/features/files/redesign/SelectionBar";
import { FilesSidebar } from "../../desktop/src/renderer/src/features/files/redesign/FilesSidebar";
import { FolderTabs } from "../../desktop/src/renderer/src/features/files/redesign/FolderTabs";
import { FilesStatusBar } from "../../desktop/src/renderer/src/features/files/redesign/FilesHeader";

afterEach(cleanup);

const ORDER = ["a", "b", "c", "d", "e"];

describe("Files selection model", () => {
  it("plain click selects only that entry and sets the anchor", () => {
    const next = clickSelection({ selected: ["a", "b"], anchor: "a" }, "c", ORDER);
    expect(next).toEqual({ selected: ["c"], anchor: "c" });
  });

  it("⌘-click toggles without clearing the rest", () => {
    let state = clickSelection(EMPTY_SELECTION, "b", ORDER);
    state = clickSelection(state, "d", ORDER, { toggle: true });
    expect(state.selected).toEqual(["b", "d"]);
    state = clickSelection(state, "b", ORDER, { toggle: true });
    expect(state.selected).toEqual(["d"]);
  });

  it("Shift-click selects the range from the anchor in either direction", () => {
    let state = clickSelection(EMPTY_SELECTION, "b", ORDER);
    state = clickSelection(state, "d", ORDER, { range: true });
    expect(state.selected).toEqual(["b", "c", "d"]);
    state = clickSelection(state, "a", ORDER, { range: true });
    expect(state.selected).toEqual(["a", "b"]);
    expect(state.anchor).toBe("b");
  });

  it("⌘⇧-click adds a range to an existing selection", () => {
    let state = clickSelection(EMPTY_SELECTION, "a", ORDER);
    state = clickSelection(state, "d", ORDER, { toggle: true });
    state = clickSelection(state, "e", ORDER, { toggle: true, range: true });
    expect(state.selected).toEqual(["a", "d", "e"]);
  });

  it("Shift-click without an anchor behaves like a plain click", () => {
    expect(clickSelection(EMPTY_SELECTION, "c", ORDER, { range: true }).selected).toEqual(["c"]);
  });

  it("⌘A selects everything and Esc clears", () => {
    expect(selectAll(ORDER).selected).toEqual(ORDER);
    expect(clearSelection()).toEqual(EMPTY_SELECTION);
  });

  it("drops entries that disappeared after a reload", () => {
    const state = reconcileSelection({ selected: ["a", "x", "c"], anchor: "x" }, ORDER);
    expect(state).toEqual({ selected: ["a", "c"], anchor: "a" });
    const same = { selected: ["a"], anchor: "a" };
    expect(reconcileSelection(same, ORDER)).toBe(same);
  });

  it("derives the header checkbox state", () => {
    expect(headerCheckState(EMPTY_SELECTION, ORDER)).toBe(false);
    expect(headerCheckState({ selected: ["a"], anchor: "a" }, ORDER)).toBe("indeterminate");
    expect(headerCheckState(selectAll(ORDER), ORDER)).toBe(true);
    expect(headerCheckState(EMPTY_SELECTION, [])).toBe(false);
  });
});

describe("Files presentation", () => {
  it("names kinds the way the mockups do", () => {
    expect(kindLabel({ name: "2075 Final.pdf", type: "file" })).toBe("PDF");
    expect(kindLabel({ name: "CLAUDE.md", type: "file" })).toBe("Markdown");
    expect(kindLabel({ name: "bundle.zip", type: "file" })).toBe("ZIP");
    expect(kindLabel({ name: "Makefile", type: "file" })).toBe("File");
    expect(kindLabel({ name: "apps", type: "directory" })).toBe("Folder");
  });

  it("never returns inherited object members for unusual extensions", () => {
    expect(kindLabel({ name: "a.__proto__", type: "file" })).toBe("__PROTO__");
    expect(kindLabel({ name: "a.constructor", type: "file" })).toBe("CONSTRUCTOR");
    expect(kindLabel({ name: "a.toString", type: "file" })).toBe("TOSTRING");
  });

  it("tints PDFs coral, archives gold, code info and the rest neutral", () => {
    expect(tileToneForFile({ name: "a.pdf", type: "file" })).toBe("destructive");
    expect(tileToneForFile({ name: "a.zip", type: "file" })).toBe("warning");
    expect(tileToneForFile({ name: "matrix.json", type: "file" })).toBe("info");
    expect(tileToneForFile({ name: "notes.md", type: "file" })).toBe("neutral");
  });

  it("writes meta and count lines", () => {
    expect(entryMeta({ name: "x.pdf", type: "file", sizeBytes: 2_516_582 })).toBe("PDF · 2.4 MB");
    expect(entryMeta({ name: "apps", type: "directory", children: 1 })).toBe("1 item");
    expect(entryMeta({ name: "apps", type: "directory" })).toBe("Folder");
    expect(countSummary([{ type: "directory" }, { type: "directory" }, { type: "file" }])).toBe("2 folders, 1 file");
    expect(countSummary([])).toBe("Empty");
  });

  it("selects a file name without its extension for rename", () => {
    expect(renameSelectionEnd("report.final.pdf", "file")).toBe(12);
    expect(renameSelectionEnd(".env", "file")).toBe(4);
    expect(renameSelectionEnd("my.folder", "directory")).toBe(9);
  });
});

function handlers(overrides: Partial<EntryHandlers> = {}): EntryHandlers {
  return { onClick: vi.fn(), onDoubleClick: vi.fn(), onKeyDown: vi.fn(), ...overrides };
}

describe("FileCard", () => {
  it("is a selectable option labelled with the full name", () => {
    const h = handlers();
    render(<div role="listbox" aria-label="Files"><FileCard entry={{ name: "system", type: "directory" }} path="system" access="managed" selected focusable handlers={h} /></div>);
    const card = screen.getByRole("option", { name: "system" });
    expect(card.getAttribute("aria-selected")).toBe("true");
    expect(within(card).getByText("Managed")).toBeTruthy();
    expect(within(card).getByText("Read-only")).toBeTruthy();
    fireEvent.doubleClick(card);
    expect(h.onDoubleClick).toHaveBeenCalled();
  });
});

describe("FileTable", () => {
  it("marks the sorted column and lets a row checkbox toggle without a plain click", () => {
    const onSort = vi.fn();
    const onToggle = vi.fn();
    const h = handlers();
    render(
      <FileTable label="Files" headerChecked="indeterminate" onHeaderCheckedChange={vi.fn()} sortKey="name" sortDirection="asc" onSort={onSort}>
        <FileRow entry={{ name: "notes.md", type: "file", sizeBytes: 10 }} path="notes.md" selected={false} focusable handlers={h} onToggle={onToggle} />
      </FileTable>,
    );
    expect(screen.getByRole("columnheader", { name: /Name/ }).getAttribute("aria-sort")).toBe("ascending");
    expect(screen.getByRole("columnheader", { name: /Size/ }).getAttribute("aria-sort")).toBe("none");
    expect(screen.getByRole("checkbox", { name: "Select all" }).getAttribute("aria-checked")).toBe("mixed");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select notes.md" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(h.onClick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Size/ }));
    expect(onSort).toHaveBeenCalledWith("size");
  });
});

describe("SelectionBar", () => {
  it("renders nothing with no selection", () => {
    const { container } = render(<SelectionBar count={0} actions={[]} onClear={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the count, actions, Trash and Clear", () => {
    const onDownload = vi.fn();
    const onTrash = vi.fn();
    const onClear = vi.fn();
    render(
      <Tooltip.Provider>
        <SelectionBar count={3} actions={[{ id: "download", label: "Download", icon: <Folder />, onSelect: onDownload }]} onTrash={onTrash} onClear={onClear} />
      </Tooltip.Provider>,
    );
    const bar = screen.getByRole("toolbar", { name: "3 selected" });
    fireEvent.click(within(bar).getByRole("button", { name: "Download" }));
    fireEvent.click(within(bar).getByRole("button", { name: "Move to Trash" }));
    fireEvent.click(within(bar).getByRole("button", { name: "Clear" }));
    expect([onDownload, onTrash, onClear].map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1]);
  });
});

describe("FilesSidebar", () => {
  it("marks the active row and shows managed locks and the Trash count", () => {
    const onSelect = vi.fn();
    render(
      <FilesSidebar
        activeId="home"
        onSelect={onSelect}
        sections={[
          { id: "top", items: [{ id: "home", label: "Matrix home", icon: <Folder /> }] },
          { id: "locations", label: "Locations", items: [{ id: "system", label: "System", icon: <Folder />, locked: true }] },
        ]}
        footer={{ id: "footer", items: [{ id: "trash", label: "Trash", icon: <Trash2 />, count: 3 }] }}
      />,
    );
    expect(screen.getByRole("button", { name: "Matrix home" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { name: "Locations" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Managed, read-only" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Trash/ }));
    expect(onSelect).toHaveBeenCalledWith("trash");
    expect(screen.getByRole("button", { name: /Trash/ }).textContent).toContain("3");
  });
});

describe("FolderTabs", () => {
  it("moves with arrows, closes with Delete, and hides close on the last tab", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const tabs = [{ id: "home", title: "Matrix home" }, { id: "projects", title: "projects" }];
    const { rerender } = render(<Tooltip.Provider><FolderTabs tabs={tabs} activeId="home" onSelect={onSelect} onClose={onClose} onNewTab={vi.fn()} /></Tooltip.Provider>);
    const home = screen.getByRole("tab", { name: "Matrix home" });
    expect(home.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(home, { key: "ArrowRight" });
    expect(onSelect).toHaveBeenCalledWith("projects");
    fireEvent.keyDown(home, { key: "Delete" });
    expect(onClose).toHaveBeenCalledWith("home");
    rerender(<Tooltip.Provider><FolderTabs tabs={[tabs[0]!]} activeId="home" onSelect={onSelect} onClose={onClose} onNewTab={vi.fn()} /></Tooltip.Provider>);
    expect(screen.queryByRole("button", { name: "Close Matrix home" })).toBeNull();
  });
});

describe("FolderTabs focus", () => {
  function Harness() {
    const [tabs, setTabs] = React.useState([{ id: "home", title: "Matrix home" }, { id: "projects", title: "projects" }, { id: "apps", title: "apps" }]);
    const [active, setActive] = React.useState("projects");
    return (
      <Tooltip.Provider>
        <FolderTabs
          tabs={tabs}
          activeId={active}
          onSelect={setActive}
          onClose={(id) => {
            const index = tabs.findIndex((tab) => tab.id === id);
            const next = tabs.filter((tab) => tab.id !== id);
            setTabs(next);
            if (id === active) setActive(next[Math.max(0, index - 1)]!.id);
          }}
          onNewTab={vi.fn()}
        />
      </Tooltip.Provider>
    );
  }

  it("keeps keyboard focus in the tab strip after closing the focused tab", async () => {
    render(<Harness />);
    const projects = screen.getByRole("tab", { name: "projects" });
    projects.focus();
    fireEvent.keyDown(projects, { key: "Delete" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Matrix home" })));
    expect(screen.getByRole("tab", { name: "Matrix home" }).getAttribute("aria-selected")).toBe("true");
  });
});

describe("FilesStatusBar", () => {
  it("reports counts and selection", () => {
    const { rerender } = render(<FilesStatusBar total={18} selected={0} />);
    expect(screen.getByText("18 items")).toBeTruthy();
    rerender(<FilesStatusBar total={18} selected={3} />);
    expect(screen.getByText("3 of 18 selected")).toBeTruthy();
  });
});
