import { describe, expect, it } from "vitest";

import type { DocxModule, Revision } from "../../../../packages/office/src/api/docx.js";
import * as docx from "../../../../packages/office/src/docx/index.js";
import { compareDocx, compareDocxDetailed, openDocx } from "../../../../packages/office/src/docx/index.js";
import { AUTHOR, DATE, OPTIONS, expectedText, loadFixture, reopen, views } from "./helpers.js";

const v1 = (): Uint8Array => loadFixture("contract.docx");
const v2 = (): Uint8Array => loadFixture("contract-v2.docx");

describe("compareDocx on the services agreement (contract.docx against contract-v2.docx)", () => {
  it("implements the module contract", () => {
    const contract: DocxModule = docx;
    expect(typeof contract.compareDocx).toBe("function");
  });

  it("gives the revised text when every change is accepted and the original text when rejected", async () => {
    const { document } = await compareDocxDetailed(v1(), v2(), OPTIONS);
    const original = (await openDocx(v1())).getPlainText();
    const revised = (await openDocx(v2())).getPlainText();
    expect(views(document).final).toBe(revised);
    expect(views(document).original).toBe(original);
    // The same holds for the file that is written.
    const saved = await reopen(document);
    expect(views(saved).final).toBe(revised);
    expect(views(saved).original).toBe(original);
    // And it agrees with the independently produced golden texts.
    expect(views(saved).final).toBe(`${expectedText("contract-v2.docx.txt")}\n`.replace(/\n\n$/, "\n"));
    expect(views(saved).original).toBe(`${expectedText("contract.docx.txt")}\n`.replace(/\n\n$/, "\n"));
  });

  it("marks every difference as a revision by the given author and date", async () => {
    const document = await compareDocx(v1(), v2(), OPTIONS);
    const revisions = document.listRevisions();
    expect(revisions.length).toBeGreaterThan(12);
    for (const revision of revisions) {
      expect(revision.author).toBe(AUTHOR);
      expect(revision.date).toBe(DATE);
      expect(revision.storyId).toBe("body");
    }
    expect(new Set(revisions.map((revision) => revision.kind))).toEqual(new Set(["insert", "delete", "moveFrom", "moveTo"]));
  });

  it("keeps word-level replacements inside their paragraph", async () => {
    const document = await compareDocx(v1(), v2(), OPTIONS);
    const revisions = document.listRevisions();
    const find = (kind: string, text: string): Revision => {
      const found = revisions.find((revision) => revision.kind === kind && revision.text === text);
      if (found === undefined) throw new Error(`no ${kind} of ${JSON.stringify(text)}`);
      return found;
    };
    const replacements: Array<[string, string]> = [
      ["15", "22"],
      ["24", "36"],
      ["90", "60"],
      ["18,500", "19,250"],
      ["125", "100"],
    ];
    for (const [before, after] of replacements) {
      const deleted = find("delete", before);
      const inserted = find("insert", after);
      expect(deleted.pairedWith).toBe(inserted.id);
      expect(deleted.blockIds).toEqual(inserted.blockIds);
      expect(deleted.blockIds).toHaveLength(1);
      expect(deleted.scope).toBe("text");
    }
    const sentence = revisions.find((revision) => revision.kind === "delete" && revision.text.includes("documented instructions"));
    expect(sentence?.text).toBe(" The Supplier shall process personal data only on the documented instructions of the Customer.");
  });

  it("reports the new clause as an inserted paragraph and the relocated definition as a move", async () => {
    const { document, summary } = await compareDocxDetailed(v1(), v2(), OPTIONS);
    const revisions = document.listRevisions();
    const clause = revisions.find((revision) => revision.kind === "insert" && revision.text.startsWith("7.4"));
    expect(clause?.text).toBe(
      "7.4\tThe Supplier shall ensure that its subcontractors are bound by confidentiality obligations no less protective than this clause 7.\n",
    );
    const from = revisions.find((revision) => revision.kind === "moveFrom");
    const to = revisions.find((revision) => revision.kind === "moveTo");
    expect(from?.text).toContain("“Service Levels”");
    expect(to?.text).toBe(from?.text);
    expect(from?.pairedWith).toBe(to?.id);
    expect(to?.pairedWith).toBe(from?.id);

    expect(summary.identical).toBe(false);
    expect(summary.total).toBe(revisions.length);
    expect(summary.counts.moveFrom).toBe(1);
    expect(summary.counts.moveTo).toBe(1);
    expect(summary.counts.format).toBe(0);
    expect(summary.counts.insert + summary.counts.delete + 2).toBe(revisions.length);
    expect(summary.paragraphs).toMatchObject({ inserted: 1, deleted: 0, moved: 1 });
    expect(summary.substantive).toBe(revisions.length);
    expect(summary.formattingOnly).toBe(0);
    expect(summary.changes.map((change) => change.revisionId)).toEqual(revisions.map((revision) => revision.id));
    expect(summary.changes.every((change) => change.classification === "substantive")).toBe(true);
  });

  it("does not modify its inputs and accepts open documents", async () => {
    const original = await openDocx(v1());
    const revised = await openDocx(v2());
    const before = [original.getPlainText(), revised.getPlainText()];
    const document = await compareDocx(original, revised, OPTIONS);
    expect(document).not.toBe(original);
    expect(original.listRevisions()).toHaveLength(0);
    expect(revised.listRevisions()).toHaveLength(0);
    expect([original.getPlainText(), revised.getPlainText()]).toEqual(before);
    expect(views(document).final).toBe(before[1]);
  });

  it("is deterministic and keeps the styles and settings of the original", async () => {
    const first = await (await compareDocx(v1(), v2(), OPTIONS)).save();
    const second = await (await compareDocx(v1(), v2(), OPTIONS)).save();
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    const result = await openDocx(first);
    const source = await openDocx(v1());
    for (const name of ["/word/styles.xml", "/word/settings.xml", "/word/numbering.xml", "/word/footer1.xml"]) {
      expect(await result.package.getPartText(name)).toBe(await source.package.getPartText(name));
    }
  });

  it("can leave relocated paragraphs as a deletion and an insertion", async () => {
    const { document, summary } = await compareDocxDetailed(v1(), v2(), { ...OPTIONS, detectMoves: false });
    expect(summary.counts.moveFrom).toBe(0);
    expect(summary.counts.moveTo).toBe(0);
    expect(summary.paragraphs).toMatchObject({ inserted: 2, deleted: 1, moved: 0 });
    expect(views(document).final).toBe((await openDocx(v2())).getPlainText());
    expect(views(document).original).toBe((await openDocx(v1())).getPlainText());
  });
});
