// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import React, { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentEditor, type DocumentEditorController } from "../../../../home/apps/docs/src/editor/index";
import type { ReviewController } from "../../../../home/apps/docs/src/review/index";
import type { DocumentSession } from "../../../../home/apps/docs/src/session/index";
import {
  CommentsPanel,
  HOVER_SHOW_DELAY_MS,
  ReviewPanel,
  RevisionHoverCard,
  hoverTargetOf,
  placeCard,
  useCommentClicks,
  useReviewController,
  useReviewShortcuts,
} from "../../../../home/apps/docs/src/ui/review/index";
import { ALEX, PRIYA, fixtureSession, plainSession, revisionIds } from "./helpers";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

let latest: { review: ReviewController | null; editor: DocumentEditorController | null; surface: HTMLDivElement | null } = { review: null, editor: null, surface: null };

function Harness({ session }: { session: DocumentSession }) {
  const [editor, setEditor] = useState<DocumentEditorController | null>(null);
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const review = useReviewController(session, editor);
  useReviewShortcuts(review);
  useCommentClicks(review, surface);
  latest = { review, editor, surface };
  return (
    <div>
      <div ref={setSurface}>
        <DocumentEditor session={session} ref={setEditor} />
      </div>
      {review && <ReviewPanel controller={review} />}
      {review && <CommentsPanel controller={review} />}
      {review && <RevisionHoverCard controller={review} container={surface} />}
    </div>
  );
}

async function renderHarness(session: DocumentSession) {
  render(<Harness session={session} />);
  await act(async () => undefined);
  return { panel: screen.getByRole("region", { name: "Tracked changes" }), comments: screen.getByRole("region", { name: "Comments" }) };
}

