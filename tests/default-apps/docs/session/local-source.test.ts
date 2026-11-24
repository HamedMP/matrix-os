/**
 * Documents opened from the owner's computer: a "local" source with no Matrix
 * path. Save downloads the file under the same name, nothing autosaves, the
 * recent list stays untouched until the document is saved to Matrix, and
 * saving it to Matrix turns it into a normal Matrix document.
 */

import { describe, expect, it, vi } from "vitest";
import { openDocx } from "../../../../home/apps/_shared/office-engine/index";
import { RECENT_FILES_TABLE, RecentFilesStore } from "../../../../home/apps/docs/src/session/index";
import { createFakeDb } from "./fakes";
import { bodyText, docxBytes, firstId, harness } from "./helpers";

function downloads() {
  const calls: Array<{ name: string; bytes: Uint8Array }> = [];
  return { calls, download: (name: string, bytes: Uint8Array) => calls.push({ name, bytes }) };
}

async function localHarness(options: { autosave?: boolean } = {}) {
  const db = createFakeDb();
  const recents = new RecentFilesStore({ db, log: () => undefined });
  const saved = downloads();
  const setup = await harness({ "Documents/plan.docx": ["Matrix plan"] }, { recents, download: saved.download, autosave: options.autosave ?? false, autosaveDelayMs: 0 });
  return { ...setup, db, saved };
}

function type(session: Awaited<ReturnType<typeof harness>>["session"], text: string): void {
  session.apply([{ type: "insertText", at: { blockId: firstId(session), offset: 0 }, text }]);
}

describe("document session: local documents", () => {
  it("opens bytes from the computer as a local document without a path or a recent entry", async () => {
    const { session, files, db } = await localHarness();
    const result = await session.openLocal({ name: "Report.docx", bytes: await docxBytes(["From disk"]) });
    expect(result).toEqual({ status: "opened", path: null });
    expect(session.getState()).toMatchObject({ status: "ready", source: "local", path: null, name: "Report.docx", dirty: false });
    expect(bodyText(session.requireDocument())).toBe("From disk\n");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(db.rows(RECENT_FILES_TABLE)).toEqual([]);
    expect(files.writes).toEqual([]);
  });

  it("never autosaves a local document, even with autosave on", async () => {
    const { session, files, saved } = await localHarness({ autosave: true });
    await session.openLocal({ name: "Report.docx", bytes: await docxBytes(["From disk"]) });
    type(session, "Edited ");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await session.whenIdle();
    expect(session.getState().dirty).toBe(true);
    expect(files.writes).toEqual([]);
    expect(saved.calls).toEqual([]);
    // Leaving the window flushes Matrix documents only: a local one is never downloaded behind the owner's back.
    expect(await session.flush()).toMatchObject({ status: "skipped", reason: "no_path" });
    expect(saved.calls).toEqual([]);
  });

  it("downloads the updated file under the same name on Save and is clean afterwards", async () => {
    const { session, files, saved } = await localHarness();
    await session.openLocal({ name: "Report.docx", bytes: await docxBytes(["From disk"]) });
    type(session, "Edited ");
    const result = await session.save();
    expect(result).toEqual({ status: "downloaded", name: "Report.docx" });
    expect(saved.calls).toHaveLength(1);
    expect(saved.calls[0]!.name).toBe("Report.docx");
    expect(bodyText(await openDocx(saved.calls[0]!.bytes))).toBe("Edited From disk\n");
    expect(session.getState()).toMatchObject({ source: "local", path: null, dirty: false, saveStatus: "saved" });
    expect(files.writes).toEqual([]);
  });

  it("reports a failed download as a save error and stays unsaved", async () => {
    const log = vi.fn();
    const { session } = await harness({}, {
      download: () => {
        throw new Error("blocked");
      },
      log,
    });
    await session.openLocal({ name: "Report.docx", bytes: await docxBytes(["From disk"]) });
    type(session, "Edited ");
    const result = await session.save();
    expect(result).toMatchObject({ status: "error", error: { code: "unknown" } });
    expect(session.getState()).toMatchObject({ dirty: true, saveStatus: "error" });
    expect(log).toHaveBeenCalled();
  });

  it("becomes a Matrix document after Save a copy to Matrix, with a recent entry and autosave", async () => {
    const { session, files, db } = await localHarness({ autosave: true });
    await session.openLocal({ name: "Report.docx", bytes: await docxBytes(["From disk"]) });
    type(session, "Edited ");
    const result = await session.saveAs("Documents/Report.docx");
    expect(result).toMatchObject({ status: "saved", path: "Documents/Report.docx" });
    expect(session.getState()).toMatchObject({ source: "matrix", path: "Documents/Report.docx", name: "Report.docx", dirty: false });
    await vi.waitFor(() => expect(db.rows(RECENT_FILES_TABLE).map((row) => row.path)).toEqual(["Documents/Report.docx"]));
    type(session, "Again ");
    await vi.waitFor(() => expect(files.writes.map((write) => write.path)).toEqual(["Documents/Report.docx", "Documents/Report.docx"]));
  });

  it("downloads a copy of a Matrix document without saving or writing it", async () => {
    const { session, files, saved } = await localHarness();
    await session.open("Documents/plan.docx");
    type(session, "Draft ");
    const result = await session.downloadCopy();
    expect(result).toEqual({ status: "downloaded", name: "plan.docx" });
    expect(bodyText(await openDocx(saved.calls[0]!.bytes))).toBe("Draft Matrix plan\n");
    expect(session.getState()).toMatchObject({ source: "matrix", dirty: true, saveStatus: "idle" });
    expect(files.writes).toEqual([]);
  });

  it("names the download .docx when the working name has no extension", async () => {
    const { session, saved } = await localHarness();
    await session.createNew({ name: "Untitled" });
    await session.downloadCopy();
    expect(saved.calls[0]!.name).toBe("Untitled.docx");
  });

  it("keeps the open document when the local file is not a document", async () => {
    const { session } = await localHarness();
    await session.open("Documents/plan.docx");
    const result = await session.openLocal({ name: "notes.docx", bytes: new TextEncoder().encode("not a zip") });
    expect(result).toMatchObject({ status: "error", error: { code: "unsupported_file" } });
    expect(session.getState()).toMatchObject({ status: "ready", source: "matrix", path: "Documents/plan.docx" });
  });

  it("asks before replacing a local document with unsaved changes", async () => {
    const { session } = await localHarness();
    await session.openLocal({ name: "Report.docx", bytes: await docxBytes(["From disk"]) });
    type(session, "Edited ");
    expect(await session.open("Documents/plan.docx")).toEqual({ status: "blocked", reason: "unsaved_changes" });
    expect(await session.close()).toEqual({ status: "blocked", reason: "unsaved_changes" });
    expect(await session.close({ discardChanges: true })).toEqual({ status: "opened", path: null });
    expect(session.getState()).toMatchObject({ status: "empty", source: "matrix" });
  });

  it("keeps only a plain file name for a local document", async () => {
    const { session } = await localHarness();
    await session.openLocal({ name: "../secret/\u0001Report.docx", bytes: await docxBytes(["From disk"]) });
    expect(session.getState().name).toBe("Report.docx");
  });
});
