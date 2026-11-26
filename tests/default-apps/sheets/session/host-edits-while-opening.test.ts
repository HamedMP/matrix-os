import { describe, expect, it } from "vitest";
import { openXlsx } from "../../../../home/apps/_shared/office-engine/index";
import { SessionHost } from "../../../../home/apps/sheets/src/session";
import { harness, sampleXlsx, settle } from "./fakes";

/** Holds reads of one path until `release` is called. */
function holdReads(files: ReturnType<typeof harness>["files"], path: string) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = files.read.bind(files);
  files.read = async (asked: string) => {
    if (asked === path) await gate;
    return read(asked);
  };
  return () => release();
}

/** Lets reads of one path take their bytes, then holds the answer until `release` is called. */
function holdAnswers(files: ReturnType<typeof harness>["files"], path: string) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = files.read.bind(files);
  files.read = async (asked: string) => {
    const answer = await read(asked);
    if (asked === path) await gate;
    return answer;
  };
  return () => release();
}

async function valueAt(bytes: Uint8Array, row: number, col: number): Promise<unknown> {
  const workbook = await openXlsx(bytes);
  return workbook.getCell(workbook.listSheets()[0]!.id, { row, col }).value;
}

describe("session host: edits made while another file loads", () => {
  it("saves them before the old document is closed", async () => {
    const h = harness();
    h.files.put("A.xlsx", await sampleXlsx());
    h.files.put("B.xlsx", await sampleXlsx());
    const host = new SessionHost(h.deps);
    const a = await host.open("A.xlsx");
    if (a.status !== "opened") throw new Error("not opened");
    const sheet = a.session.getState().activeSheetId;
    const release = holdReads(h.files, "B.xlsx");

    const opening = host.open("B.xlsx");
    await settle();
    // A is still on screen while B loads; the owner keeps typing in it.
    expect(host.session).toBe(a.session);
    a.session.setCellInput(sheet, { row: 5, col: 5 }, "typed while loading");
    release();
    const b = await opening;
    await settle();

    expect(b.status).toBe("opened");
    expect(await valueAt(h.files.bytes("A.xlsx"), 5, 5)).toBe("typed while loading");
  });

  it("stays on the old document and reports unsaved when those edits cannot be saved", async () => {
    const h = harness();
    h.files.put("A.xlsx", await sampleXlsx());
    h.files.put("B.xlsx", await sampleXlsx());
    const host = new SessionHost(h.deps);
    const a = await host.open("A.xlsx");
    if (a.status !== "opened") throw new Error("not opened");
    const sheet = a.session.getState().activeSheetId;
    const release = holdReads(h.files, "B.xlsx");

    const opening = host.open("B.xlsx");
    await settle();
    a.session.setCellInput(sheet, { row: 5, col: 5 }, "typed while loading");
    h.files.failNext = "forbidden";
    release();
    expect(await opening).toEqual({ status: "unsaved" });
    expect(host.session).toBe(a.session);
    expect(a.session.getState().dirty).toBe(true);
    expect(host.getState().opening).toBeNull();
  });
});

describe("session host: opening the document already shown", () => {
  it("keeps the current session, with edits made while the file is read, and saves on without a conflict", async () => {
    const h = harness();
    h.files.put("A.xlsx", await sampleXlsx());
    const host = new SessionHost(h.deps);
    const a = await host.open("A.xlsx");
    if (a.status !== "opened") throw new Error("not opened");
    const sheet = a.session.getState().activeSheetId;
    const release = holdAnswers(h.files, "A.xlsx");

    const opening = host.open("A.xlsx");
    await settle();
    // The owner keeps typing while the file would be read again.
    a.session.setCellInput(sheet, { row: 5, col: 5 }, "typed while reading");
    release();
    expect(await opening).toEqual({ status: "opened", session: a.session });

    expect(host.session).toBe(a.session);
    expect(host.getState().opening).toBeNull();
    expect(a.session.cell(sheet, 5, 5).value).toBe("typed while reading");
    a.session.setCellInput(sheet, { row: 6, col: 5 }, "next edit");
    expect(await a.session.flush()).toMatchObject({ status: "saved" });
    expect(await valueAt(h.files.bytes("A.xlsx"), 5, 5)).toBe("typed while reading");
    expect(await valueAt(h.files.bytes("A.xlsx"), 6, 5)).toBe("next edit");
  });

  it("keeps the current session when the same file is asked for under another spelling of its path", async () => {
    const h = harness();
    h.files.put("A.xlsx", await sampleXlsx());
    const host = new SessionHost(h.deps);
    const a = await host.open("A.xlsx");
    if (a.status !== "opened") throw new Error("not opened");
    const sheet = a.session.getState().activeSheetId;
    const release = holdAnswers(h.files, "A.xlsx");
    // As the gateway answers: the file read under "./A.xlsx" reports its home-relative path.
    const held = h.files.read;
    h.files.read = async (asked: string) => held(asked === "./A.xlsx" ? "A.xlsx" : asked);

    const opening = host.open("./A.xlsx");
    await settle();
    // The owner keeps typing, and leaving the old copy saves it after the read.
    a.session.setCellInput(sheet, { row: 5, col: 5 }, "typed while reading");
    release();
    expect(await opening).toEqual({ status: "opened", session: a.session });

    expect(host.session).toBe(a.session);
    expect(a.session.cell(sheet, 5, 5).value).toBe("typed while reading");
    a.session.setCellInput(sheet, { row: 6, col: 5 }, "next edit");
    expect(await a.session.flush()).toMatchObject({ status: "saved" });
    expect(await valueAt(h.files.bytes("A.xlsx"), 6, 5)).toBe("next edit");
  });

  it("reads the file again when this window saved it while a discarding reopen read it", async () => {
    const h = harness();
    h.files.put("A.xlsx", await sampleXlsx());
    const host = new SessionHost(h.deps);
    const a = await host.open("A.xlsx");
    if (a.status !== "opened") throw new Error("not opened");
    const sheet = a.session.getState().activeSheetId;
    const release = holdAnswers(h.files, "A.xlsx");

    const opening = host.open("A.xlsx", { discardUnsaved: true });
    await settle();
    // An autosave lands while the old bytes are being read.
    a.session.setCellInput(sheet, { row: 5, col: 5 }, "saved while reading");
    expect(await a.session.flush()).toMatchObject({ status: "saved" });
    release();
    const b = await opening;
    if (b.status !== "opened") throw new Error("not opened");

    expect(b.session.cell(sheet, 5, 5).value).toBe("saved while reading");
    b.session.setCellInput(sheet, { row: 6, col: 5 }, "next edit");
    expect(await b.session.flush()).toMatchObject({ status: "saved" });
  });
});

