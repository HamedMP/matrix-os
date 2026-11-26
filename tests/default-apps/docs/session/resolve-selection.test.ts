/**
 * Accepting or rejecting revisions removes text, so the owner's selection is
 * carried through it like through any other edit, or reported lost when its
 * place is gone. Custom mutations cannot say where text went: they report
 * the selection lost instead of leaving its old offsets in place.
 */
import { describe, expect, it } from "vitest";
import type { DocumentChange, SessionSelection } from "../../../../home/apps/docs/src/session/index";
import { firstId, harness, paragraphs } from "./helpers";

const PATH = "Documents/plan.docx";

function range(blockId: string, from: number, to: number): SessionSelection {
  return { anchor: { blockId, offset: from }, focus: { blockId, offset: to } };
}

async function tracked() {
  const h = await harness();
  await h.session.open(PATH);
  h.session.setTracking(true);
  const id = firstId(h.session);
  const changes: DocumentChange[] = [];
  h.session.onChange((change) => changes.push(change));
  return { ...h, id, changes };
}

describe("document session: the selection through accepting and rejecting revisions", () => {
  it("moves a selection after rejected inserted text back by the removed length", async () => {
    const { session, id, changes } = await tracked();
    session.apply([{ type: "insertText", at: { blockId: id, offset: 0 }, text: "Dear " }]);
    // "world" in "Dear Hello world".
    session.setSelectionSource(() => range(id, 11, 16));
    session.rejectRevisions("all", { origin: "review" });
    expect(changes.at(-1)).toMatchObject({ kind: "resolve", selection: range(id, 6, 11), selectionLost: false });
    // Undo goes back to the selection before the step, redo to the carried one.
    session.undo();
    expect(changes.at(-1)?.selection).toEqual(range(id, 11, 16));
    session.redo();
    expect(changes.at(-1)?.selection).toEqual(range(id, 6, 11));
  });

  it("keeps the offsets when accepted inserted text stays", async () => {
    const { session, id, changes } = await tracked();
    session.apply([{ type: "insertText", at: { blockId: id, offset: 0 }, text: "Dear " }]);
    session.setSelectionSource(() => range(id, 11, 16));
    session.acceptRevisions("all");
    expect(changes.at(-1)).toMatchObject({ selection: range(id, 11, 16), selectionLost: false });
  });

  it("moves a selection after an accepted deletion, and puts an end inside removed text where that text was", async () => {
    const { session, id, changes } = await tracked();
    // "Hello " becomes a pending deletion; the markup text is still "Hello world".
    session.apply([{ type: "deleteRange", range: { start: { blockId: id, offset: 0 }, end: { blockId: id, offset: 6 } } }]);
    session.setSelectionSource(() => range(id, 3, 11));
    session.acceptRevisions("all");
    expect(changes.at(-1)).toMatchObject({ selection: range(id, 0, 5), selectionLost: false });
    expect(paragraphs(session.requireDocument())[0]!.text).toBe("world");
  });

  it("only counts the revisions it resolved", async () => {
    const { session, id, changes } = await tracked();
    session.apply([{ type: "insertText", at: { blockId: id, offset: 0 }, text: "Dear " }]);
    session.apply([{ type: "insertText", at: { blockId: id, offset: 10 }, text: "," }]);
    const [first] = session.requireDocument().listRevisions();
    // "world" in "Dear Hello, world".
    session.setSelectionSource(() => range(id, 12, 17));
    session.rejectRevisions([first!.id]);
    expect(paragraphs(session.requireDocument())[0]!.text).toBe("Hello, world");
    expect(changes.at(-1)).toMatchObject({ selection: range(id, 7, 12), selectionLost: false });
  });

  it("reports the selection lost when its paragraph is gone", async () => {
    const { session, id, changes } = await tracked();
    session.apply([{ type: "splitParagraph", at: { blockId: id, offset: 6 } }]);
    const second = paragraphs(session.requireDocument())[1]!.id;
    expect(second).not.toBe(id);
    session.setSelectionSource(() => range(second, 0, 5));
    session.rejectRevisions("all");
    expect(paragraphs(session.requireDocument()).map((block) => block.id)).not.toContain(second);
    expect(changes.at(-1)).toMatchObject({ kind: "resolve", selection: null, selectionLost: true });
  });

  it("reports the selection lost through a custom mutation, also inside a batch", async () => {
    const { session, id, changes } = await tracked();
    session.setSelectionSource(() => range(id, 6, 11));
    session.mutate((doc) => doc.setTrackRevisions(true));
    expect(changes.at(-1)).toMatchObject({ selection: null, selectionLost: true });
    session.batch(() => {
      session.apply([{ type: "insertText", at: { blockId: id, offset: 0 }, text: "Oh " }]);
      session.mutate((doc) => doc.setTrackRevisions(true));
    });
    expect(changes.at(-1)).toMatchObject({ selection: null, selectionLost: true });
  });

  it("does not report a selection lost when there was none", async () => {
    const { session, id, changes } = await tracked();
    session.apply([{ type: "insertText", at: { blockId: id, offset: 0 }, text: "Dear " }]);
    session.rejectRevisions("all");
    expect(changes.at(-1)).toMatchObject({ selection: null, selectionLost: false });
    session.apply([{ type: "insertText", at: { blockId: id, offset: 0 }, text: "Dear " }]);
    expect(changes.at(-1)).toMatchObject({ selectionLost: false });
  });
});
