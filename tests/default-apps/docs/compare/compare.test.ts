import { describe, expect, it } from "vitest";
import { COMPARE_AUTHOR, answerSubstantive, compareWithBytes, compareWithFile, comparisonName, kindCounts } from "../../../../home/apps/docs/src/compare/index";
import type { CompareSummary } from "../../../../home/apps/docs/src/compare/index";
import { contractSession, fixture } from "../agent/helpers";

const NOW = () => new Date("2026-11-23T09:00:00.000Z");

function summary(partial: Partial<CompareSummary>): CompareSummary {
  return {
    identical: false,
    total: 0,
    counts: { insert: 0, delete: 0, moveFrom: 0, moveTo: 0, format: 0 },
    substantive: 0,
    formattingOnly: 0,
    paragraphs: { inserted: 0, deleted: 0, moved: 0 },
    tableRows: { inserted: 0, deleted: 0 },
    changes: [],
    ...partial,
  };
}

describe("docs compare", () => {
  it("compares contract.docx with contract-v2.docx and opens the redline as a new unsaved document", async () => {
    const { session, files } = await contractSession({ "Documents/contract-v2.docx": fixture("contract-v2.docx") });
    const result = await compareWithFile({ session, files, now: NOW }, "Documents/contract-v2.docx");
    expect(result.status).toBe("compared");
    if (result.status !== "compared") return;

    const state = session.getState();
    expect(state).toMatchObject({ status: "ready", path: null, dirty: true, name: "contract compared with contract-v2.docx" });
    const doc = session.requireDocument();
    const revisions = doc.listRevisions();
    expect(revisions.length).toBe(result.summary.total);
    expect(state.revisionCount).toBe(result.summary.total);
    expect(new Set(revisions.map((revision) => revision.author))).toEqual(new Set([COMPARE_AUTHOR]));

    expect(result.summary.substantive).toBeGreaterThan(0);
    expect(result.answer.changed).toBe(true);
    expect(result.answer.headline).toMatch(/^Yes\. \d+ changes alter the wording/);
    expect(result.counts.map((entry) => entry.label)).toEqual(expect.arrayContaining(["Insertions", "Deletions"]));

    // Accepting everything gives the revised text; the original file is untouched.
    const revised = (await (await import("../../../../home/apps/_shared/office-engine/index")).openDocx(fixture("contract-v2.docx"))).getPlainText({ view: "final" });
    session.acceptRevisions("all");
    expect(doc.getPlainText({ view: "final" })).toBe(revised);
    expect(files.writes).toEqual([]);
  });

  it("answers no for identical versions", async () => {
    const { session } = await contractSession();
    const result = await compareWithBytes({ session, now: NOW }, fixture("contract.docx"), "contract copy.docx");
    expect(result).toMatchObject({ status: "compared", answer: { changed: false, headline: "No. The two versions are identical." }, counts: [] });
  });

  it("derives the substantive answer from the engine's classification", () => {
    expect(answerSubstantive(summary({ total: 3, formattingOnly: 3, counts: { insert: 0, delete: 0, moveFrom: 0, moveTo: 0, format: 3 } }))).toMatchObject({
      changed: false,
      headline: "No. Only the formatting changed; the wording is the same.",
    });
    const mixed = answerSubstantive(summary({ total: 4, substantive: 1, formattingOnly: 3, paragraphs: { inserted: 1, deleted: 0, moved: 0 } }));
    expect(mixed).toMatchObject({ changed: true, headline: "Yes. 1 change alters the wording (1 paragraph added)." });
    expect(mixed.detail).toBe("1 substantive change and 3 formatting-only changes, 4 revisions in all.");
    expect(kindCounts(summary({ counts: { insert: 2, delete: 1, moveFrom: 1, moveTo: 1, format: 0 } }))).toEqual([
      { label: "Insertions", count: 2 },
      { label: "Deletions", count: 1 },
      { label: "Moves", count: 1 },
    ]);
  });

  it("explains a file that is not a Word document and leaves the open document as it was", async () => {
    const { session } = await contractSession();
    const doc = session.requireDocument();
    const result = await compareWithBytes({ session, now: NOW, log: () => undefined }, new TextEncoder().encode("not a zip"), "notes.docx");
    expect(result).toEqual({ status: "failed", reason: "unreadable", message: "That file is not a Word document this app can read." });
    expect(session.requireDocument()).toBe(doc);
  });

  it("maps a missing file and is blocked by unsaved changes it cannot save", async () => {
    const { session, files } = await contractSession({ "Documents/contract-v2.docx": fixture("contract-v2.docx") });
    expect(await compareWithFile({ session, files, log: () => undefined }, "Documents/missing.docx")).toMatchObject({ status: "failed", reason: "not_found" });
    await session.createNew({ discardChanges: true });
    session.apply([{ type: "insertText", at: { blockId: session.requireDocument().getView().body.blocks[0]!.id, offset: 0 }, text: "Draft" }]);
    const unsaved = session.requireDocument();
    expect(await compareWithFile({ session, files, now: NOW }, "Documents/contract-v2.docx")).toMatchObject({ status: "failed", reason: "blocked" });
    expect(session.requireDocument()).toBe(unsaved);
  });

  it("drops the result when another document opens while the other version is read", async () => {
    const { session, files } = await contractSession({ "Documents/contract-v2.docx": fixture("contract-v2.docx"), "Documents/other.docx": fixture("contract.docx") });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = { read: async (path: string) => (await gate, files.read(path)) };
    const pending = compareWithFile({ session, files: slow, now: NOW, log: () => undefined }, "Documents/contract-v2.docx");
    expect(await session.open("Documents/other.docx")).toMatchObject({ status: "opened" });
    const other = session.requireDocument();
    release();
    expect(await pending).toEqual({ status: "failed", reason: "document_changed", message: "Another document was opened while comparing. Compare again." });
    expect(session.requireDocument()).toBe(other);
    expect(session.getState()).toMatchObject({ path: "Documents/other.docx", dirty: false });
  });

  it("drops the result when another document opens while the comparison runs or the device file is read", async () => {
    const { session } = await contractSession({ "Documents/other.docx": fixture("contract.docx") });
    // The panel reads a device file before it compares; the key it took before reading is what counts.
    const documentKey = session.getState().documentKey;
    await session.open("Documents/other.docx");
    const other = session.requireDocument();
    expect(await compareWithBytes({ session, now: NOW, documentKey }, fixture("contract-v2.docx"), "contract-v2.docx")).toMatchObject({ status: "failed", reason: "document_changed" });
    expect(session.requireDocument()).toBe(other);

    const pending = compareWithBytes({ session, now: NOW }, fixture("contract-v2.docx"), "contract-v2.docx");
    await session.open("Documents/contract.docx");
    const reopened = session.requireDocument();
    expect(await pending).toMatchObject({ status: "failed", reason: "document_changed" });
    expect(session.requireDocument()).toBe(reopened);
  });

  it("names the comparison after both files", () => {
    expect(comparisonName("contract.docx", "contract-v2.docx")).toBe("contract compared with contract-v2.docx");
  });
});
