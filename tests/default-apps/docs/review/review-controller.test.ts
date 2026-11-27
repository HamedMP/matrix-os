// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { EditorCore } from "../../../../home/apps/docs/src/editor/index";
import { ReviewController, type ReviewItem } from "../../../../home/apps/docs/src/review/index";
import type { DocumentSession } from "../../../../home/apps/docs/src/session/index";
import { ALEX, PRIYA, fixtureSession, plainSession, revisionIds } from "./helpers";

interface Mounted {
  session: DocumentSession;
  editor: EditorCore;
  review: ReviewController;
  host: HTMLElement;
  scrolled: unknown[];
}

const mounted: Mounted[] = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    entry.review.dispose();
    entry.editor.unmount();
    entry.host.remove();
    entry.session.dispose();
  }
});

async function mountReview(session: DocumentSession): Promise<Mounted> {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = new EditorCore(session, { log: () => undefined });
  editor.mount(host);
  const scrolled: unknown[] = [];
  const scrollTo = editor.scrollTo.bind(editor);
  editor.scrollTo = (target, options) => {
    scrolled.push(target);
    return scrollTo(target, options);
  };
  const review = new ReviewController(session, { editor, log: () => undefined });
  const entry = { session, editor, review, host, scrolled };
  mounted.push(entry);
  return entry;
}

/** Highlight ids on the spans of a layer; a span lists the ids of every layer it is in. */
function painted(host: HTMLElement, layer: string): string[] {
  const prefix = layer === "review" ? "revision:" : "thread:";
  return [...host.querySelectorAll(`.doc-hl-${layer}`)].flatMap((span) => (span.getAttribute("data-hl-id") ?? "").split(/\s+/).filter((id) => id.startsWith(prefix)));
}

function walk(review: ReviewController, direction: "next" | "previous"): string[] {
  const visited: string[] = [];
  while (direction === "next" ? review.next() : review.previous()) visited.push(review.getSnapshot().current!.id);
  return visited;
}

describe("ReviewController stepping", () => {
  it("steps through revisions in document order, highlighting and scrolling to each", async () => {
    const { review, host, scrolled, session } = await mountReview(await fixtureSession("tracked.docx"));
    const items = review.getSnapshot().items;
    expect(items).toHaveLength(14);
    const forward = walk(review, "next");
    expect(forward).toEqual(items.map((item) => item.id));
    expect(scrolled).toHaveLength(14);
    expect(review.getSnapshot().currentIndex).toBe(13);
    // Document order is the order the paragraphs appear in the editor.
    const blockOrder = [...host.querySelectorAll("[data-block-id]")].map((element) => element.getAttribute("data-block-id"));
    const firstBlocks = items.filter((item) => item.range !== null).map((item) => blockOrder.indexOf(item.range!.start.blockId));
    expect(firstBlocks).toEqual([...firstBlocks].sort((a, b) => a - b));
    // The current revision is painted in the review layer.
    const last = review.getSnapshot().current!;
    expect(painted(host, "review").every((id) => id === `revision:${last.id}`)).toBe(true);
    expect(painted(host, "review").length).toBeGreaterThan(0);
    review.select(null);
    expect(painted(host, "review")).toEqual([]);
    expect(walk(review, "previous")).toEqual([...forward].reverse());
    expect(session.getState().canUndo).toBe(false);
  });

  it("starts from the caret when no revision is current", async () => {
    const { review, editor } = await mountReview(await fixtureSession("tracked.docx"));
    const items = review.getSnapshot().items;
    const target = items.find((item) => item.text === " percent.")!;
    editor.setSelection({ blockId: target.range!.start.blockId, offset: target.range!.start.offset });
    expect(review.next()).toBe(true);
    expect(review.getSnapshot().current!.id).toBe(target.id);
  });

  it("paints paragraph formatting and table row revisions on their paragraphs", async () => {
    const { review, host } = await mountReview(await fixtureSession("tracked.docx"));
    const row = review.getSnapshot().items.find((item) => item.scope === "tableRow")!;
    review.select(row.id);
    const cells = [...host.querySelectorAll(".doc-hl-review")].map((span) => span.closest("[data-block-id]")?.getAttribute("data-block-id"));
    expect(new Set(cells)).toEqual(new Set(row.blockIds.filter((id) => host.querySelector(`[data-block-id="${id}"]`)?.getAttribute("data-block-type") === "paragraph")));
  });
});

