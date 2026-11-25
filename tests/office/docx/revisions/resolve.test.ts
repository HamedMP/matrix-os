import { describe, expect, it } from "vitest";

import type { DocxDocument, Revision, TableBlock } from "../../../../packages/office/src/api/docx.js";
import { openDocx } from "../../../../packages/office/src/docx/index.js";
import { isOfficeError } from "../../../../packages/office/src/errors.js";
import { blockXml, bodyXml, documentXml, openFixture, paragraphStarting, reopen, text } from "../edit/helpers.js";
import { expectedText, loadFixture } from "../model/helpers.js";

const REVISION_XML = /<w:(ins|del|moveFrom|moveTo|rPrChange|pPrChange|delText|moveFromRangeStart|moveFromRangeEnd|moveToRangeStart|moveToRangeEnd)\b/;

function find(doc: DocxDocument, kind: Revision["kind"], textStart: string): Revision {
  const found = doc.listRevisions().find((revision) => revision.kind === kind && revision.text.startsWith(textStart));
  if (found === undefined) throw new Error(`no ${kind} revision starting with ${JSON.stringify(textStart)}`);
  return found;
}

function table(doc: DocxDocument): TableBlock {
  const block = doc.getView().body.blocks.find((entry) => entry.type === "table");
  if (block?.type !== "table") throw new Error("no table");
  return block;
}

describe("accepting and rejecting everything", () => {
  it("accept all gives the text of the independent tool and leaves no revision markup", async () => {
    const doc = await openFixture("tracked.docx");
    const ids = doc.listRevisions().map((revision) => revision.id);
    const result = doc.acceptRevisions("all");
    expect(text(doc, "markup")).toBe(expectedText("tracked.docx.txt"));
    expect(result.resolvedIds).toEqual(ids);
    expect(doc.listRevisions()).toEqual([]);
    expect(doc.getView().revisionCount).toBe(0);
    expect(documentXml(doc)).not.toMatch(REVISION_XML);
    expect(result.changedStoryIds).toEqual(["body"]);
    expect(result.createdBlockIds).toEqual([]);
    // The moved-away paragraph and the deleted paragraph are gone.
    expect(result.removedBlockIds).toHaveLength(2);
    const again = await reopen(doc);
    expect(text(again, "markup")).toBe(expectedText("tracked.docx.txt"));
    expect(again.listRevisions()).toEqual([]);
  });

  it("reject all gives the text of the independent tool and leaves no revision markup", async () => {
    const doc = await openFixture("tracked.docx");
    const result = doc.rejectRevisions("all");
    expect(text(doc, "markup")).toBe(expectedText("tracked.docx.reject.txt"));
    expect(doc.listRevisions()).toEqual([]);
    expect(documentXml(doc)).not.toMatch(REVISION_XML);
    // The inserted paragraph, the moved-in paragraph and the two paragraphs of the inserted row.
    expect(result.removedBlockIds).toHaveLength(4);
    expect(table(doc).rows).toHaveLength(1);
    const again = await reopen(doc);
    expect(text(again, "markup")).toBe(expectedText("tracked.docx.reject.txt"));
  });

  it("is a no-op on a document without revisions and works through the public module", async () => {
    const doc = await openDocx(loadFixture("basic.docx"));
    const before = documentXml(doc);
    const empty = { resolvedIds: [], createdBlockIds: [], removedBlockIds: [], changedBlockIds: [], changedStoryIds: [] };
    expect(doc.acceptRevisions("all")).toEqual(empty);
    expect(doc.rejectRevisions("all")).toEqual(empty);
    expect(doc.acceptRevisions([])).toEqual(empty);
    expect(documentXml(doc)).toBe(before);
    const tracked = await openDocx(loadFixture("tracked.docx"));
    tracked.acceptRevisions("all");
    expect(tracked.getPlainText()).toBe(expectedText("tracked.docx.txt"));
  });

  it("throws for an unknown id and changes nothing", async () => {
    const doc = await openFixture("tracked.docx");
    const before = documentXml(doc);
    const known = doc.listRevisions()[0]?.id as string;
    const attempts: Array<[() => unknown, string]> = [
      [() => doc.acceptRevisions([known, "rev999"]), "stale_reference"],
      [() => doc.rejectRevisions(["nope"]), "stale_reference"],
      [() => doc.acceptRevisions("some" as never), "invalid_argument"],
    ];
    for (const [run, expected] of attempts) {
      let code = "none";
      try {
        run();
      } catch (error) {
        code = isOfficeError(error) ? error.code : "other";
      }
      expect(code).toBe(expected);
    }
    expect(documentXml(doc)).toBe(before);
    expect(doc.listRevisions()).toHaveLength(14);
  });
});

