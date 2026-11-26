// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import React, { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog, Popover, Ribbon, ToastProvider, useToast, type BackstageState, type RibbonTab } from "../../../home/apps/_shared/office-ui";

afterEach(cleanup);

function makeTabs(onSave: () => void, onDownload: () => void): RibbonTab[] {
  return [
    {
      id: "file",
      label: "File",
      mode: "backstage",
      backstage: {
        defaultItem: "open",
        items: [
          { id: "new", label: "New", render: () => <p>Blank document</p> },
          { id: "open", label: "Open", render: ({ close }) => <button type="button" onClick={close}>Recent: Plan.docx</button> },
          { id: "save", label: "Save", shortcut: "Ctrl+S", separatorBefore: true, onSelect: onSave },
          { id: "download", label: "Download a copy", keepOpen: true, onSelect: onDownload },
        ],
      },
    },
    { id: "home", label: "Home", groups: [{ id: "g", label: "Clipboard", items: [{ kind: "button", id: "copy", label: "Copy", onClick: vi.fn() }] }] },
  ];
}

function renderRibbon(overrides: Partial<React.ComponentProps<typeof Ribbon>> = {}) {
  const onSave = vi.fn();
  const onDownload = vi.fn();
  const onTabChange = vi.fn();
  render(<Ribbon tabs={makeTabs(onSave, onDownload)} activeTab="home" onTabChange={onTabChange} {...overrides} />);
  return { onSave, onDownload, onTabChange };
}

function openFile() {
  const file = screen.getByRole("tab", { name: "File" });
  file.focus();
  fireEvent.click(file);
  return file;
}

