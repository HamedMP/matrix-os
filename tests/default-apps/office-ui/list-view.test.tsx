// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React, { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ListView } from "../../../home/apps/_shared/office-ui";

type Row = { id: string; subject: string };
const rows: Row[] = Array.from({ length: 1000 }, (_, i) => ({ id: `m${i}`, subject: `Message ${i}` }));

function Harness({ mode, onActivate, items = rows }: { mode: "single" | "multiple"; onActivate?: (row: Row) => void; items?: Row[] }) {
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <>
      <ListView<Row>
        label="Messages"
        items={items}
        getKey={(row) => row.id}
        rowHeight={40}
        height={400}
        selectionMode={mode}
        selectedKeys={selected}
        onSelectionChange={setSelected}
        onActivate={onActivate}
        renderItem={(row) => <span>{row.subject}</span>}
        emptyState={<p>No messages</p>}
      />
      <output data-testid="selected">{selected.join(",")}</output>
    </>
  );
}

const listbox = () => screen.getByRole("listbox", { name: "Messages" });
const selected = () => screen.getByTestId("selected").textContent;
const activeOption = () => {
  const id = listbox().getAttribute("aria-activedescendant");
  return id ? document.getElementById(id) : null;
};

afterEach(cleanup);

describe("ListView", () => {
  it("renders only a window of rows for large lists while keeping set size semantics", () => {
    render(<Harness mode="single" />);
    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(5);
    expect(options.length).toBeLessThan(40);
    expect(options[0].getAttribute("aria-setsize")).toBe("1000");
    expect(options[0].getAttribute("aria-posinset")).toBe("1");
  });

  it("moves the active row and selection with arrow keys, Home and End in single mode", () => {
    render(<Harness mode="single" />);
    const list = listbox();
    list.focus();
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(selected()).toBe("m0");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(selected()).toBe("m2");
    expect(activeOption()?.textContent).toContain("Message 2");
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(selected()).toBe("m1");
    fireEvent.keyDown(list, { key: "End" });
    expect(selected()).toBe("m999");
    expect(activeOption()?.textContent).toContain("Message 999");
    expect(activeOption()?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(list, { key: "Home" });
    expect(selected()).toBe("m0");
  });

  it("scrolls the virtual window so the active row stays rendered", () => {
    render(<Harness mode="single" />);
    const list = listbox();
    fireEvent.keyDown(list, { key: "End" });
    expect(list.scrollTop).toBeGreaterThan(0);
    expect(screen.getByText("Message 999")).toBeTruthy();
    expect(screen.queryByText("Message 0")).toBeNull();
  });

  it("pages by the visible row count", () => {
    render(<Harness mode="single" />);
    const list = listbox();
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "PageDown" });
    expect(selected()).toBe("m10");
    fireEvent.keyDown(list, { key: "PageUp" });
    expect(selected()).toBe("m0");
  });

  it("supports toggle, range and select-all in multiple mode", () => {
    render(<Harness mode="multiple" />);
    const list = listbox();
    expect(list.getAttribute("aria-multiselectable")).toBe("true");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(selected()).toBe("");
    fireEvent.keyDown(list, { key: " " });
    expect(selected()).toBe("m0");
    fireEvent.keyDown(list, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(list, { key: "ArrowDown", shiftKey: true });
    expect(selected()).toBe("m0,m1,m2");
    fireEvent.keyDown(list, { key: " " });
    expect(selected()).toBe("m0,m1");
    fireEvent.keyDown(list, { key: "a", ctrlKey: true });
    expect(selected()?.split(",").length).toBe(1000);
    fireEvent.keyDown(list, { key: "Escape" });
    expect(selected()).toBe("");
  });

  it("selects with click, toggles with modifier click and extends with shift click", () => {
    render(<Harness mode="multiple" />);
    fireEvent.click(screen.getByText("Message 1"));
    expect(selected()).toBe("m1");
    fireEvent.click(screen.getByText("Message 3"), { metaKey: true });
    expect(selected()).toBe("m1,m3");
    fireEvent.click(screen.getByText("Message 5"), { shiftKey: true });
    expect(selected()).toBe("m3,m4,m5");
  });

  it("activates the active row with Enter and with double click", () => {
    const onActivate = vi.fn();
    render(<Harness mode="single" onActivate={onActivate} />);
    const list = listbox();
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onActivate).toHaveBeenLastCalledWith(rows[1], 1);
    fireEvent.doubleClick(screen.getByText("Message 4"));
    expect(onActivate).toHaveBeenLastCalledWith(rows[4], 4);
  });

  it("shows the empty state when there are no items", () => {
    render(<Harness mode="single" items={[]} />);
    expect(screen.getByText("No messages")).toBeTruthy();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });
});