describe("resolving one revision at a time", () => {
  it("accepts and rejects a text insertion", async () => {
    const doc = await openFixture("tracked.docx");
    const paragraph = paragraphStarting(doc, "The supplier shall deliver");
    const others = bodyXml(doc);
    const insertion = find(doc, "insert", "revised");
    const snapshot = doc.snapshot();
    const accepted = doc.acceptRevisions([insertion.id]);
    expect(accepted).toMatchObject({ resolvedIds: [insertion.id], changedBlockIds: [paragraph.id], removedBlockIds: [] });
    expect(blockXml(doc, paragraph.id)).toContain('<w:r><w:t xml:space="preserve">revised </w:t></w:r><w:r>');
    expect(doc.listRevisions()).toHaveLength(13);
    // Only that paragraph changed.
    expect(bodyXml(doc).filter((xml, at) => xml !== others[at])).toHaveLength(1);
    doc.restore(snapshot);
    doc.rejectRevisions([insertion.id]);
    expect(blockXml(doc, paragraph.id)).not.toContain("revised");
    expect(doc.getBlock(paragraph.id)).toMatchObject({ text: "The supplier shall deliver the report within tenfifteen business days." });
  });

  it("resolves the halves of a replacement separately", async () => {
    const doc = await openFixture("tracked.docx");
    const paragraph = paragraphStarting(doc, "The supplier shall deliver");
    const deletion = find(doc, "delete", "ten");
    const insertion = find(doc, "insert", "fifteen");
    expect(deletion.pairedWith).toBe(insertion.id);
    const result = doc.rejectRevisions([deletion.id]);
    expect(result.resolvedIds).toEqual([deletion.id]);
    expect(blockXml(doc, paragraph.id)).toContain("<w:r><w:t>ten</w:t></w:r><w:ins ");
    expect(doc.listRevisions().find((revision) => revision.id === insertion.id)).toMatchObject({ pairedWith: null });
    doc.rejectRevisions([insertion.id]);
    expect(doc.getBlock(paragraph.id)).toMatchObject({ text: "The supplier shall deliver the revised report within ten business days." });
  });

  it("resolves a deletion nested in another author's insertion in either order", async () => {
    const doc = await openFixture("tracked.docx");
    const paragraph = paragraphStarting(doc, "Fees are fixed");
    const outer = find(doc, "insert", " Thereafter");
    const nested = find(doc, "delete", "five");
    const snapshot = doc.snapshot();
    doc.acceptRevisions([outer.id]);
    // The deletion is still pending, now in ordinary text.
    expect(doc.listRevisions().map((revision) => revision.id)).toContain(nested.id);
    expect(blockXml(doc, paragraph.id)).toMatch(/<\/w:r><w:del w:id="110"[^>]*><w:r><w:delText>five<\/w:delText><\/w:r><\/w:del>/);
    doc.rejectRevisions([nested.id]);
    expect(blockXml(doc, paragraph.id)).toContain("<w:r><w:t>five</w:t></w:r>");
    doc.restore(snapshot);
    doc.rejectRevisions([outer.id]);
    // Text one author inserted and another deleted disappears with the insertion.
    expect(doc.listRevisions().map((revision) => revision.id)).not.toContain(nested.id);
    expect(blockXml(doc, paragraph.id)).not.toContain("five");
    doc.restore(snapshot);
    doc.acceptRevisions([nested.id]);
    expect(blockXml(doc, paragraph.id)).not.toContain("five");
    expect(doc.listRevisions().map((revision) => revision.id)).toContain(outer.id);
  });

  it("resolves both halves of a move together, with its range markers", async () => {
    const doc = await openFixture("tracked.docx");
    const from = find(doc, "moveFrom", "This paragraph");
    const to = find(doc, "moveTo", "This paragraph");
    const snapshot = doc.snapshot();
    const accepted = doc.acceptRevisions([to.id]);
    expect(accepted.resolvedIds).toEqual([from.id, to.id]);
    expect(accepted.removedBlockIds).toEqual(from.blockIds);
    expect(documentXml(doc)).not.toMatch(/w:move(From|To)/);
    expect(text(doc, "final").match(/This paragraph will be moved to the end\./g)).toHaveLength(1);
    expect(text(doc, "final").indexOf("This paragraph will be moved")).toBeGreaterThan(text(doc, "final").indexOf("Governing law"));
    doc.restore(snapshot);
    const rejected = doc.rejectRevisions([from.id]);
    expect(rejected.resolvedIds).toEqual([from.id, to.id]);
    expect(rejected.removedBlockIds).toEqual(to.blockIds);
    expect(documentXml(doc)).not.toMatch(/w:move(From|To)/);
    expect(text(doc, "final").indexOf("This paragraph will be moved")).toBeLessThan(text(doc, "final").indexOf("Fees are fixed"));
    expect(doc.listRevisions()).toHaveLength(12);
  });

  it("accepts and rejects a run formatting change", async () => {
    const doc = await openFixture("tracked.docx");
    const paragraph = paragraphStarting(doc, "Payment terms");
    const change = find(doc, "format", "net thirty days");
    expect(change.scope).toBe("runFormat");
    const snapshot = doc.snapshot();
    doc.acceptRevisions([change.id]);
    expect(blockXml(doc, paragraph.id)).toContain("<w:r><w:rPr><w:b/></w:rPr><w:t>net thirty days</w:t></w:r>");
    doc.restore(snapshot);
    doc.rejectRevisions([change.id]);
    expect(blockXml(doc, paragraph.id)).toContain("<w:r><w:t>net thirty days</w:t></w:r>");
  });

  it("accepts and rejects a paragraph formatting change", async () => {
    const doc = await openFixture("tracked.docx");
    const paragraph = paragraphStarting(doc, "Governing law");
    const change = find(doc, "format", "Governing law");
    expect(change.scope).toBe("paragraphFormat");
    const snapshot = doc.snapshot();
    doc.acceptRevisions([change.id]);
    expect(blockXml(doc, paragraph.id)).toContain('<w:pPr><w:jc w:val="center"/></w:pPr>');
    doc.restore(snapshot);
    doc.rejectRevisions([change.id]);
    expect(blockXml(doc, paragraph.id)).toContain('<w:pPr><w:jc w:val="left"/></w:pPr>');
    expect(doc.getBlock(paragraph.id)).toMatchObject({ formatRevision: null });
  });

  it("accepts and rejects a deleted paragraph and an inserted paragraph", async () => {
    const doc = await openFixture("tracked.docx");
    const deleted = find(doc, "delete", "This obsolete sentence");
    const inserted = find(doc, "insert", "A new confidentiality");
    const snapshot = doc.snapshot();
    expect(doc.acceptRevisions([deleted.id]).removedBlockIds).toEqual(deleted.blockIds);
    expect(doc.rejectRevisions([inserted.id]).removedBlockIds).toEqual(inserted.blockIds);
    expect(text(doc, "final")).not.toMatch(/obsolete|confidentiality/);
    doc.restore(snapshot);
    expect(doc.rejectRevisions([deleted.id]).removedBlockIds).toEqual([]);
    expect(doc.acceptRevisions([inserted.id]).removedBlockIds).toEqual([]);
    expect(blockXml(doc, deleted.blockIds[0] as string)).toBe("<w:p><w:r><w:t>This obsolete sentence is removed.</w:t></w:r></w:p>");
    expect(blockXml(doc, inserted.blockIds[0] as string)).toBe("<w:p><w:r><w:t>A new confidentiality obligation applies.</w:t></w:r></w:p>");
  });

  it("accepts and rejects an inserted table row", async () => {
    const doc = await openFixture("tracked.docx");
    const row = doc.listRevisions().find((revision) => revision.scope === "tableRow") as Revision;
    const snapshot = doc.snapshot();
    const accepted = doc.acceptRevisions([row.id]);
    expect(accepted.changedBlockIds).toContain(table(doc).id);
    expect(blockXml(doc, table(doc).id)).not.toMatch(/w:ins|w:trPr/);
    expect(table(doc).rows).toHaveLength(2);
    doc.restore(snapshot);
    const rejected = doc.rejectRevisions([row.id]);
    expect(table(doc).rows).toHaveLength(1);
    expect(rejected.removedBlockIds).toHaveLength(2);
    expect(rejected.changedBlockIds).toEqual([table(doc).id]);
  });

  it("resolving every revision one by one equals resolving all", async () => {
    for (const accept of [true, false]) {
      const doc = await openFixture("tracked.docx");
      for (let guard = 0; guard < 40; guard++) {
        const next = doc.listRevisions()[0];
        if (next === undefined) break;
        if (accept) doc.acceptRevisions([next.id]);
        else doc.rejectRevisions([next.id]);
      }
      expect(doc.listRevisions()).toEqual([]);
      expect(text(doc, "markup")).toBe(expectedText(accept ? "tracked.docx.txt" : "tracked.docx.reject.txt"));
      expect(documentXml(doc)).not.toMatch(REVISION_XML);
    }
  });
});