describe("Ribbon backstage", () => {
  it("opens a full panel with a command list and the default item's content", () => {
    const { onTabChange } = renderRibbon();
    const file = openFile();
    const panel = screen.getByRole("dialog", { name: "File" });
    expect(file.getAttribute("aria-expanded")).toBe("true");
    expect(file.getAttribute("aria-haspopup")).toBe("dialog");
    expect(onTabChange).not.toHaveBeenCalled();
    expect(within(panel).getByRole("button", { name: "Open" }).getAttribute("aria-current")).toBe("page");
    expect(within(panel).getByRole("region", { name: "Open" }).textContent).toContain("Recent: Plan.docx");
    expect(panel.contains(document.activeElement)).toBe(true);
    // The ribbon panel underneath still shows Home.
    expect(screen.getByRole("tab", { name: "Home" }).getAttribute("aria-selected")).toBe("true");
  });

  it("switches content from the command list", () => {
    renderRibbon();
    openFile();
    const panel = screen.getByRole("dialog", { name: "File" });
    fireEvent.click(within(panel).getByRole("button", { name: "New" }));
    expect(within(panel).getByRole("region", { name: "New" }).textContent).toBe("Blank document");
  });

  it("closes on Escape and returns focus to the File tab", () => {
    renderRibbon();
    const file = openFile();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "File" })).toBeNull();
    expect(document.activeElement).toBe(file);
    expect(file.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes from the back arrow and from content that calls close", () => {
    renderRibbon();
    const file = openFile();
    fireEvent.click(screen.getByRole("button", { name: "Back to document" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(file);
    openFile();
    fireEvent.click(screen.getByRole("button", { name: "Recent: Plan.docx" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("runs action items, closing unless they keep the panel open", () => {
    const { onSave, onDownload } = renderRibbon();
    openFile();
    fireEvent.click(screen.getByRole("button", { name: "Download a copy" }));
    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog", { name: "File" })).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save" });
    expect(save.getAttribute("title")).toBe("Save (Ctrl+S)");
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toMatchObject({ close: expect.any(Function), select: expect.any(Function) });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes when its open File tab is activated again, by click or by Enter", () => {
    renderRibbon();
    const file = openFile();
    fireEvent.click(within(screen.getByRole("dialog", { name: "File" })).getByRole("button", { name: "New" }));
    fireEvent.click(file);
    expect(screen.queryByRole("dialog", { name: "File" })).toBeNull();
    expect(file.getAttribute("aria-expanded")).toBe("false");

    openFile();
    expect(screen.getByRole("region", { name: "Open" })).toBeTruthy();
    fireEvent.keyDown(file, { key: "ArrowDown" });
    expect(screen.getByRole("dialog", { name: "File" })).toBeTruthy();
    fireEvent.keyDown(file, { key: "Enter" });
    expect(screen.queryByRole("dialog", { name: "File" })).toBeNull();
  });

  it("opens from ArrowDown or Enter on the File tab", () => {
    renderRibbon();
    const file = screen.getByRole("tab", { name: "File" });
    file.focus();
    fireEvent.keyDown(file, { key: "Enter" });
    expect(screen.getByRole("dialog", { name: "File" })).toBeTruthy();
  });

  it("closes on a press outside it, such as the title bar, and returns focus to the File tab", () => {
    render(
      <>
        <header><button type="button">Rename</button></header>
        <Ribbon tabs={makeTabs(vi.fn(), vi.fn())} activeTab="home" onTabChange={vi.fn()} />
      </>,
    );
    const file = openFile();
    fireEvent.mouseDown(screen.getByRole("button", { name: "Rename" }));
    expect(screen.queryByRole("dialog", { name: "File" })).toBeNull();
    expect(document.activeElement).toBe(file);
    expect(file.getAttribute("aria-expanded")).toBe("false");
  });

  it("stays open for presses inside it, on the File tab, and inside its own dialogs, popovers and toasts", () => {
    function Content() {
      const [dialog, setDialog] = useState(false);
      const [popover, setPopover] = useState(false);
      const anchorRef = useRef<HTMLButtonElement>(null);
      const toast = useToast();
      return (
        <>
          <button type="button" onClick={() => setDialog(true)}>Rename file</button>
          <button type="button" ref={anchorRef} onClick={() => setPopover(true)}>Sort</button>
          <button type="button" onClick={() => toast.show({ title: "Copy saved", durationMs: 0 })}>Notify</button>
          <Dialog open={dialog} onClose={() => setDialog(false)} title="Rename"><input aria-label="New name" /></Dialog>
          <Popover open={popover} onClose={() => setPopover(false)} anchorRef={anchorRef} label="Sort options">
            <button type="button">By name</button>
          </Popover>
        </>
      );
    }
    const tabs: RibbonTab[] = [
      { id: "file", label: "File", mode: "backstage", backstage: { items: [{ id: "open", label: "Open", render: () => <Content /> }] } },
      { id: "home", label: "Home", groups: [] },
    ];
    render(
      <ToastProvider>
        <Ribbon tabs={tabs} activeTab="home" onTabChange={vi.fn()} />
      </ToastProvider>,
    );
    const file = openFile();
    const panel = () => screen.queryByRole("dialog", { name: "File" });

    fireEvent.mouseDown(within(panel()!).getByRole("button", { name: "Open" }));
    fireEvent.mouseDown(within(panel()!).getByRole("region", { name: "Open" }));
    fireEvent.mouseDown(file);
    expect(panel()).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Rename file" }));
    fireEvent.mouseDown(screen.getByRole("textbox", { name: "New name" }));
    fireEvent.mouseDown(screen.getByTestId("oui-dialog-backdrop"));
    expect(panel()).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    fireEvent.click(screen.getByRole("button", { name: "Sort" }));
    fireEvent.mouseDown(screen.getByRole("button", { name: "By name" }));
    expect(panel()).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Sort options" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Notify" }));
    fireEvent.mouseDown(screen.getByText("Copy saved"));
    expect(panel()).toBeTruthy();
  });

  it("can be controlled, for example to open Open from a shortcut", () => {
    const changes: Array<BackstageState | null> = [];
    function Controlled() {
      const [state, setState] = useState<BackstageState | null>(null);
      return (
        <>
          <button type="button" onClick={() => setState({ tab: "file", item: "new" })}>Shortcut</button>
          <Ribbon
            tabs={makeTabs(vi.fn(), vi.fn())}
            activeTab="home"
            onTabChange={vi.fn()}
            backstage={state}
            onBackstageChange={(next) => { changes.push(next); setState(next); }}
          />
        </>
      );
    }
    render(<Controlled />);
    fireEvent.click(screen.getByRole("button", { name: "Shortcut" }));
    expect(screen.getByRole("region", { name: "New" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(changes.at(-1)).toEqual({ tab: "file", item: "open" });
    fireEvent.click(screen.getByRole("button", { name: "Back to document" }));
    expect(changes.at(-1)).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Shortcut" }));
    fireEvent.click(screen.getByRole("tab", { name: "File" }));
    expect(changes.at(-1)).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