describe("ReviewController filters", () => {
  it("steps and resolves only what the filter shows", async () => {
    const { review, session } = await mountReview(await fixtureSession("tracked.docx"));
    review.setFilter({ authors: [PRIYA] });
    const visible = review.getSnapshot().visible;
    expect(visible.every((item) => item.author === PRIYA)).toBe(true);
    expect(review.getSnapshot().groups.map((group) => group.author)).toEqual([PRIYA]);
    expect(walk(review, "next")).toEqual(visible.map((item) => item.id));
    expect(review.acceptAll().ok).toBe(true);
    const left = session.requireDocument().listRevisions();
    expect(left.length).toBeGreaterThan(0);
    expect(left.every((revision) => revision.author === ALEX)).toBe(true);
    review.clearFilter();
    review.setFilter({ category: "formatting" });
    expect(review.getSnapshot().visible.map((item) => item.scope).sort()).toEqual(["paragraphFormat", "runFormat"]);
  });

  it("resolves by author only the shown changes of that author", async () => {
    const { review, session } = await mountReview(await fixtureSession("tracked.docx"));
    const alexSubstantive = review.getSnapshot().items.filter((item) => item.author === ALEX && item.category === "substantive").map((item) => item.id);
    expect(alexSubstantive.length).toBeGreaterThan(0);
    review.setFilter({ category: "formatting" });
    const shown = review.getSnapshot().visible.filter((item) => item.author === ALEX).map((item) => item.id);
    expect(shown.length).toBeGreaterThan(0);
    expect(review.acceptByAuthor(ALEX).ok).toBe(true);
    const left = revisionIds(session);
    expect(left.filter((id) => shown.includes(id))).toEqual([]);
    expect(alexSubstantive.every((id) => left.includes(id))).toBe(true);
    review.setFilter({ category: "all", kinds: ["insert"] });
    const inserts = review.getSnapshot().visible.filter((item) => item.author === ALEX).map((item) => item.id);
    const hiddenDelete = review.getSnapshot().items.find((item) => item.author === ALEX && item.kind === "delete")!;
    expect(review.rejectByAuthor(ALEX).ok).toBe(true);
    expect(revisionIds(session).filter((id) => inserts.includes(id))).toEqual([]);
    expect(revisionIds(session)).toContain(hiddenDelete.id);
  });

  it("accepts only the shown formatting changes while a filter is on", async () => {
    const { review, session } = await mountReview(await fixtureSession("tracked.docx"));
    review.setFilter({ authors: [PRIYA] });
    expect(review.getSnapshot().formattingCount).toBe(0);
    expect(review.acceptFormatting()).toEqual({ ok: false, reason: "nothing" });
    expect(revisionIds(session)).toHaveLength(14);
    review.setFilter({ authors: [ALEX] });
    expect(review.getSnapshot().formattingCount).toBe(2);
    expect(review.acceptFormatting().ok).toBe(true);
    expect(revisionIds(session)).toHaveLength(12);
  });

  it("drops the current revision when the filter hides it", async () => {
    const { review } = await mountReview(await fixtureSession("tracked.docx"));
    const alex = review.getSnapshot().items.find((item) => item.author === ALEX)!;
    review.select(alex.id);
    review.setFilter({ authors: [PRIYA] });
    expect(review.getSnapshot().current).toBeNull();
  });
});

