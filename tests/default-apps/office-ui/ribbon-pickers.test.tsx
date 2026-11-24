// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import React, { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ribbon, clearRecentColors, type RibbonItem } from "../../../home/apps/_shared/office-ui";

beforeEach(clearRecentColors);
afterEach(cleanup);

function renderItems(items: RibbonItem[]) {
  return render(<Ribbon tabs={[{ id: "home", label: "Home", groups: [{ id: "g", label: "Font", items }] }]} activeTab="home" onTabChange={vi.fn()} />);
}

function ColorHarness({ onChange }: { onChange: (color: string | null) => void }) {
  const [value, setValue] = useState<string | null>("#000000");
  return (
    <Ribbon
      tabs={[{
        id: "home",
        label: "Home",
        groups: [{
          id: "font",
          label: "Font",
          items: [{
            kind: "color",
            id: "text-color",
            label: "Font colour",
            value,
            allowNone: true,
            onChange: (color) => { onChange(color); setValue(color); },
          }],
        }],
      }]}
      activeTab="home"
      onTabChange={vi.fn()}
    />
  );
}

describe("colour picker", () => {
  it("applies the current colour from the face and picks from the palette", () => {
    const onChange = vi.fn();
    render(<ColorHarness onChange={onChange} />);
    const face = screen.getByRole("button", { name: "Font colour" });
    expect(face.getAttribute("title")).toBe("Font colour: Black");
    fireEvent.click(face);
    expect(onChange).toHaveBeenLastCalledWith("#000000");

    const arrow = screen.getByRole("button", { name: "Font colour options" });
    fireEvent.click(arrow);
    const palette = screen.getByRole("dialog", { name: "Font colour" });
    expect(within(palette).queryByText("Recent colours")).toBeNull();
    fireEvent.click(within(palette).getByRole("button", { name: "Red" }));
    expect(onChange).toHaveBeenLastCalledWith("#dc2626");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(arrow);
  });

  it("remembers recent colours and offers automatic and custom colours", () => {
    const onChange = vi.fn();
    render(<ColorHarness onChange={onChange} />);
    const arrow = screen.getByRole("button", { name: "Font colour options" });
    fireEvent.click(arrow);
    fireEvent.click(screen.getByRole("button", { name: "Blue" }));
    fireEvent.click(arrow);
    const recent = screen.getByRole("group", { name: "Recent colours" });
    expect(within(recent).getByRole("button", { name: "Blue" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(screen.getByLabelText("More colours…"), { target: { value: "#123456" } });
    expect(onChange).toHaveBeenLastCalledWith("#123456");
    fireEvent.click(arrow);
    fireEvent.click(screen.getByRole("button", { name: "Automatic" }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("moves between swatches with arrow keys", () => {
    render(<ColorHarness onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Font colour options" }));
    const black = screen.getByRole("button", { name: "Black" });
    black.focus();
    fireEvent.keyDown(black, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Dark gray" }));
  });
});

describe("gallery", () => {
  it("selects inline styles and lists every style under More", () => {
    const onSelect = vi.fn();
    renderItems([{
      kind: "gallery",
      id: "styles",
      label: "Styles",
      value: "normal",
      visible: 2,
      onSelect,
      options: [
        { id: "normal", label: "Normal" },
        { id: "h1", label: "Heading 1", style: { fontWeight: 700 } },
        { id: "quote", label: "Quote" },
      ],
    }]);
    expect(screen.getByRole("button", { name: "Normal" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: "Quote" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Heading 1" }));
    expect(onSelect).toHaveBeenLastCalledWith("h1");
    fireEvent.click(screen.getByRole("button", { name: "More styles" }));
    const all = screen.getByRole("dialog", { name: "Styles" });
    fireEvent.click(within(all).getByRole("button", { name: "Quote" }));
    expect(onSelect).toHaveBeenLastCalledWith("quote");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("select", () => {
  it("commits a typed value on Enter and reverts on Escape when editable", () => {
    const onChange = vi.fn();
    renderItems([{
      kind: "select",
      id: "size",
      label: "Font size",
      value: "11",
      editable: true,
      width: 56,
      onChange,
      options: ["9", "10", "11", "12"].map((value) => ({ value, label: value })),
    }]);
    const input = screen.getByRole("combobox", { name: "Font size" }) as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "13" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("13");
    fireEvent.change(input, { target: { value: "99" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("11");
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("shows a value missing from the list instead of silently picking the first option", () => {
    renderItems([{
      kind: "select",
      id: "family",
      label: "Font",
      value: "Comic Neue",
      onChange: vi.fn(),
      options: [{ value: "Inter", label: "Inter" }],
    }]);
    expect((screen.getByRole("combobox", { name: "Font" }) as HTMLSelectElement).value).toBe("Comic Neue");
  });
});
