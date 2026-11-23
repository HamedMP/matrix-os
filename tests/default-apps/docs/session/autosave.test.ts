import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDocx } from "../../../../home/apps/_shared/office-engine/index";
import { bodyText, docxBytes, firstId, harness } from "./helpers";

const DELAY = 1_500;
const options = { autosave: true, autosaveDelayMs: DELAY };

const realSetTimeout = globalThis.setTimeout;

/** Advances the fake clock, then waits for every save it started (serialising is real asynchronous work). */
async function settle(ms: number, session: { whenIdle(): Promise<void> }): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await session.whenIdle();
}

/** Waits in real time for work the fake clock does not drive (serialising the document). */
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !condition(); attempt++) await new Promise<void>((resolve) => realSetTimeout(resolve, 5));
  expect(condition()).toBe(true);
}

describe("document session: autosave", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("saves once after edits stop for the delay", async () => {
    const { session, files } = await harness({ "a.docx": ["Alpha"] }, options);
    await session.open("a.docx");
    const id = firstId(session);
    session.apply([{ type: "insertText", at: { blockId: id, offset: 0 }, text: "1" }]);
    await settle(DELAY - 100, session);
    session.apply([{ type: "insertText", at: { blockId: id, offset: 0 }, text: "2" }]);
    await settle(DELAY - 100, session);
    expect(files.writes).toEqual([]);
    await settle(200, session);
    expect(files.writes).toHaveLength(1);
    expect(session.getState()).toMatchObject({ dirty: false, saveStatus: "saved" });
    expect(bodyText(await openDocx(files.bytes("a.docx")!))).toBe("21Alpha\n");
    await settle(DELAY * 4, session);
    expect(files.writes).toHaveLength(1);
  });

  it("does nothing when autosave is off, and starts when it is turned on", async () => {
    const { session, files } = await harness({ "a.docx": ["Alpha"] }, { autosave: false, autosaveDelayMs: DELAY });
    await session.open("a.docx");
    session.apply([{ type: "insertText", at: { blockId: firstId(session), offset: 0 }, text: "1" }]);
    await settle(DELAY * 3, session);
    expect(files.writes).toEqual([]);
    session.setAutosave(true);
    await settle(DELAY + 10, session);
    expect(files.writes).toHaveLength(1);
  });

  it("never fires for a document that was replaced by another one", async () => {
    const { session, files } = await harness({ "a.docx": ["Alpha"], "b.docx": ["Beta"] }, options);
    await session.open("a.docx");
    session.apply([{ type: "insertText", at: { blockId: firstId(session), offset: 0 }, text: "lost " }]);
    expect(await session.open("b.docx", { discardChanges: true })).toEqual({ status: "opened", path: "b.docx" });
    await settle(DELAY * 4, session);
    expect(files.writes).toEqual([]);
    expect(bodyText(await openDocx(files.bytes("a.docx")!))).toBe("Alpha\n");
    expect(session.getState()).toMatchObject({ path: "b.docx", dirty: false });
  });

  it("never fires after the session is closed or disposed", async () => {
    const first = await harness({ "a.docx": ["Alpha"] }, options);
    await first.session.open("a.docx");
    first.session.apply([{ type: "insertText", at: { blockId: firstId(first.session), offset: 0 }, text: "x" }]);
    first.session.dispose();
    await settle(DELAY * 4, first.session);
    expect(first.files.writes).toEqual([]);

    const second = await harness({ "a.docx": ["Alpha"] }, options);
    await second.session.open("a.docx");
    second.session.apply([{ type: "insertText", at: { blockId: firstId(second.session), offset: 0 }, text: "x" }]);
    await second.session.close({ discardChanges: true });
    await settle(DELAY * 4, second.session);
    expect(second.files.writes).toEqual([]);
    expect(second.session.getState()).toMatchObject({ status: "empty", path: null });
  });

  it("does not let a save that settles late touch the document that replaced it", async () => {
    const { session, files } = await harness({ "a.docx": ["Alpha"], "b.docx": ["Beta"] }, options);
    await session.open("a.docx");
    session.apply([{ type: "insertText", at: { blockId: firstId(session), offset: 0 }, text: "1" }]);
    const release = files.holdWrites();
    await vi.advanceTimersByTimeAsync(DELAY + 10);
    await until(() => files.writes.length === 1);
    const opened = session.open("b.docx", { discardChanges: true });
    await until(() => files.reads.filter((path) => path === "b.docx").length === 1);
    release();
    expect(await opened).toEqual({ status: "opened", path: "b.docx" });
    await settle(DELAY * 2, session);
    expect(session.getState()).toMatchObject({ path: "b.docx", version: "v2", dirty: false, saveStatus: "idle" });
    expect(bodyText(session.requireDocument())).toBe("Beta\n");
  });

  it("stops retrying while a conflict is open and resumes after it is resolved", async () => {
    const { session, files } = await harness({ "a.docx": ["Alpha"] }, options);
    await session.open("a.docx");
    const id = firstId(session);
    session.apply([{ type: "insertText", at: { blockId: id, offset: 0 }, text: "1" }]);
    files.put("a.docx", await docxBytes(["Changed elsewhere"]));
    await settle(DELAY + 10, session);
    expect(session.getState().conflict).toEqual({ path: "a.docx", detectedAt: expect.any(String) });
    session.apply([{ type: "insertText", at: { blockId: id, offset: 0 }, text: "2" }]);
    await settle(DELAY * 4, session);
    expect(files.writes).toHaveLength(1);

    expect(await session.saveCopy("a-mine.docx")).toMatchObject({ status: "saved", path: "a-mine.docx" });
    session.apply([{ type: "insertText", at: { blockId: id, offset: 0 }, text: "3" }]);
    await settle(DELAY + 10, session);
    expect(files.writes.at(-1)).toMatchObject({ path: "a-mine.docx" });
    expect(bodyText(await openDocx(files.bytes("a-mine.docx")!))).toBe("321Alpha\n");
    expect(bodyText(await openDocx(files.bytes("a.docx")!))).toBe("Changed elsewhere\n");
  });

  it("flushes a pending autosave on request", async () => {
    const { session, files } = await harness({ "a.docx": ["Alpha"] }, options);
    await session.open("a.docx");
    session.apply([{ type: "insertText", at: { blockId: firstId(session), offset: 0 }, text: "1" }]);
    expect(await session.flush()).toMatchObject({ status: "saved" });
    await settle(DELAY * 3, session);
    expect(files.writes).toHaveLength(1);
  });
});
