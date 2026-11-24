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