describe("ReviewController accept and reject", () => {
  it("accepts the current revision, moves to the next, and undo restores it", async () => {
    const { review, session } = await mountReview(await fixtureSession("tracked.docx"));
    review.next();
    review.next();
    const [, second, third] = review.getSnapshot().items as ReviewItem[];
    expect(review.getSnapshot().current!.id).toBe(second!.id);
    const outcome = review.accept();
    expect(outcome.ok).toBe(true);
    expect(revisionIds(session)).not.toContain(second!.id);
    expect(review.getSnapshot().current!.id).toBe(third!.id);
    expect(review.getSnapshot().items).toHaveLength(13);
    expect(session.undo()).toBe(true);
    expect(review.getSnapshot().items).toHaveLength(14);
    expect(revisionIds(session)).toContain(second!.id);
  });

  it("rejecting the last revision moves to the one before it", async () => {
    const { review } = await mountReview(await fixtureSession("tracked.docx"));
    const items = review.getSnapshot().items;
    // The last one is a move: rejecting it also resolves its other half.
    const last = items[items.length - 1]!;
    review.select(last.id);
    expect(review.reject().ok).toBe(true);
    const current = review.getSnapshot().current!;
    expect(current.order).toBe(review.getSnapshot().items.length - 1);
  });

  it("accepts the revisions in the editor selection", async () => {
    const { review, editor, session } = await mountReview(await fixtureSession("tracked.docx"));
    const items = review.getSnapshot().items;
    const ten = items.find((item) => item.text === "ten")!;
    const fifteen = items.find((item) => item.text === "fifteen")!;
    editor.setSelection({ anchor: ten.range!.start, focus: fifteen.range!.end });
    expect(review.selectedItems().map((item) => item.id).sort()).toEqual([ten.id, fifteen.id].sort());
    expect(review.acceptSelection().ok).toBe(true);
    expect(session.requireDocument().getPlainText({ view: "original" })).toContain("within fifteen business days");
    expect(revisionIds(session)).toHaveLength(12);
  });

  it("accepts formatting changes in one action and keeps the substantive ones", async () => {
    const { review, session } = await mountReview(await fixtureSession("tracked.docx"));
    expect(review.getSnapshot().formattingCount).toBe(2);
    expect(review.acceptFormatting().ok).toBe(true);
    expect(review.getSnapshot().formattingCount).toBe(0);
    expect(review.getSnapshot().items.every((item) => item.category === "substantive")).toBe(true);
    expect(review.getSnapshot().items).toHaveLength(12);
    session.undo();
    expect(review.getSnapshot().formattingCount).toBe(2);
  });

  it("accepts and rejects by author", async () => {
    const { review } = await mountReview(await fixtureSession("tracked.docx"));
    expect(review.rejectByAuthor(PRIYA).ok).toBe(true);
    expect(review.getSnapshot().authors).toEqual([ALEX]);
    expect(review.acceptByAuthor(ALEX).ok).toBe(true);
    expect(review.getSnapshot().items).toEqual([]);
    expect(review.accept()).toEqual({ ok: false, reason: "nothing" });
  });

  it("runs the keyboard shortcuts", async () => {
    const { review, session } = await mountReview(await fixtureSession("tracked.docx"));
    const keys = (code: string) => ({ code, altKey: true, shiftKey: true, ctrlKey: false, metaKey: false });
    expect(review.handleShortcut(keys("KeyN"))).toBe(true);
    const first = review.getSnapshot().current!;
    expect(first.order).toBe(0);
    expect(review.handleShortcut(keys("KeyR"))).toBe(true);
    expect(revisionIds(session)).not.toContain(first.id);
    expect(review.handleShortcut(keys("KeyN"))).toBe(true);
    expect(review.handleShortcut(keys("KeyP"))).toBe(true);
    const current = review.getSnapshot().current!;
    expect(review.handleShortcut(keys("KeyA"))).toBe(true);
    expect(revisionIds(session)).not.toContain(current.id);
    const before = review.getSnapshot().composeRequest;
    expect(review.handleShortcut(keys("KeyM"))).toBe(true);
    expect(review.getSnapshot().composeRequest).toBe(before + 1);
    // A shell that can hide the comment box opens it through its own action instead.
    const comment = vi.fn();
    expect(review.handleShortcut(keys("KeyM"), { comment })).toBe(true);
    expect(comment).toHaveBeenCalledTimes(1);
    expect(review.getSnapshot().composeRequest).toBe(before + 1);
    expect(review.handleShortcut({ ...keys("KeyN"), ctrlKey: true })).toBe(false);
    expect(review.handleShortcut({ ...keys("KeyN"), altKey: false })).toBe(false);
  });

  it("keeps the original view read-only: navigation works, nothing is resolved or commented", async () => {
    const { review, editor, session } = await mountReview(await fixtureSession("tracked.docx"));
    const keys = (code: string) => ({ code, altKey: true, shiftKey: true, ctrlKey: false, metaKey: false });
    editor.setViewMode("original");
    expect(review.handleShortcut(keys("KeyN"))).toBe(true);
    const current = review.getSnapshot().current!;
    expect(current.order).toBe(0);
    expect(review.handleShortcut(keys("KeyN"))).toBe(true);
    expect(review.handleShortcut(keys("KeyP"))).toBe(true);
    expect(review.getSnapshot().current!.id).toBe(current.id);
    const composeBefore = review.getSnapshot().composeRequest;
    expect(review.handleShortcut(keys("KeyA"))).toBe(false);
    expect(review.handleShortcut(keys("KeyR"))).toBe(false);
    expect(review.handleShortcut(keys("KeyM"))).toBe(false);
    const comment = vi.fn();
    expect(review.handleShortcut(keys("KeyM"), { comment })).toBe(false);
    expect(comment).not.toHaveBeenCalled();
    expect(review.getSnapshot().composeRequest).toBe(composeBefore);
    const readOnly = { ok: false, reason: "read_only" };
    expect(review.accept()).toEqual(readOnly);
    expect(review.reject()).toEqual(readOnly);
    expect(review.acceptAll()).toEqual(readOnly);
    expect(review.rejectAll()).toEqual(readOnly);
    expect(review.acceptByAuthor(ALEX)).toEqual(readOnly);
    expect(review.rejectByAuthor(PRIYA)).toEqual(readOnly);
    expect(review.acceptFormatting()).toEqual(readOnly);
    review.select(null);
    editor.setSelection({ anchor: current.range!.start, focus: current.range!.end });
    expect(review.acceptSelection()).toEqual(readOnly);
    expect(review.rejectSelection()).toEqual(readOnly);
    expect(review.addComment("Why?")).toEqual(readOnly);
    expect(revisionIds(session)).toHaveLength(14);
    expect(session.getState().canUndo).toBe(false);
    expect(review.getSnapshot().error).toBeNull();
    editor.setViewMode("markup");
    review.select(current.id);
    expect(review.handleShortcut(keys("KeyA"))).toBe(true);
    expect(revisionIds(session)).toHaveLength(13);
  });

  it("does not reply to or resolve comments in the original view", async () => {
    const { review, editor, session } = await mountReview(await plainSession(["The fee is due on signing."]));
    const blockId = session.requireDocument().getView().body.blocks[0]!.id;
    editor.setSelection({ anchor: { blockId, offset: 4 }, focus: { blockId, offset: 7 } });
    expect(review.addComment("Which fee?").ok).toBe(true);
    const thread = review.getSnapshot().activeThread!;
    editor.setViewMode("original");
    expect(review.reply(thread.id, "The set-up fee.")).toEqual({ ok: false, reason: "read_only" });
    expect(review.resolveThread(thread.id)).toEqual({ ok: false, reason: "read_only" });
    expect(review.getSnapshot().threads[0]).toMatchObject({ resolved: false, replies: [] });
  });
});