describe("<ReviewPanel>", () => {
  it("lists revisions grouped by author and steps through them with the review bar", async () => {
    const session = await fixtureSession("tracked.docx");
    const { panel } = await renderHarness(session);
    expect(within(panel).getByRole("heading", { name: ALEX })).toBeTruthy();
    expect(within(panel).getByRole("heading", { name: PRIYA })).toBeTruthy();
    expect(within(panel).getByText("14 revisions")).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Next revision" }));
    expect(within(panel).getByText("1 of 14")).toBeTruthy();
    const first = latest.review!.getSnapshot().items[0]!;
    expect(within(panel).getByRole("button", { name: new RegExp(`^${first.kindLabel} by ${first.author}`), current: true })).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Accept revision" }));
    expect(revisionIds(session)).not.toContain(first.id);
    expect(within(panel).getByText("1 of 13")).toBeTruthy();
  });

  it("filters to formatting only and runs the formatting bulk action", async () => {
    const session = await fixtureSession("tracked.docx");
    const { panel } = await renderHarness(session);
    fireEvent.click(within(panel).getByRole("radio", { name: "Formatting only" }));
    expect(within(panel).getAllByRole("listitem")).toHaveLength(2);
    expect(within(panel).getByText(/apply to the 2 shown changes/)).toBeTruthy();
    fireEvent.click(within(panel).getByRole("radio", { name: "All changes" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Accept formatting, keep substantive (2)" }));
    expect(session.requireDocument().listRevisions().every((revision) => revision.kind !== "format")).toBe(true);
    expect(within(panel).getAllByRole("listitem")).toHaveLength(12);
    // The action is one undo step.
    act(() => {
      session.undo();
    });
    expect(within(panel).getAllByRole("listitem")).toHaveLength(14);
  });

  it("filters by author and rejects all changes by one author", async () => {
    const session = await fixtureSession("tracked.docx");
    const { panel } = await renderHarness(session);
    fireEvent.change(within(panel).getByLabelText("Author"), { target: { value: PRIYA } });
    expect(within(panel).queryByRole("heading", { name: ALEX })).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "Clear filters" }));
    fireEvent.click(within(panel).getByRole("button", { name: `Reject all changes by ${ALEX}` }));
    expect(new Set(session.requireDocument().listRevisions().map((revision) => revision.author))).toEqual(new Set([PRIYA]));
  });

  it("accepts from an author group only the changes the filter shows", async () => {
    const session = await fixtureSession("tracked.docx");
    const { panel } = await renderHarness(session);
    const hidden = latest.review!.getSnapshot().items.filter((item) => item.author === ALEX && item.category === "substantive").map((item) => item.id);
    fireEvent.click(within(panel).getByRole("radio", { name: "Formatting only" }));
    fireEvent.click(within(panel).getByRole("button", { name: `Accept all changes by ${ALEX}` }));
    expect(revisionIds(session)).toHaveLength(12);
    expect(hidden.every((id) => revisionIds(session).includes(id))).toBe(true);
  });

  it("keeps navigation but no accept, reject or comment shortcut in the original view", async () => {
    const session = await fixtureSession("tracked.docx");
    const { panel } = await renderHarness(session);
    act(() => latest.editor!.setViewMode("original"));
    const press = (code: string) => {
      const event = new KeyboardEvent("keydown", { code, key: code.slice(3), altKey: true, shiftKey: true, bubbles: true, cancelable: true });
      act(() => {
        document.body.dispatchEvent(event);
      });
      return event;
    };
    expect(press("KeyN").defaultPrevented).toBe(true);
    expect(within(panel).getByText("1 of 14")).toBeTruthy();
    press("KeyA");
    press("KeyR");
    press("KeyM");
    expect(revisionIds(session)).toHaveLength(14);
    expect(document.activeElement).not.toBe(screen.getByLabelText("New comment"));
    expect(press("KeyN").defaultPrevented).toBe(true);
    expect(within(panel).getByText("2 of 14")).toBeTruthy();
  });

  it("accepts one row from its own button and shows an empty state when nothing is left", async () => {
    const session = await fixtureSession("tracked.docx");
    const { panel } = await renderHarness(session);
    fireEvent.click(within(panel).getAllByRole("button", { name: /^Accept: / })[0]!);
    expect(revisionIds(session)).toHaveLength(13);
    fireEvent.click(within(panel).getByRole("button", { name: "Accept all" }));
    expect(within(panel).getByText("No tracked changes")).toBeTruthy();
  });

  it("runs the keyboard shortcuts from anywhere in the window", async () => {
    const session = await fixtureSession("tracked.docx");
    const { panel } = await renderHarness(session);
    const event = new KeyboardEvent("keydown", { code: "KeyN", key: "N", altKey: true, shiftKey: true, bubbles: true, cancelable: true });
    act(() => {
      document.body.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(within(panel).getByText("1 of 14")).toBeTruthy();
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyA", key: "A", altKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(revisionIds(session)).toHaveLength(13);
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyM", key: "M", altKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(screen.getByLabelText("New comment"));
  });
});

describe("<CommentsPanel>", () => {
  it("focuses the comment box when asked by its parent and reports it", async () => {
    const session = await plainSession(["Hello"]);
    const focused = vi.fn();
    function Parent() {
      const review = useReviewController(session, null);
      return review === null ? null : <CommentsPanel controller={review} focusComposer onComposerFocused={focused} />;
    }
    render(<Parent />);
    await act(async () => undefined);
    expect(document.activeElement).toBe(screen.getByLabelText("New comment"));
    expect(focused).toHaveBeenCalledTimes(1);
  });

  it("adds a comment on the editor selection, replies and resolves it", async () => {
    const session = await plainSession(["The fee is due on signing."]);
    const { comments } = await renderHarness(session);
    expect(within(comments).getByText("No comments yet")).toBeTruthy();
    const blockId = session.requireDocument().getView().body.blocks[0]!.id;
    act(() => {
      latest.editor!.setSelection({ anchor: { blockId, offset: 4 }, focus: { blockId, offset: 7 } });
    });
    fireEvent.change(within(comments).getByLabelText("New comment"), { target: { value: "Which fee?" } });
    fireEvent.click(within(comments).getByRole("button", { name: "Comment" }));
    const thread = within(comments).getByRole("article");
    expect(within(thread).getByText("Which fee?")).toBeTruthy();
    expect(within(thread).getByRole("button", { name: "Show in document: “fee”" })).toBeTruthy();
    expect(thread.getAttribute("aria-current")).toBe("true");
    fireEvent.click(within(thread).getByRole("button", { name: "Reply" }));
    fireEvent.change(within(thread).getByLabelText("Reply to Rae Okafor"), { target: { value: "The set-up fee." } });
    fireEvent.click(within(thread).getByRole("button", { name: "Reply" }));
    expect(within(thread).getByText("The set-up fee.")).toBeTruthy();
    fireEvent.click(within(thread).getByRole("button", { name: "Resolve" }));
    expect(within(comments).getByText("No open comments")).toBeTruthy();
    fireEvent.click(within(comments).getByLabelText("Show resolved (1)"));
    expect(within(comments).getByRole("button", { name: "Reopen" })).toBeTruthy();
  });

  it("shows why a comment could not be added", async () => {
    const session = await plainSession(["Hello"]);
    const { comments } = await renderHarness(session);
    fireEvent.change(within(comments).getByLabelText("New comment"), { target: { value: "Hi" } });
    fireEvent.click(within(comments).getByRole("button", { name: "Comment" }));
    expect(within(comments).getByRole("alert").textContent).toMatch(/Select the text/);
  });

  it("makes a thread active when its text is clicked in the document", async () => {
    const session = await fixtureSession("comments.docx");
    const { comments } = await renderHarness(session);
    const vat = latest.review!.getSnapshot().threads[1]!;
    const span = latest.surface!.querySelector(`[data-comment-ids~="${vat.id}"]`)!;
    fireEvent.click(span);
    expect(latest.review!.getSnapshot().activeThread?.id).toBe(vat.id);
    const active = within(comments).getAllByRole("article").find((article) => article.getAttribute("aria-current") === "true")!;
    expect(within(active).getByText(/EUR 240,000/)).toBeTruthy();
    // The margin mark layer covers both open threads.
    expect(latest.surface!.querySelectorAll(".doc-hl-comment-mark").length).toBeGreaterThan(0);
  });
});

describe("<RevisionHoverCard>", () => {
  it("shows author, date and kind over a tracked change and accepts it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const session = await fixtureSession("tracked.docx");
    await renderHarness(session);
    const target = latest.review!.getSnapshot().items.find((item) => item.text === "fifteen")!;
    const span = latest.surface!.querySelector(`[data-revision-id="${target.id}"]`)!;
    fireEvent.pointerOver(span);
    act(() => {
      vi.advanceTimersByTime(HOVER_SHOW_DELAY_MS + 10);
    });
    const card = screen.getByRole("region", { name: "Tracked change" });
    expect(within(card).getByText(PRIYA)).toBeTruthy();
    expect(within(card).getByText("Inserted")).toBeTruthy();
    expect(within(card).getByText("fifteen")).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Accept" }));
    expect(revisionIds(session)).not.toContain(target.id);
    expect(screen.queryByRole("region", { name: "Tracked change" })).toBeNull();
  });
});

describe("hover helpers", () => {
  it("finds the revisions under a node", () => {
    const container = document.createElement("div");
    container.innerHTML = '<span data-revision-id="r1" data-format-revision-id="r2"><b id="inner">x</b></span><span id="plain">y</span>';
    expect(hoverTargetOf(container.querySelector("#inner"), container)?.revisionIds).toEqual(["r1", "r2"]);
    expect(hoverTargetOf(container.querySelector("#plain"), container)).toBeNull();
    expect(hoverTargetOf(null, container)).toBeNull();
  });

  it("places the card below the text, or above it near the bottom, inside the window", () => {
    const viewport = { width: 800, height: 600 };
    const card = { width: 280, height: 140 };
    expect(placeCard({ left: 100, top: 100, bottom: 120 }, card, viewport)).toEqual({ left: 100, top: 126 });
    expect(placeCard({ left: 700, top: 540, bottom: 560 }, card, viewport)).toEqual({ left: 514, top: 394 });
  });
});
