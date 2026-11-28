// @vitest-environment jsdom
import React, { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DestructiveConfirmDialog } from "../../packages/ui/src/DestructiveConfirmDialog";

// ENG-521: the Terminal window's "End …?" confirm matches the app's destructive confirm
// (bordered Cancel, solid destructive action, key hint) with Esc, Enter, backdrop and focus return.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false; });
});
afterEach(() => { cleanup(); });

function Harness({ onConfirm }: { onConfirm(): void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>pane</button>
      <DestructiveConfirmDialog open={open} title="End “a very long agent topic that keeps going”?" body="Its program is still running and will stop."
        confirmLabel="End pane" confirmVerb="End" onCancel={() => setOpen(false)} onConfirm={() => { onConfirm(); setOpen(false); }} />
    </>
  );
}

function openFromPane(onConfirm = vi.fn()) {
  render(<Harness onConfirm={onConfirm} />);
  const pane = screen.getByRole("button", { name: "pane" });
  pane.focus();
  fireEvent.click(pane);
  return { pane, onConfirm, dialog: screen.getByRole("alertdialog", { name: /^End “/ }) };
}

describe("DestructiveConfirmDialog", () => {
  it("shows a one-line title, the body, both actions and the key hint, with the action focused for Enter", () => {
    const { dialog } = openFromPane();
    const title = screen.getByRole("heading", { name: /^End “/ });
    expect(title.style.whiteSpace).toBe("nowrap");
    expect(title.getAttribute("title")).toBe("End “a very long agent topic that keeps going”?");
    expect(document.getElementById(dialog.getAttribute("aria-describedby")!)?.textContent).toBe("Its program is still running and will stop.");
    expect(screen.getByRole("button", { name: "Cancel" }).className).toContain("matrix-btn-secondary");
    const action = screen.getByRole("button", { name: "End pane" });
    expect(action.className).toContain("matrix-btn-destructive");
    expect(document.activeElement).toBe(action);
    expect(screen.getByText("↵ End")).toBeTruthy();
    expect(screen.getByText("esc Cancel")).toBeTruthy();
  });

  it("confirms with the action and returns focus to the pane", () => {
    const { pane, onConfirm } = openFromPane();
    fireEvent.click(screen.getByRole("button", { name: "End pane" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(pane);
  });

  it("cancels on Esc and on a backdrop click, and returns focus to the pane", () => {
    const first = openFromPane();
    const dialogElement = first.dialog.closest("dialog")!;
    fireEvent(dialogElement, new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(first.onConfirm).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(first.pane);

    fireEvent.click(first.pane);
    const backdrop = screen.getByRole("alertdialog", { name: /^End “/ }).closest("dialog")!;
    fireEvent.click(backdrop);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(first.onConfirm).not.toHaveBeenCalled();
  });
});
