// @vitest-environment jsdom
import { cleanup, createEvent, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { gridKeyCommand } from "../../../../home/apps/sheets/src/grid/keymap";
import { editor, renderGrid, type } from "./harness";

afterEach(cleanup);

describe("characters typed with AltGr, Option and dead keys start editing", () => {
  it("reads AltGr (Ctrl+Alt) and Option (Alt) characters as typing", () => {
    expect(gridKeyCommand({ key: "@", ctrl: true, alt: true, shift: false })).toEqual({ type: "edit", initial: "@" });
    expect(gridKeyCommand({ key: "€", ctrl: false, alt: true, shift: false })).toEqual({ type: "edit", initial: "€" });
    expect(gridKeyCommand({ key: "{", ctrl: true, alt: true, shift: false })).toEqual({ type: "edit", initial: "{" });
    // Shortcuts with plain letters stay shortcuts, not typing.
    expect(gridKeyCommand({ key: "f", ctrl: false, alt: true, shift: false })).toBeNull();
    expect(gridKeyCommand({ key: "b", ctrl: true, alt: false, shift: false })).toEqual({ type: "format", toggle: "bold" });
  });

  it("opens the editor with the AltGr character on the grid", async () => {
    const { grid, container } = await renderGrid();
    fireEvent.keyDown(grid, { key: "@", ctrlKey: true, altKey: true });
    expect(editor(container)?.value).toBe("@");
  });

  it("opens an empty editor on a dead key or an input method key and lets the browser compose into it", async () => {
    for (const init of [{ key: "Dead" }, { key: "Process" }, { key: "a", keyCode: 229 }]) {
      const { grid, container, unmount } = await renderGrid();
      const event = createEvent.keyDown(grid, init);
      fireEvent(grid, event);
      const input = editor(container);
      expect(input?.value).toBe("");
      expect(input?.ownerDocument.activeElement).toBe(input);
      expect(event.defaultPrevented).toBe(false);
      unmount();
    }
  });
});

describe("the cell editor during an input method conversion", () => {
  it("does not commit on the Enter that confirms the conversion", async () => {
    const { session, sheet, grid, container } = await renderGrid();
    fireEvent.keyDown(grid, { key: "Process", keyCode: 229 });
    const input = editor(container)!;
    type(input, "日本");
    const confirm = createEvent.keyDown(input, { key: "Enter", isComposing: true, keyCode: 229 });
    fireEvent(input, confirm);
    expect(editor(container)).not.toBeNull();
    expect(confirm.defaultPrevented).toBe(false);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(editor(container)).toBeNull();
    expect(session.cell(sheet, 0, 0).value).toBe("日本");
  });
});
