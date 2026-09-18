// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { SessionDiscussionLayer } from "../../packages/ui/src/collaboration/SessionDiscussionLayer";

const discussion = {
  messages: [{
    id: "note-1",
    scopeId: "10000000-0000-4000-8000-000000000001",
    sequence: "1",
    actor: { actorId: "ada", displayName: "Ada" },
    text: "Human-only note",
    createdAt: "2026-09-17T12:00:00.000Z",
  }],
  latestSequence: "1",
  draft: "",
  setDraft: vi.fn(),
  loading: false,
  sending: false,
  error: false,
  send: vi.fn(async () => undefined),
  readOnly: false,
};

describe("SessionDiscussionLayer", () => {
  it("is an overlay dialog, explains AI isolation, and supports light dismiss", () => {
    const close = vi.fn();
    render(<SessionDiscussionLayer open onClose={close} discussion={discussion} />);
    expect(screen.getByRole("dialog", { name: "Discussion" })).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText(/not prompts for AI/i)).toBeVisible();
    expect(document.querySelector('[data-slot="session-discussion-layer"]')).toHaveClass("absolute", "inset-0");
    fireEvent.click(screen.getByRole("button", { name: "Close discussion" }));
    expect(close).toHaveBeenCalledOnce();
  });

  it("supports Escape and makes viewer discussion read-only", () => {
    const close = vi.fn();
    render(<SessionDiscussionLayer open onClose={close} discussion={{ ...discussion, readOnly: true }} />);
    expect(screen.getByLabelText("Add a discussion note")).toBeDisabled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("contains keyboard focus and uses the confirmed full-height mobile presentation", async () => {
    render(<SessionDiscussionLayer open onClose={vi.fn()} discussion={{ ...discussion, draft: "Private draft" }} />);
    const dialog = screen.getByRole("dialog", { name: "Discussion" });
    const close = screen.getByRole("button", { name: "Close discussion panel" });
    const post = screen.getByRole("button", { name: "Post note" });

    await waitFor(() => expect(close).toHaveFocus());
    expect(dialog).toHaveClass("w-full", "bg-background", "sm:w-96");
    post.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(close).toHaveFocus();
    close.focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(post).toHaveFocus();
  });
});
