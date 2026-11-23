// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalFindBar, type TerminalSearch } from "@desktop/renderer/src/features/terminal/TerminalFindBar";

// Spec 2706: Cmd+F in the Terminal window finds text in the terminal on screen.
function searchStub() {
  let listener: (result: { resultIndex: number; resultCount: number }) => void = () => undefined;
  const search = {
    findNext: vi.fn(() => { listener({ resultIndex: 0, resultCount: 2 }); return true; }),
    findPrevious: vi.fn(() => true),
    clearDecorations: vi.fn(),
    onDidChangeResults: vi.fn((next: typeof listener) => { listener = next; return { dispose: vi.fn() }; }),
  };
  return search as unknown as TerminalSearch & typeof search;
}

describe("TerminalFindBar", () => {
  afterEach(cleanup);

  // Fault detected (Greptile, #3567): the field was a hand-styled native input; it is the shared Input now.
  it("takes typing on open and again on each Cmd+F, finds forward, back, and closes on Escape", () => {
    const search = searchStub();
    const onClose = vi.fn();
    const { rerender } = render(<TerminalFindBar search={search} request={1} onClose={onClose} />);
    const field = screen.getByRole("textbox", { name: "Find in terminal" });
    expect(field.classList.contains("matrix-input")).toBe(true);
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: "error" } });
    expect(search.findNext).toHaveBeenLastCalledWith("error", expect.anything());
    expect(screen.getByText("1 of 2")).toBeTruthy();
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    expect(search.findPrevious).toHaveBeenCalledWith("error", expect.anything());
    (document.activeElement as HTMLElement).blur();
    rerender(<TerminalFindBar search={search} request={2} onClose={onClose} />);
    const again = screen.getByRole("textbox", { name: "Find in terminal" });
    expect(document.activeElement).toBe(again);
    expect((again as HTMLInputElement).value).toBe("error");
    fireEvent.keyDown(again, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
