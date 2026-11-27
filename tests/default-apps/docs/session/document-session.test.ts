import { describe, expect, it, vi } from "vitest";
import { createDocx, openDocx } from "../../../../home/apps/_shared/office-engine/index";
import type { DocumentChange } from "../../../../home/apps/docs/src/session/index";
import { OWNER, bodyText, docxBytes, firstId, harness, paragraphs } from "./helpers";

const PATH = "Documents/plan.docx";

describe("document session: opening", () => {
  it("opens a document from the files bridge and reports a clean ready state", async () => {
    const { session, files } = await harness();
    const states: string[] = [];
    session.subscribe(() => states.push(session.getState().status));
    const result = await session.open(PATH);
    expect(result).toEqual({ status: "opened", path: PATH });
    const state = session.getState();
    expect(state).toMatchObject({ status: "ready", path: PATH, name: "plan.docx", dirty: false, conflict: null, canUndo: false, canRedo: false });
    expect(state.version).toBe("v1");
    expect(states).toContain("loading");
    expect(bodyText(session.requireDocument())).toBe("Hello world\nSecond paragraph\n");
    expect(files.writes).toEqual([]);
  });

  it("reports a missing file without creating one", async () => {
    const { session, files } = await harness();
    const result = await session.open("Documents/missing.docx");
    expect(result).toMatchObject({ status: "error", error: { code: "not_found" } });
    expect(session.getState()).toMatchObject({ status: "error", error: { code: "not_found" } });
    expect(session.document).toBeNull();
    expect(files.writes).toEqual([]);
  });

  it("refuses a file that is not a document and never overwrites it", async () => {
    const { session, files } = await harness();
    files.put("Documents/broken.docx", new TextEncoder().encode("this is not a zip archive"));
    const result = await session.open("Documents/broken.docx");
    expect(result).toMatchObject({ status: "error", error: { code: "unsupported_file" } });
    expect(session.getState().error?.message).not.toMatch(/zip|central/i);
    expect(await session.save()).toMatchObject({ status: "skipped", reason: "no_document" });
    expect(files.writes).toEqual([]);
  });

  it("keeps the newest of two overlapping opens", async () => {
    const { session } = await harness({ "a.docx": ["Alpha"], "b.docx": ["Beta"] });
    const first = session.open("a.docx");
    const second = session.open("b.docx");
    expect(await first).toEqual({ status: "superseded" });
    expect(await second).toEqual({ status: "opened", path: "b.docx" });
    expect(bodyText(session.requireDocument())).toBe("Beta\n");
  });

  it("starts tracking from the setting stored in the file and stores a change of it", async () => {
    const { session } = await harness();
    await session.open(PATH);
    expect(session.getState().tracking).toBe(false);
    session.setTracking(true);
    expect(session.getState()).toMatchObject({ tracking: true, dirty: true });
    expect(session.requireDocument().getTrackRevisions()).toBe(true);
  });
});

