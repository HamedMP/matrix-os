// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SplitPane } from "../../../home/apps/_shared/office-ui";

afterEach(cleanup);

function renderPane(props: Partial<React.ComponentProps<typeof SplitPane>> = {}) {
  const onSizeChange = vi.fn();
  render(
    <SplitPane
      label="Resize message list"
      defaultSize={300}
      minSize={200}
      maxSize={500}
      onSizeChange={onSizeChange}
      first={<div>List</div>}
      second={<div>Reader</div>}
      {...props}
    />,
  );
  return { onSizeChange, separator: screen.getByRole("separator", { name: "Resize message list" }) };
}

describe("SplitPane", () => {
  it("exposes a focusable separator with value semantics", () => {
    const { separator } = renderPane();
    expect(separator.tabIndex).toBe(0);
    expect(separator.getAttribute("aria-orientation")).toBe("vertical");
    expect(separator.getAttribute("aria-valuenow")).toBe("300");
    expect(separator.getAttribute("aria-valuemin")).toBe("200");
    expect(separator.getAttribute("aria-valuemax")).toBe("500");
    expect(screen.getByText("List")).toBeTruthy();
    expect(screen.getByText("Reader")).toBeTruthy();
  });

  it("resizes with arrow keys, clamps to bounds and jumps with Home and End", () => {
    const { separator, onSizeChange } = renderPane();
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(separator.getAttribute("aria-valuenow")).toBe("316");
    expect(onSizeChange).toHaveBeenLastCalledWith(316);
    fireEvent.keyDown(separator, { key: "ArrowLeft", shiftKey: true });
    expect(separator.getAttribute("aria-valuenow")).toBe("252");
    fireEvent.keyDown(separator, { key: "End" });
    expect(separator.getAttribute("aria-valuenow")).toBe("500");
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(separator.getAttribute("aria-valuenow")).toBe("500");
    fireEvent.keyDown(separator, { key: "Home" });
    expect(separator.getAttribute("aria-valuenow")).toBe("200");
  });

  it("uses up and down arrows for vertical stacking", () => {
    const { separator } = renderPane({ direction: "vertical" });
    expect(separator.getAttribute("aria-orientation")).toBe("horizontal");
    fireEvent.keyDown(separator, { key: "ArrowDown" });
    expect(separator.getAttribute("aria-valuenow")).toBe("316");
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(separator.getAttribute("aria-valuenow")).toBe("316");
  });

  it("follows pointer drags within bounds", () => {
    const { separator, onSizeChange } = renderPane();
    fireEvent.pointerDown(separator, { clientX: 300, clientY: 0, pointerId: 1, button: 0 });
    fireEvent.pointerMove(window, { clientX: 360, clientY: 0, pointerId: 1 });
    expect(separator.getAttribute("aria-valuenow")).toBe("360");
    fireEvent.pointerMove(window, { clientX: 900, clientY: 0, pointerId: 1 });
    expect(separator.getAttribute("aria-valuenow")).toBe("500");
    fireEvent.pointerUp(window, { clientX: 900, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 250, clientY: 0, pointerId: 1 });
    expect(separator.getAttribute("aria-valuenow")).toBe("500");
    expect(onSizeChange).toHaveBeenLastCalledWith(500);
  });

  it("respects a controlled size", () => {
    const onSizeChange = vi.fn();
    render(<SplitPane label="Split" size={240} onSizeChange={onSizeChange} first="a" second="b" />);
    const separator = screen.getByRole("separator");
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(onSizeChange).toHaveBeenCalledWith(256);
    expect(separator.getAttribute("aria-valuenow")).toBe("240");
  });
});
