// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Dialog, DialogTitle, DialogFooter } from "../../packages/ui/src/Dialog";

describe("Dialog", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <Dialog open={false} onClose={() => {}}>
        Content
      </Dialog>
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders content when open", () => {
    render(
      <Dialog open={true} onClose={() => {}}>
        Dialog content
      </Dialog>
    );
    expect(screen.getByText("Dialog content")).toBeTruthy();
  });

  it("has dialog role and aria-modal", () => {
    render(
      <Dialog open={true} onClose={() => {}}>
        Content
      </Dialog>
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("calls onClose when clicking overlay backdrop", () => {
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

  it("calls onClose on Escape key", () => {
    const onClose = vi.fn();
    render(
      <Dialog open={true} onClose={onClose}>
        Content
      </Dialog>
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("accepts custom className", () => {
    render(
      <Dialog open={true} onClose={() => {}} className="custom-dialog">
        Content
      </Dialog>
    );
    const dialog = screen.getByRole("dialog").querySelector(".custom-dialog");
    expect(dialog).toBeTruthy();
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