describe("ReviewController comments", () => {
  it("adds a comment on the selection, marks it in the margin, replies and resolves", async () => {
    const { review, editor, host, session } = await mountReview(await plainSession(["The fee is due on signing.", "Second"]));
    const blockId = session.requireDocument().getView().body.blocks[0]!.id;
    editor.setSelection({ anchor: { blockId, offset: 4 }, focus: { blockId, offset: 7 } });
    const added = review.addComment("Which fee?");
    expect(added.ok).toBe(true);
    const thread = review.getSnapshot().activeThread!;
    expect(thread.anchorText).toBe("fee");
    expect(painted(host, "comment-mark")).toContain(`thread:${thread.id}`);
    expect(painted(host, "comment")).toContain(`thread:${thread.id}`);
    expect(review.reply(thread.id, "The set-up fee.").ok).toBe(true);
    expect(review.getSnapshot().threads[0]!.replies).toHaveLength(1);
    expect(review.resolveThread(thread.id).ok).toBe(true);
    expect(review.getSnapshot().visibleThreads).toEqual([]);
    expect(painted(host, "comment-mark")).toEqual([]);
    review.setShowResolved(true);
    expect(review.getSnapshot().visibleThreads).toHaveLength(1);
    // Three undo steps: resolve, reply, add.
    session.undo();
    session.undo();
    session.undo();
    expect(review.getSnapshot().threads).toEqual([]);
    expect(review.getSnapshot().activeThread).toBeNull();
  });

  it("explains why a comment could not be added and clears the message on success", async () => {
    const { review, editor, session } = await mountReview(await plainSession(["Hello world"]));
    const blockId = session.requireDocument().getView().body.blocks[0]!.id;
    editor.setSelection({ blockId, offset: 2 });
    expect(review.addComment("Hi")).toEqual({ ok: false, reason: "no_selection" });
    expect(review.getSnapshot().commentError).toMatch(/Select the text/);
    expect(review.getSnapshot().error).toBeNull();
    editor.setSelection({ anchor: { blockId, offset: 0 }, focus: { blockId, offset: 5 } });
    expect(review.addComment("Hi").ok).toBe(true);
    expect(review.getSnapshot().commentError).toBeNull();
  });

  it("selects a thread and scrolls to its anchor", async () => {
    const { review, scrolled } = await mountReview(await fixtureSession("comments.docx"));
    const [, vat] = review.getSnapshot().threads;
    expect(review.selectThread(vat!.id)).toBe(true);
    expect(scrolled.at(-1)).toEqual(vat!.range);
    expect(review.selectThread("missing")).toBe(false);
  });

  it("resets on another document and stops following the session after dispose", async () => {
    const { review, session } = await mountReview(await fixtureSession("tracked.docx"));
    review.next();
    review.setFilter({ authors: [ALEX] });
    await session.createNew({ discardChanges: true });
    expect(review.getSnapshot()).toMatchObject({ items: [], current: null, filtered: false });
    review.dispose();
  });
});
