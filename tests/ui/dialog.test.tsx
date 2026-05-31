// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Dialog } from "../../packages/ui/src/Dialog";
import { DialogTitle } from "../../packages/ui/src/DialogTitle";
import { DialogFooter } from "../../packages/ui/src/DialogFooter";

// jsdom does not implement the modal <dialog> methods; stub them so they reflect
// the open state and let us assert the controlled open/close wiring.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.open = true;
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false;
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Dialog", () => {
  it("opens via showModal() when open", () => {
    render(
      <Dialog open={true} onClose={() => {}}>
        Content
      </Dialog>
    );
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(1);
  });

  it("does not open when closed", () => {
    render(
      <Dialog open={false} onClose={() => {}}>
        Content
      </Dialog>
    );
    expect(HTMLDialogElement.prototype.showModal).not.toHaveBeenCalled();
  });

  it("renders content when open", () => {
    render(
      <Dialog open={true} onClose={() => {}}>
        Dialog content
      </Dialog>
    );
    expect(screen.getByText("Dialog content")).toBeTruthy();
  });

  it("renders a native <dialog> with the overlay class", () => {
    const { container } = render(
      <Dialog open={true} onClose={() => {}}>
        Content
      </Dialog>
    );
    expect(container.querySelector("dialog.matrix-dialog-overlay")).toBeTruthy();
  });

  it("calls onClose when clicking the backdrop (the dialog element itself)", () => {
    const onClose = vi.fn();
    const { container } = render(
      <Dialog open={true} onClose={onClose}>
        Content
      </Dialog>
    );
    const overlay = container.querySelector(".matrix-dialog-overlay")!;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not call onClose when clicking content", () => {
    const onClose = vi.fn();
    render(
      <Dialog open={true} onClose={onClose}>
        <div>Inner content</div>
      </Dialog>
    );
    fireEvent.click(screen.getByText("Inner content"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose on the native cancel (Escape) event and prevents the default close", () => {
    const onClose = vi.fn();
    const { container } = render(
      <Dialog open={true} onClose={onClose}>
        Content
      </Dialog>
    );
    const dialog = container.querySelector("dialog")!;
    const cancel = new Event("cancel", { cancelable: true });
    dialog.dispatchEvent(cancel);
    expect(onClose).toHaveBeenCalledOnce();
    expect(cancel.defaultPrevented).toBe(true);
  });

  it("closes the dialog when the open prop flips to false", () => {
    const { rerender } = render(
      <Dialog open={true} onClose={() => {}}>
        Content
      </Dialog>
    );
    rerender(
      <Dialog open={false} onClose={() => {}}>
        Content
      </Dialog>
    );
    expect(HTMLDialogElement.prototype.close).toHaveBeenCalled();
  });

  it("applies a custom className to the content", () => {
    const { container } = render(
      <Dialog open={true} onClose={() => {}} className="custom-dialog">
        Content
      </Dialog>
    );
    expect(container.querySelector(".matrix-dialog.custom-dialog")).toBeTruthy();
  });
});

describe("DialogTitle", () => {
  it("renders as h2", () => {
    render(<DialogTitle>My Title</DialogTitle>);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("My Title");
  });
});

describe("DialogFooter", () => {
  it("renders children", () => {
    render(<DialogFooter>Footer content</DialogFooter>);
    expect(screen.getByText("Footer content")).toBeTruthy();
  });
});
