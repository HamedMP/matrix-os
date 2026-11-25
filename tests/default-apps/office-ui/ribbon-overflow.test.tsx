// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ribbon, fitGroups, type RibbonTab } from "../../../home/apps/_shared/office-ui";

let containerWidth = 1000;
const observers: Array<() => void> = [];
const FULL = 200;
const COLLAPSED = 60;

class FakeResizeObserver {
  private readonly callback: () => void;
  constructor(callback: () => void) {
    this.callback = callback;
  }
  observe() {
    observers.push(this.callback);
  }
  unobserve() {}
  disconnect() {
    const at = observers.indexOf(this.callback);
    if (at >= 0) observers.splice(at, 1);
  }
}

function rect(width: number): DOMRect {
  return { width, height: 80, top: 0, left: 0, right: width, bottom: 80, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
}

beforeEach(() => {
  containerWidth = 1000;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("oui-ribbon__groups")) return rect(containerWidth);
    if (this.classList.contains("oui-ribbon__group") && this.hasAttribute("data-group-id")) {
      return rect(this.classList.contains("is-collapsed") ? COLLAPSED : FULL);
    }
    return rect(0);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  observers.length = 0;
});

function resize(width: number) {
  containerWidth = width;
  act(() => {
    for (const callback of [...observers]) callback();
  });
}

const onHeading = vi.fn();
const tabs: RibbonTab[] = [
  {
    id: "home",
    label: "Home",
    groups: [
      { id: "clipboard", label: "Clipboard", items: [{ kind: "button", id: "copy", label: "Copy", onClick: vi.fn() }] },
      { id: "font", label: "Font", items: [{ kind: "button", id: "grow", label: "Grow font", onClick: vi.fn() }] },
      {
        id: "styles",
        label: "Styles",
        items: [
          { kind: "button", id: "heading", label: "Heading", onClick: onHeading },
          { kind: "button", id: "title", label: "Title", onClick: vi.fn() },
        ],
      },
    ],
  },
];

function renderRibbon() {
  return render(<Ribbon tabs={tabs} activeTab="home" onTabChange={vi.fn()} />);
}

describe("fitGroups", () => {
  it("keeps groups expanded from the left and collapses from the right", () => {
    expect(fitGroups(1000, [200, 200, 200], [60, 60, 60])).toBe(3);
    expect(fitGroups(480, [200, 200, 200], [60, 60, 60])).toBe(2);
    expect(fitGroups(320, [200, 200, 200], [60, 60, 60])).toBe(1);
    expect(fitGroups(319, [200, 200, 200], [60, 60, 60])).toBe(0);
    expect(fitGroups(100, [200, 200, 200], [60, 60, 60])).toBe(0);
  });
});

describe("Ribbon overflow", () => {
  it("shows every group when there is room", () => {
    renderRibbon();
    expect(screen.getByRole("group", { name: "Styles" })).toBeTruthy();
    expect(document.querySelectorAll(".oui-ribbon__group.is-collapsed")).toHaveLength(0);
  });

  it("collapses groups from the right into overflow buttons as the window narrows, without wrapping", () => {
    renderRibbon();
    resize(480);
    expect(screen.getByRole("group", { name: "Clipboard" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Font" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Styles" })).toBeNull();
    const overflow = screen.getByRole("button", { name: "Styles" });
    expect(overflow.getAttribute("aria-haspopup")).toBe("dialog");

    resize(320);
    expect(screen.getByRole("button", { name: "Font" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Clipboard" })).toBeTruthy();

    resize(100);
    expect(document.querySelectorAll(".oui-ribbon__group.is-collapsed")).toHaveLength(3);
    expect(document.querySelectorAll(".oui-ribbon__groups")).toHaveLength(1);

    resize(1000);
    expect(document.querySelectorAll(".oui-ribbon__group.is-collapsed")).toHaveLength(0);
  });

  it("opens a collapsed group in a popover whose items work, and Escape returns focus", () => {
    renderRibbon();
    resize(480);
    const overflow = screen.getByRole("button", { name: "Styles" });
    fireEvent.click(overflow);
    const popover = screen.getByRole("dialog", { name: "Styles" });
    expect(overflow.getAttribute("aria-expanded")).toBe("true");
    const heading = within(popover).getByRole("button", { name: "Heading" });
    expect(document.activeElement).toBe(heading);
    fireEvent.keyDown(heading, { key: "ArrowRight" });
    expect(document.activeElement).toBe(within(popover).getByRole("button", { name: "Title" }));
    fireEvent.click(heading);
    expect(onHeading).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Styles" })).toBeNull();
    expect(document.activeElement).toBe(overflow);
  });

  it("closes the group popover after a command, and keeps it open while a list or a menu is being used", () => {
    const onRun = vi.fn();
    const onSize = vi.fn();
    const onMore = vi.fn();
    const tools: RibbonTab[] = [
      {
        id: "home",
        label: "Home",
        groups: [
          { id: "clipboard", label: "Clipboard", items: [{ kind: "button", id: "copy", label: "Copy", onClick: vi.fn() }] },
          {
            id: "tools",
            label: "Tools",
            items: [
              { kind: "button", id: "run", label: "Run", onClick: onRun },
              { kind: "select", id: "size", label: "Size", value: "1", options: [{ value: "1", label: "One" }, { value: "2", label: "Two" }], onChange: onSize },
              { kind: "menu", id: "more", label: "More", menu: [{ id: "deep", label: "Deep" }], onMenuSelect: onMore },
            ],
          },
        ],
      },
    ];
    render(<Ribbon tabs={tools} activeTab="home" onTabChange={vi.fn()} />);
    resize(250);
    const overflow = screen.getByRole("button", { name: "Tools" });
    const popover = () => screen.queryByRole("dialog", { name: "Tools" });

    fireEvent.click(overflow);
    fireEvent.change(within(popover()!).getByRole("combobox", { name: "Size" }), { target: { value: "2" } });
    expect(onSize).toHaveBeenCalledWith("2");
    expect(popover()).not.toBeNull();

    fireEvent.click(within(popover()!).getByRole("button", { name: "More" }));
    expect(popover()).not.toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Deep" }));
    expect(onMore).toHaveBeenCalledWith("deep");
    expect(popover()).toBeNull();

    fireEvent.click(overflow);
    fireEvent.click(within(popover()!).getByRole("button", { name: "Run" }));
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(overflow);
  });

  it("keeps one tab stop per collapsed group", () => {
    renderRibbon();
    resize(100);
    const stops = Array.from(document.querySelectorAll<HTMLElement>(".oui-ribbon__groups button")).filter((el) => el.tabIndex === 0);
    expect(stops).toHaveLength(3);
  });
});