describe("session host: text still in the cell editor", () => {
  /** A cell editor that holds `text` until the host asks it to commit. */
  function editor(host: SessionHost, session: import("../../../../home/apps/sheets/src/session").SheetSession) {
    const sheet = session.getState().activeSheetId;
    const held = { text: null as string | null, refuse: false, commits: 0 };
    const stop = host.holdEditor(session, () => {
      held.commits++;
      if (held.text === null) return true;
      if (held.refuse) return false;
      session.setCellInput(sheet, { row: 7, col: 2 }, held.text);
      held.text = null;
      return true;
    });
    return { held, stop };
  }

  it("commits text typed while another file loads and saves it before the old document closes", async () => {
    const h = harness();
    h.files.put("A.xlsx", await sampleXlsx());
    h.files.put("B.xlsx", await sampleXlsx());
    const host = new SessionHost(h.deps);
    const a = await host.open("A.xlsx");
    if (a.status !== "opened") throw new Error("not opened");
    const { held } = editor(host, a.session);
    const release = holdReads(h.files, "B.xlsx");

    const opening = host.open("B.xlsx");
    await settle();
    // Typed into the still-visible grid, not yet committed to the session.
    held.text = "still in the editor";
    release();
    const b = await opening;
    await settle();

    expect(b.status).toBe("opened");
    expect(await valueAt(h.files.bytes("A.xlsx"), 7, 2)).toBe("still in the editor");
  });

  it("stays on the document when the editor refuses its text, on every path that replaces it", async () => {
    const h = harness();
    h.files.put("A.xlsx", await sampleXlsx());
    h.files.put("B.xlsx", await sampleXlsx());
    const host = new SessionHost(h.deps);
    const a = await host.open("A.xlsx");
    if (a.status !== "opened") throw new Error("not opened");
    const { held } = editor(host, a.session);
    held.text = "=SUM(";
    held.refuse = true;

    expect(await host.open("B.xlsx")).toEqual({ status: "editing" });
    expect(await host.openNew()).toEqual({ status: "editing" });
    expect(await host.openLocal("C.xlsx", await sampleXlsx())).toEqual({ status: "editing" });
    expect(await host.close()).toEqual({ status: "editing" });
    expect(host.session).toBe(a.session);
    expect(host.getState().opening).toBeNull();

    // Discarding drops the editor's text with the other edits.
    expect(await host.close({ discardUnsaved: true })).toEqual({ status: "closed" });
    expect(host.session).toBeNull();
  });

  it("stops when the editor refuses text typed while the new file loads", async () => {
    const h = harness();
    h.files.put("A.xlsx", await sampleXlsx());
    h.files.put("B.xlsx", await sampleXlsx());
    const host = new SessionHost(h.deps);
    const a = await host.open("A.xlsx");
    if (a.status !== "opened") throw new Error("not opened");
    const { held } = editor(host, a.session);
    const release = holdReads(h.files, "B.xlsx");

    const opening = host.open("B.xlsx");
    await settle();
    held.text = "=SUM(";
    held.refuse = true;
    release();

    expect(await opening).toEqual({ status: "editing" });
    expect(host.session).toBe(a.session);
    expect(host.getState().opening).toBeNull();
  });

  it("asks only the editor of the document it is leaving", async () => {
    const h = harness();
    h.files.put("A.xlsx", await sampleXlsx());
    h.files.put("B.xlsx", await sampleXlsx());
    const host = new SessionHost(h.deps);
    const a = await host.open("A.xlsx");
    if (a.status !== "opened") throw new Error("not opened");
    const first = editor(host, a.session);
    first.stop();
    expect(await host.open("B.xlsx")).toMatchObject({ status: "opened" });
    expect(first.held.commits).toBe(0);
  });
});
