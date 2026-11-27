import { describe, expect, it } from "vitest";
import { ASSISTANT_AUTHOR, findLabelChanges, fixNumberingAndReferences } from "../../../../home/apps/docs/src/agent/index";
import type { NewParagraph } from "../../../../home/apps/_shared/office-engine/index";
import { contractSession, finalText, sessionWith } from "./helpers";

const heading = (text: string): NewParagraph => ({ text, style: { headingLevel: 1 } });

describe("docs assistant: numbering and cross-references", () => {
  it("finds nothing to renumber in contract.docx and comments on the reference to a missing clause", async () => {
    const { session } = await contractSession();
    const doc = session.requireDocument();
    const before = finalText(doc);
    expect(findLabelChanges(doc)).toEqual([]);
    const result = fixNumberingAndReferences(session);
    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    expect(result.revisionIds).toEqual([]);
    expect(result.brokenReferences).toBeGreaterThanOrEqual(1);
    expect(doc.listComments().some((comment) => comment.anchorText === "clause 14.3" && comment.author === ASSISTANT_AUTHOR)).toBe(true);
    expect(finalText(doc)).toBe(before);
  });

  it("renumbers skipped and repeated clause numbers and updates references to them, as tracked changes", async () => {
    const session = await sessionWith([
      heading("1. Scope"),
      "1.1\tThe Supplier provides the Services.",
      "1.3\tThe Customer pays the Charges.",
      "1.3\tFees are reviewed yearly as set out in clause 1.3.",
      heading("3. Term"),
      "3.1\tThis Agreement lasts one year, subject to clause 3.2.",
      "3.2\tEither party may end it under clause 1.3.",
      "(a)\tfirst item;",
      "(c)\tsecond item; and",
      "(c)\tthird item.",
    ]);
    const doc = session.requireDocument();
    expect(findLabelChanges(doc).map((change) => [change.from, change.to])).toEqual([
      ["1.3", "1.2"],
      ["3", "2"],
      ["3.1", "2.1"],
      ["3.2", "2.2"],
      ["(c)", "(b)"],
    ]);
    const result = fixNumberingAndReferences(session);
    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    const text = finalText(doc);
    expect(text).toContain("1.2\tThe Customer pays the Charges.");
    expect(text).toContain("2. Term");
    expect(text).toContain("2.1\tThis Agreement lasts one year, subject to clause 2.2.");
    expect(text).toContain("2.2\tEither party may end it");
    expect(text).toContain("(b)\tsecond item;");
    expect(result.updatedReferences).toBeGreaterThanOrEqual(1);
    expect(doc.listRevisions().every((revision) => revision.author === ASSISTANT_AUTHOR)).toBe(true);
    expect(result.changes.length).toBeGreaterThanOrEqual(5);
    // Undo takes it all back in one step.
    session.undo();
    expect(doc.listRevisions()).toEqual([]);
  });

  it("reports no changes for a correctly numbered document without references", async () => {
    const session = await sessionWith([heading("1. Scope"), "1.1\tOne.", "1.2\tTwo.", heading("2. Term"), "2.1\tThree."]);
    expect(fixNumberingAndReferences(session)).toEqual({ status: "no_changes" });
  });
});
