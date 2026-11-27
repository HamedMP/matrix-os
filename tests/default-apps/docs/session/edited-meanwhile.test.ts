/**
 * Reload and open-after-Discard drop only the edits the owner chose to drop:
 * an edit made while the new file is still being read is kept, the document
 * is not replaced, and the owner is told why.
 */
import { describe, expect, it } from "vitest";
import { bodyText, docxBytes, firstId, harness } from "./helpers";

const PATH = "Documents/plan.docx";

describe("document session: edits made while a replacement is read", () => {
  it("does not reload over an edit made after the owner chose Reload", async () => {
    const { session, files } = await harness();
    await session.open(PATH);
    session.apply([{ type: "insertText", at: { blockId: firstId(session), offset: 0 }, text: "Mine: " }]);
    files.put(PATH, await docxBytes(["Their version"]));
    await session.save();
    expect(session.getState().conflict).not.toBeNull();

    const release = files.holdReads();
    const reloading = session.reload();
    // The editor stays editable while the file is read: the owner keeps typing.
    session.apply([{ type: "insertText", at: { blockId: firstId(session), offset: 0 }, text: "More " }]);
    release();

    const result = await reloading;
    expect(result).toMatchObject({ status: "error", error: { code: "edited_meanwhile" } });
    // A fixed sentence for the owner: the edits are kept.
    expect(result.status === "error" ? result.error.message : "").toMatch(/still here/);
    expect(bodyText(session.requireDocument())).toBe("More Mine: Hello world\nSecond paragraph\n");
    expect(session.getState()).toMatchObject({ status: "ready", dirty: true, canUndo: true, conflict: { path: PATH } });
    expect(session.getState().error).toBeNull();
  });

  it("does not reload over a change of Track changes made while the file is read", async () => {
    const { session, files } = await harness();
    await session.open(PATH);
    session.apply([{ type: "insertText", at: { blockId: firstId(session), offset: 0 }, text: "Mine: " }]);
    const release = files.holdReads();
    const reloading = session.reload();
    session.setTracking(true);
    release();
    expect(await reloading).toMatchObject({ status: "error", error: { code: "edited_meanwhile" } });
    expect(session.getState().tracking).toBe(true);
  });

  it("reloads when nothing changed while the file was read", async () => {
    const { session, files } = await harness();
    await session.open(PATH);
    session.apply([{ type: "insertText", at: { blockId: firstId(session), offset: 0 }, text: "Mine: " }]);
    files.put(PATH, await docxBytes(["Their version"]));
    const release = files.holdReads();
    const reloading = session.reload();
    release();
    expect(await reloading).toEqual({ status: "opened", path: PATH });
    expect(bodyText(session.requireDocument())).toBe("Their version\n");
  });

  it("does not open another file over an edit made after the owner chose Discard", async () => {
    const { session, files } = await harness({ "a.docx": ["Alpha"], "b.docx": ["Beta"] });
    await session.open("a.docx");
    session.apply([{ type: "insertText", at: { blockId: firstId(session), offset: 0 }, text: "My " }]);

    const release = files.holdReads();
    const opening = session.open("b.docx", { discardChanges: true });
    session.apply([{ type: "insertText", at: { blockId: firstId(session), offset: 0 }, text: "Still " }]);
    release();

    expect(await opening).toMatchObject({ status: "error", error: { code: "edited_meanwhile" } });
    expect(session.getState()).toMatchObject({ status: "ready", path: "a.docx", dirty: true });
    expect(bodyText(session.requireDocument())).toBe("Still My Alpha\n");
    expect(files.writes).toEqual([]);
  });

  it("does not open a file from the computer over an edit made after the owner chose Discard", async () => {
    const { session } = await harness({ "a.docx": ["Alpha"] });
    await session.open("a.docx");
    session.apply([{ type: "insertText", at: { blockId: firstId(session), offset: 0 }, text: "My " }]);
    const opening = session.openLocal({ name: "other.docx", bytes: await docxBytes(["Other"]) }, { discardChanges: true });
    // Parsing the file takes a turn of the event loop; the owner types meanwhile.
    session.apply([{ type: "insertText", at: { blockId: firstId(session), offset: 0 }, text: "Still " }]);
    expect(await opening).toMatchObject({ status: "error", error: { code: "edited_meanwhile" } });
    expect(session.getState()).toMatchObject({ path: "a.docx", source: "matrix" });
    expect(bodyText(session.requireDocument())).toBe("Still My Alpha\n");
  });

  it("still drops the edits the owner discarded", async () => {
    const { session, files } = await harness({ "a.docx": ["Alpha"], "b.docx": ["Beta"] });
    await session.open("a.docx");
    session.apply([{ type: "insertText", at: { blockId: firstId(session), offset: 0 }, text: "My " }]);
    const release = files.holdReads();
    const opening = session.open("b.docx", { discardChanges: true });
    release();
    expect(await opening).toEqual({ status: "opened", path: "b.docx" });
    expect(bodyText(session.requireDocument())).toBe("Beta\n");
  });
});