describe("document session: editing", () => {
  it("applies operations directly when tracking is off and marks the document dirty", async () => {
    const { session } = await harness();
    await session.open(PATH);
    const changes: DocumentChange[] = [];
    session.onChange((change) => changes.push(change));
    const id = firstId(session);
    const result = session.apply([{ type: "insertText", at: { blockId: id, offset: 5 }, text: "," }]);
    expect(result.results[0]?.caret).toEqual({ blockId: id, offset: 6 });
    expect(bodyText(session.requireDocument())).toBe("Hello, world\nSecond paragraph\n");
    expect(session.requireDocument().listRevisions()).toEqual([]);
    expect(session.getState()).toMatchObject({ dirty: true, canUndo: true, canRedo: false, revisionCount: 0 });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: "edit", full: false, changedBlockIds: [id], createdBlockIds: [], removedBlockIds: [] });
  });

  it("records revisions by the session author when tracking is on, stamped to the minute", async () => {
    const { session } = await harness();
    await session.open(PATH);
    session.setTracking(true);
    const id = firstId(session);
    session.apply([{ type: "insertText", at: { blockId: id, offset: 5 }, text: "," }]);
    const revisions = session.requireDocument().listRevisions();
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ kind: "insert", author: OWNER, text: ",", date: "2026-11-23T10:15:00Z" });
    expect(bodyText(session.requireDocument(), "original")).toBe("Hello world\nSecond paragraph\n");
    expect(session.getState().revisionCount).toBe(1);
  });

  it("lets one call override the tracking mode and the author", async () => {
    const { session } = await harness();
    await session.open(PATH);
    const id = firstId(session);
    session.apply([{ type: "insertText", at: { blockId: id, offset: 0 }, text: "Draft: " }], { track: true, author: "Matrix Agent", origin: "agent" });
    expect(session.requireDocument().listRevisions()[0]).toMatchObject({ author: "Matrix Agent", kind: "insert" });
    expect(session.getState().tracking).toBe(false);
  });

  it("leaves the document and the history untouched when an operation is rejected", async () => {
    const { session } = await harness();
    await session.open(PATH);
    const changes: DocumentChange[] = [];
    session.onChange((change) => changes.push(change));
    expect(() => session.apply([{ type: "insertText", at: { blockId: "nope", offset: 0 }, text: "x" }])).toThrowError();
    expect(session.getState()).toMatchObject({ dirty: false, canUndo: false });
    expect(changes).toEqual([]);
  });

  it("undoes and redoes edits and follows the saved state for dirtiness", async () => {
    const { session } = await harness();
    await session.open(PATH);
    const id = firstId(session);
    session.apply([{ type: "insertText", at: { blockId: id, offset: 5 }, text: "," }]);
    session.apply([{ type: "splitParagraph", at: { blockId: id, offset: 6 } }]);
    expect(bodyText(session.requireDocument())).toBe("Hello,\n world\nSecond paragraph\n");
    const changes: DocumentChange[] = [];
    session.onChange((change) => changes.push(change));

    expect(session.undo()).toBe(true);
    expect(bodyText(session.requireDocument())).toBe("Hello, world\nSecond paragraph\n");
    expect(session.getState()).toMatchObject({ dirty: true, canUndo: true, canRedo: true });
    expect(session.undo()).toBe(true);
    expect(bodyText(session.requireDocument())).toBe("Hello world\nSecond paragraph\n");
    expect(session.getState()).toMatchObject({ dirty: false, canUndo: false, canRedo: true });
    expect(session.undo()).toBe(false);

    expect(session.redo()).toBe(true);
    expect(session.redo()).toBe(true);
    expect(session.redo()).toBe(false);
    expect(bodyText(session.requireDocument())).toBe("Hello,\n world\nSecond paragraph\n");
    expect(session.getState()).toMatchObject({ dirty: true, canRedo: false });
    expect(changes.map((change) => [change.kind, change.full])).toEqual([
      ["undo", true],
      ["undo", true],
      ["redo", true],
      ["redo", true],
    ]);
  });

  it("drops the redo history after a new edit and bounds the undo history", async () => {
    const { session } = await harness(undefined, { undoLimit: 3 });
    await session.open(PATH);
    const id = firstId(session);
    for (const letter of "abcde") session.apply([{ type: "insertText", at: { blockId: id, offset: 0 }, text: letter }]);
    let undone = 0;
    while (session.undo()) undone++;
    expect(undone).toBe(3);
    expect(bodyText(session.requireDocument())).toBe("baHello world\nSecond paragraph\n");
    session.redo();
    session.apply([{ type: "insertText", at: { blockId: id, offset: 0 }, text: "z" }]);
    expect(session.getState().canRedo).toBe(false);
  });

  it("merges calls with the same merge key into one undo step while they are close in time", async () => {
    const { session, clock } = await harness();
    await session.open(PATH);
    const id = firstId(session);
    const type = (offset: number, text: string) => session.apply([{ type: "insertText", at: { blockId: id, offset }, text }], { mergeKey: `type:${id}` });
    type(0, "a");
    type(1, "b");
    clock.now = new Date(clock.now.getTime() + 5_000);
    type(2, "c");
    expect(bodyText(session.requireDocument())).toMatch(/^abcHello/);
    session.undo();
    expect(bodyText(session.requireDocument())).toMatch(/^abHello/);
    session.undo();
    expect(bodyText(session.requireDocument())).toMatch(/^Hello/);
    expect(session.getState().canUndo).toBe(false);
  });

  it("groups a batch into one undo step and one change, and rolls it back when it throws", async () => {
    const { session } = await harness();
    await session.open(PATH);
    const id = firstId(session);
    const changes: DocumentChange[] = [];
    session.onChange((change) => changes.push(change));
    session.batch(() => {
      const split = session.apply([{ type: "splitParagraph", at: { blockId: id, offset: 5 } }]);
      session.apply([{ type: "insertText", at: { blockId: split.createdBlockIds[0]!, offset: 0 }, text: "new" }]);
    });
    expect(bodyText(session.requireDocument())).toBe("Hello\nnew world\nSecond paragraph\n");
    expect(changes).toHaveLength(1);
    expect(changes[0]?.createdBlockIds).toHaveLength(1);
    expect(changes[0]?.changedBlockIds).toEqual([id]);
    session.undo();
    expect(bodyText(session.requireDocument())).toBe("Hello world\nSecond paragraph\n");
    expect(session.getState().canUndo).toBe(false);

    expect(() =>
      session.batch(() => {
        session.apply([{ type: "insertText", at: { blockId: id, offset: 0 }, text: "kept? " }]);
        throw new Error("stop");
      }),
    ).toThrowError("stop");
    expect(bodyText(session.requireDocument())).toBe("Hello world\nSecond paragraph\n");
    expect(session.getState()).toMatchObject({ canUndo: false, dirty: false });
    expect(changes).toHaveLength(2);
  });

  it("accepts and rejects revisions as undoable steps", async () => {
    const { session } = await harness();
    await session.open(PATH);
    session.setTracking(true);
    const id = firstId(session);
    session.apply([{ type: "insertText", at: { blockId: id, offset: 5 }, text: "," }]);
    const changes: DocumentChange[] = [];
    session.onChange((change) => changes.push(change));
    const revisionId = session.requireDocument().listRevisions()[0]!.id;
    const resolved = session.rejectRevisions([revisionId]);
    expect(resolved.resolvedIds).toEqual([revisionId]);
    expect(bodyText(session.requireDocument())).toBe("Hello world\nSecond paragraph\n");
    expect(session.getState().revisionCount).toBe(0);
    expect(changes[0]).toMatchObject({ kind: "resolve", changedBlockIds: [id] });
    session.undo();
    expect(session.requireDocument().listRevisions()).toHaveLength(1);
    session.acceptRevisions("all");
    expect(session.requireDocument().listRevisions()).toEqual([]);
    expect(bodyText(session.requireDocument())).toBe("Hello, world\nSecond paragraph\n");
  });

  it("carries the selection of its selection source through an edit", async () => {
    const { session } = await harness();
    await session.open(PATH);
    const id = firstId(session);
    session.setSelectionSource(() => ({ anchor: { blockId: id, offset: 8 }, focus: { blockId: id, offset: 11 } }));
    const changes: DocumentChange[] = [];
    session.onChange((change) => changes.push(change));
    session.apply([{ type: "insertText", at: { blockId: id, offset: 0 }, text: "Oh, " }], { origin: "agent" });
    expect(changes[0]?.selection).toEqual({ anchor: { blockId: id, offset: 12 }, focus: { blockId: id, offset: 15 } });
    session.undo();
    expect(changes[1]?.selection).toEqual({ anchor: { blockId: id, offset: 8 }, focus: { blockId: id, offset: 11 } });
  });

  it("creates an untitled document that needs a path before it can be saved", async () => {
    const { session, files } = await harness();
    await session.createNew({ name: "Untitled" });
    expect(session.getState()).toMatchObject({ status: "ready", path: null, name: "Untitled", dirty: false });
    session.apply([{ type: "insertText", at: { blockId: firstId(session), offset: 0 }, text: "Notes" }]);
    expect(await session.save()).toMatchObject({ status: "skipped", reason: "no_path" });
    expect(await session.saveAs("Documents/notes.docx")).toMatchObject({ status: "saved", path: "Documents/notes.docx" });
    expect(session.getState()).toMatchObject({ path: "Documents/notes.docx", name: "notes.docx", dirty: false });
    const saved = await openDocx(files.bytes("Documents/notes.docx")!);
    expect(bodyText(saved)).toBe("Notes\n");
  });
});

