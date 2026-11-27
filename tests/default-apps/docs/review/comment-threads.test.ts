import { describe, expect, it } from "vitest";
import type { DocxComment } from "../../../../home/apps/_shared/office-engine/index";
import { ModelIndex } from "../../../../home/apps/docs/src/editor/model-index";
import {
  MAX_COMMENT_LENGTH,
  addComment,
  buildThreads,
  checkCommentText,
  filterThreads,
  replyToComment,
  setCommentResolved,
  threadOfComment,
  threadsAt,
} from "../../../../home/apps/docs/src/review/index";
import { ALEX, OWNER, PRIYA, fixtureSession, plainSession } from "./helpers";

function threadsOf(session: Awaited<ReturnType<typeof fixtureSession>>) {
  const doc = session.requireDocument();
  return buildThreads(doc.listComments(), ModelIndex.build(doc.getView()));
}

describe("buildThreads", () => {
  it("groups replies under their thread in document order of the anchors", async () => {
    const session = await fixtureSession("comments.docx");
    const threads = threadsOf(session);
    expect(threads).toHaveLength(2);
    const [parking, vat] = threads;
    expect(parking).toMatchObject({ anchorText: "the riverside building", resolved: false });
    expect(parking!.root.author).toBe(ALEX);
    expect(parking!.replies.map((reply) => [reply.author, reply.text])).toEqual([[PRIYA, "Yes, 40 spaces are included."]]);
    expect(vat!.anchorText).toBe("EUR 240,000");
    expect(vat!.replies).toEqual([]);
    expect(threadOfComment(threads, parking!.replies[0]!.id)?.id).toBe(parking!.id);
    const doc = session.requireDocument();
    const index = ModelIndex.build(doc.getView());
    const inside = { blockId: parking!.range!.start.blockId, offset: parking!.range!.start.offset + 3 };
    expect(threadsAt(threads, index, inside).map((thread) => thread.id)).toEqual([parking!.id]);
  });

  it("follows reply chains to the root, sorts replies by date and puts unanchored threads last", () => {
    const base = { initials: null, anchorText: "", resolved: false };
    const range = { start: { blockId: "b1", offset: 0 }, end: { blockId: "b1", offset: 2 } };
    const comments: DocxComment[] = [
      { ...base, id: "lost", parentId: null, author: "A", date: null, text: "orphan", range: null },
      { ...base, id: "r", parentId: null, author: "A", date: "2026-01-01T00:00:00Z", text: "root", range },
      { ...base, id: "late", parentId: "r", author: "B", date: "2026-01-03T00:00:00Z", text: "late", range },
      { ...base, id: "deep", parentId: "early", author: "C", date: "2026-01-04T00:00:00Z", text: "deep", range },
      { ...base, id: "early", parentId: "r", author: "B", date: "2026-01-02T00:00:00Z", text: "early", range },
      { ...base, id: "loopA", parentId: "loopB", author: "D", date: null, text: "a", range: null },
      { ...base, id: "loopB", parentId: "loopA", author: "D", date: null, text: "b", range: null },
    ];
    const index = ModelIndex.build({
      body: { id: "body", kind: "body", label: "Body", blocks: [] },
      headers: [],
      footers: [],
      footnotes: [],
      endnotes: [],
      sections: [],
      trackRevisions: false,
      revisionCount: 0,
      commentCount: 0,
    });
    const threads = buildThreads(comments, index);
    const root = threads.find((thread) => thread.id === "r")!;
    expect(root.replies.map((reply) => reply.id)).toEqual(["early", "late", "deep"]);
    expect(threads.find((thread) => thread.id === "lost")).toBeDefined();
    // A cycle ends at a comment of the cycle instead of looping forever.
    expect(threads.flatMap((thread) => [thread.id, ...thread.replies.map((reply) => reply.id)]).filter((id) => id.startsWith("loop")).sort()).toEqual(["loopA", "loopB"]);
  });

  it("hides resolved threads unless asked", async () => {
    const session = await fixtureSession("comments.docx");
    const first = threadsOf(session)[0]!;
    expect(setCommentResolved(session, first.id, true).ok).toBe(true);
    const threads = threadsOf(session);
    expect(threads.find((thread) => thread.id === first.id)!.resolved).toBe(true);
    expect(filterThreads(threads, { showResolved: false }).map((thread) => thread.id)).not.toContain(first.id);
    expect(filterThreads(threads, { showResolved: true })).toHaveLength(2);
  });
});

describe("comment actions", () => {
  it("adds a thread on a range by the session author, replies to it, and undoes each step", async () => {
    const session = await plainSession(["The fee is due on signing.", "Second paragraph"]);
    const doc = session.requireDocument();
    const blockId = doc.getView().body.blocks[0]!.id;
    const range = { start: { blockId, offset: 4 }, end: { blockId, offset: 7 } };

    const added = addComment(session, range, "  Which fee?  ");
    expect(added.ok).toBe(true);
    const [thread] = threadsOf(session);
    expect(thread).toMatchObject({ anchorText: "fee", resolved: false });
    expect(thread!.root).toMatchObject({ author: OWNER, text: "Which fee?" });
    expect(added.ok && added.commentId).toBe(thread!.id);

    expect(replyToComment(session, thread!.id, "The set-up fee.\nSee clause 2.").ok).toBe(true);
    expect(threadsOf(session)[0]!.replies.map((reply) => reply.text)).toEqual(["The set-up fee.\nSee clause 2."]);
    expect(session.getState().commentCount).toBe(2);

    expect(session.undo()).toBe(true);
    expect(threadsOf(session)[0]!.replies).toEqual([]);
    expect(session.undo()).toBe(true);
    expect(threadsOf(session)).toEqual([]);
  });

  it("refuses empty text, empty selections, unknown threads and ranges the engine cannot anchor", async () => {
    const session = await plainSession(["One", "Two"]);
    const ids = session.requireDocument().getView().body.blocks.map((block) => block.id);
    const caret = { start: { blockId: ids[0]!, offset: 1 }, end: { blockId: ids[0]!, offset: 1 } };
    const word = { start: { blockId: ids[0]!, offset: 0 }, end: { blockId: ids[0]!, offset: 3 } };
    expect(addComment(session, word, "   ")).toEqual({ ok: false, reason: "empty" });
    expect(addComment(session, word, "x".repeat(MAX_COMMENT_LENGTH + 1))).toEqual({ ok: false, reason: "too_long" });
    expect(addComment(session, caret, "Hi")).toEqual({ ok: false, reason: "no_selection" });
    expect(addComment(session, null, "Hi")).toEqual({ ok: false, reason: "no_selection" });
    expect(replyToComment(session, "999", "Hi")).toEqual({ ok: false, reason: "not_found" });
    const backwards = { start: { blockId: ids[1]!, offset: 2 }, end: { blockId: ids[0]!, offset: 0 } };
    expect(addComment(session, backwards, "Hi").ok).toBe(false);
    expect(session.getState().commentCount).toBe(0);
    expect(session.getState().canUndo).toBe(false);
  });

  it("cleans comment text", () => {
    expect(checkCommentText("a\r\nb\tc\u0007")).toEqual({ ok: true, text: "a\nb c" });
    expect(checkCommentText("\n\n")).toEqual({ ok: false, reason: "empty" });
  });
});