describe("document session: saving", () => {
  it("writes with the version it read and keeps the new version for the next write", async () => {
    const { session, files } = await harness();
    await session.open(PATH);
    const id = firstId(session);
    session.apply([{ type: "insertText", at: { blockId: id, offset: 11 }, text: "!" }]);
    expect(await session.save()).toMatchObject({ status: "saved", path: PATH, version: "v2" });
    expect(session.getState()).toMatchObject({ dirty: false, saveStatus: "saved", version: "v2" });
    session.apply([{ type: "insertText", at: { blockId: id, offset: 12 }, text: "!" }]);
    await session.save();
    expect(files.writes.map((write) => write.ifVersion)).toEqual(["v1", "v2"]);
    const saved = await openDocx(files.bytes(PATH)!);
    expect(paragraphs(saved)[0]?.text).toBe("Hello world!!");
  });

  it("does not write a clean document", async () => {
    const { session, files } = await harness();
    await session.open(PATH);
    expect(await session.save()).toMatchObject({ status: "skipped", reason: "clean" });
    expect(files.writes).toEqual([]);
  });

  it("stays dirty when the document is edited while a save is in flight", async () => {
    const { session, files } = await harness();
    await session.open(PATH);
    const id = firstId(session);
    session.apply([{ type: "insertText", at: { blockId: id, offset: 0 }, text: "1" }]);
    const release = files.holdWrites();
    const saving = session.save();
    await vi.waitFor(() => expect(files.writes).toHaveLength(1));
    session.apply([{ type: "insertText", at: { blockId: id, offset: 0 }, text: "2" }]);
    release();
    expect(await saving).toMatchObject({ status: "saved" });
    expect(session.getState()).toMatchObject({ dirty: true, version: "v2" });
    await session.save();
    expect(session.getState().dirty).toBe(false);
    expect(paragraphs(await openDocx(files.bytes(PATH)!))[0]?.text).toBe("21Hello world");
  });

  it("reports a failed write as an error and keeps the document dirty", async () => {
    const { session, files } = await harness();
    await session.open(PATH);
    session.apply([{ type: "insertText", at: { blockId: firstId(session), offset: 0 }, text: "x" }]);
    files.failNext("write", "unavailable");
    expect(await session.save()).toMatchObject({ status: "error", error: { code: "unavailable" } });
    expect(session.getState()).toMatchObject({ dirty: true, saveStatus: "error", conflict: null });
    expect(await session.save()).toMatchObject({ status: "saved" });
  });

  it("keeps the local document and exposes a conflict when the file changed underneath", async () => {
    const { session, files } = await harness();
    await session.open(PATH);
    session.apply([{ type: "insertText", at: { blockId: firstId(session), offset: 0 }, text: "Mine: " }]);
    const theirs = await docxBytes(["Their version"]);
    files.put(PATH, theirs);

    expect(await session.save()).toEqual({ status: "conflict", path: PATH });
    const state = session.getState();
    expect(state).toMatchObject({ dirty: true, saveStatus: "conflict", conflict: { path: PATH } });
    expect(bodyText(session.requireDocument())).toBe("Mine: Hello world\nSecond paragraph\n");
    expect(files.bytes(PATH)).toEqual(theirs);
    // A plain save does not retry over the other writer's file.
    expect(await session.save()).toEqual({ status: "conflict", path: PATH });
    expect(files.writes).toHaveLength(1);
  });

  it("resolves a conflict by reloading the file", async () => {
    const { session, files } = await harness();
    await session.open(PATH);
    session.apply([{ type: "insertText", at: { blockId: firstId(session), offset: 0 }, text: "Mine: " }]);
    files.put(PATH, await docxBytes(["Their version"]));
    await session.save();
    expect(await session.reload()).toEqual({ status: "opened", path: PATH });
    expect(bodyText(session.requireDocument())).toBe("Their version\n");
    expect(session.getState()).toMatchObject({ dirty: false, conflict: null, saveStatus: "idle", version: "v2", canUndo: false });
  });

  it("resolves a conflict by saving a copy and continuing in the copy", async () => {
    const { session, files } = await harness();
    await session.open(PATH);
    session.apply([{ type: "insertText", at: { blockId: firstId(session), offset: 0 }, text: "Mine: " }]);
    const theirs = await docxBytes(["Their version"]);
    files.put(PATH, theirs);
    files.put("Documents/plan (copy).docx", await docxBytes(["An older copy"]));
    await session.save();

    const result = await session.saveCopy();
    expect(result).toMatchObject({ status: "saved", path: "Documents/plan (copy 2).docx" });
    expect(session.getState()).toMatchObject({ path: "Documents/plan (copy 2).docx", name: "plan (copy 2).docx", dirty: false, conflict: null });
    expect(files.bytes(PATH)).toEqual(theirs);
    expect(bodyText(await openDocx(files.bytes("Documents/plan (copy 2).docx")!))).toBe("Mine: Hello world\nSecond paragraph\n");
    expect(files.writes.at(-1)).toMatchObject({ ifVersion: null });
  });

  it("refuses to save over an existing file unless asked to", async () => {
    const { session, files } = await harness({ "a.docx": ["Alpha"], "b.docx": ["Beta"] });
    await session.open("a.docx");
    expect(await session.saveAs("b.docx")).toMatchObject({ status: "error", error: { code: "already_exists" } });
    expect(session.getState().path).toBe("a.docx");
    expect(await session.saveAs("b.docx", { overwrite: true })).toMatchObject({ status: "saved", path: "b.docx" });
    expect(bodyText(await openDocx(files.bytes("b.docx")!))).toBe("Alpha\n");
    expect(session.getState().path).toBe("b.docx");
  });

  it("saves pending changes before opening another document and stays put when that fails", async () => {
    const { session, files } = await harness({ "a.docx": ["Alpha"], "b.docx": ["Beta"] });
    await session.open("a.docx");
    session.apply([{ type: "insertText", at: { blockId: firstId(session), offset: 0 }, text: "My " }]);
    files.put("a.docx", await docxBytes(["Changed elsewhere"]));
    expect(await session.open("b.docx")).toEqual({ status: "blocked", reason: "conflict" });
    expect(session.getState()).toMatchObject({ path: "a.docx", dirty: true });
    expect(bodyText(session.requireDocument())).toBe("My Alpha\n");

    expect(await session.open("b.docx", { discardChanges: true })).toEqual({ status: "opened", path: "b.docx" });
    expect(bodyText(session.requireDocument())).toBe("Beta\n");
    expect(session.getState()).toMatchObject({ dirty: false, conflict: null, canUndo: false });
  });

  it("writes pending changes on the way to another document", async () => {
    const { session, files } = await harness({ "a.docx": ["Alpha"], "b.docx": ["Beta"] });
    await session.open("a.docx");
    session.apply([{ type: "insertText", at: { blockId: firstId(session), offset: 0 }, text: "My " }]);
    expect(await session.open("b.docx")).toEqual({ status: "opened", path: "b.docx" });
    expect(bodyText(await openDocx(files.bytes("a.docx")!))).toBe("My Alpha\n");
  });
});

describe("document session: a request that waited for the save before it", () => {
  /** Opens a.docx, edits it, holds its write, and returns the release function. */
  async function editedWithHeldSave() {
    const h = await harness({ "a.docx": ["Alpha"], "b.docx": ["Beta"], "c.docx": ["Gamma"] });
    await h.session.open("a.docx");
    h.session.apply([{ type: "insertText", at: { blockId: firstId(h.session), offset: 0 }, text: "My " }]);
    return { ...h, release: h.files.holdWrites() };
  }

  it("does not open its document after the owner discarded the one it was saving", async () => {
    const { session, release } = await editedWithHeldSave();
    const opening = session.open("b.docx");
    // Home: the owner leaves without saving while the save for the open is still being written.
    expect(await session.close({ discardChanges: true })).toEqual({ status: "opened", path: null });
    release();
    expect(await opening).toEqual({ status: "superseded" });
    expect(session.document).toBeNull();
    expect(session.getState()).toMatchObject({ status: "empty", path: null });
  });

  it("does not replace a newer document opened while it waited", async () => {
    const { session, release } = await editedWithHeldSave();
    const opening = session.open("b.docx");
    expect(await session.open("c.docx", { discardChanges: true })).toEqual({ status: "opened", path: "c.docx" });
    release();
    expect(await opening).toEqual({ status: "superseded" });
    expect(session.getState().path).toBe("c.docx");
    expect(bodyText(session.requireDocument())).toBe("Gamma\n");
  });

  it("does not replace a new document started while it waited", async () => {
    const { session, release } = await editedWithHeldSave();
    const opening = session.open("b.docx");
    await session.createNew({ name: "Fresh", discardChanges: true });
    release();
    expect(await opening).toEqual({ status: "superseded" });
    expect(session.getState()).toMatchObject({ name: "Fresh", path: null });
  });

  it("does not close or replace a document that took the place of the one it was saving", async () => {
    const { session, release } = await editedWithHeldSave();
    const closing = session.close();
    const opening = session.open("b.docx");
    expect(await session.open("c.docx", { discardChanges: true })).toEqual({ status: "opened", path: "c.docx" });
    release();
    expect(await closing).toEqual({ status: "superseded" });
    expect(await opening).toEqual({ status: "superseded" });
    expect(session.getState().path).toBe("c.docx");
  });

  it("lets the newest of two requests that both waited for the save win", async () => {
    const { session, files, release } = await editedWithHeldSave();
    const toB = session.open("b.docx");
    const toC = session.open("c.docx");
    release();
    expect(await toB).toEqual({ status: "superseded" });
    expect(await toC).toEqual({ status: "opened", path: "c.docx" });
    expect(bodyText(await openDocx(files.bytes("a.docx")!))).toBe("My Alpha\n");
  });

  it("does not adopt over a document opened while it waited", async () => {
    const { session, release } = await editedWithHeldSave();
    const adopting = session.adopt(createDocx({ paragraphs: ["Compared"] }), { name: "Comparison" });
    expect(await session.open("c.docx", { discardChanges: true })).toEqual({ status: "opened", path: "c.docx" });
    release();
    expect(await adopting).toEqual({ status: "superseded" });
    expect(session.getState().path).toBe("c.docx");
  });
});
