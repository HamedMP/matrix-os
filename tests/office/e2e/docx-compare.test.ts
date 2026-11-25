/**
 * Acceptance check 3: comparing two `.docx` versions yields a document with
 * tracked revisions.
 */

import { describe, expect, it } from "vitest";
import type { Revision } from "../../../packages/office/src/index.js";
import { compareDocx, compareDocxDetailed, openDocx } from "../../../packages/office/src/index.js";
import { changedParts, expectedJson, expectedText, keepOutput, loadFixture } from "./helpers.js";

const OPTIONS = { author: "Dana Reviewer", date: "2027-02-01T10:00:00Z" } as const;

/** One edit of `expected/contract-edits.json`, the list the second version was made from. */
interface PlantedEdit {
  op: "replace" | "insert_after" | "delete_sentence" | "move_after";
  key: string;
  old?: string;
  new?: string;
  block?: string[];
}

/** The golden text of a fixture as `getPlainText` writes it: every paragraph ends with a line break. */
function golden(name: string): string {
  return `${expectedText(name).replace(/\n+$/, "")}\n`;
}

describe("comparing contract.docx with contract-v2.docx", () => {
  it("writes every difference as a tracked revision by the given author", async () => {
    const v1 = loadFixture("contract.docx");
    const v2 = loadFixture("contract-v2.docx");
    const compared = await compareDocx(v1, v2, OPTIONS);
    const revisions = compared.listRevisions();
    expect(revisions.length).toBeGreaterThanOrEqual(12);
    for (const revision of revisions) expect(revision).toMatchObject({ author: OPTIONS.author, date: OPTIONS.date });
    expect(new Set(revisions.map((revision) => revision.kind))).toEqual(new Set(["insert", "delete", "moveFrom", "moveTo"]));

    // Accepting everything is the second version; rejecting everything is the first.
    const original = (await openDocx(v1)).getPlainText();
    const revised = (await openDocx(v2)).getPlainText();
    expect(original).not.toBe(revised);
    expect(compared.getPlainText({ view: "final" })).toBe(revised);
    expect(compared.getPlainText({ view: "original" })).toBe(original);
    // The same texts as the independent tool extracted from the two files.
    expect(revised).toBe(golden("contract-v2.docx.txt"));
    expect(original).toBe(golden("contract.docx.txt"));
  });

  it("shows each edit that was made to the second version", async () => {
    const compared = await compareDocx(loadFixture("contract.docx"), loadFixture("contract-v2.docx"), OPTIONS);
    const revisions = compared.listRevisions();
    const deleted = revisions.filter((revision) => revision.kind === "delete").map((revision) => revision.text);
    const inserted = revisions.filter((revision) => revision.kind === "insert").map((revision) => revision.text);
    const planted = expectedJson<PlantedEdit[]>("contract-edits.json");
    expect(planted).toHaveLength(12);
    /** The words of `from` that are not in `to`: what a word-level comparison marks. A word is a run of letters and digits. */
    const words = (text: string): string[] => text.split(/[^\p{L}\p{N}]+/u).filter((word) => word !== "");
    const differing = (from: string, to: string): string[] => {
      const other = new Set(words(to));
      return words(from).filter((word) => !other.has(word));
    };
    for (const edit of planted) {
      if (edit.op === "replace") {
        for (const word of differing(edit.old ?? "", edit.new ?? "")) expect(deleted.some((text) => text.includes(word)), `${edit.key}: deleted ${word}`).toBe(true);
        for (const word of differing(edit.new ?? "", edit.old ?? "")) expect(inserted.some((text) => text.includes(word)), `${edit.key}: inserted ${word}`).toBe(true);
      } else if (edit.op === "insert_after") {
        const text = edit.block?.[3] ?? "";
        expect(inserted.some((entry) => entry.includes(text)), edit.key).toBe(true);
      } else if (edit.op === "delete_sentence") {
        expect(deleted.some((entry) => entry.includes((edit.old ?? "").trim())), edit.key).toBe(true);
      } else {
        const from = revisions.find((revision) => revision.kind === "moveFrom") as Revision;
        const to = revisions.find((revision) => revision.kind === "moveTo") as Revision;
        expect(from.text).toContain("“Service Levels” means the service levels set out in clause 4.");
        expect(to.text).toContain("“Service Levels” means the service levels set out in clause 4.");
        expect(from.pairedWith).toBe(to.id);
        expect(to.pairedWith).toBe(from.id);
      }
    }
  });

  it("saves a file whose revisions can be resolved after reopening", async () => {
    const v1 = loadFixture("contract.docx");
    const v2 = loadFixture("contract-v2.docx");
    const { document, summary } = await compareDocxDetailed(v1, v2, OPTIONS);
    expect(summary.identical).toBe(false);
    expect(summary.total).toBe(document.listRevisions().length);
    const saved = await document.save();
    keepOutput("compare-contract-v1-v2.docx", saved);
    // The comparison is built on the first version: its styles and settings are untouched.
    const changed = await changedParts(v1, saved);
    expect(changed).toContain("/word/document.xml");
    expect(changed).not.toContain("/word/styles.xml");

    const accepted = await openDocx(saved);
    expect(accepted.listRevisions().length).toBe(summary.total);
    accepted.acceptRevisions("all");
    expect(accepted.listRevisions()).toEqual([]);
    expect(accepted.getPlainText()).toBe(golden("contract-v2.docx.txt"));
    keepOutput("compare-contract-accepted.docx", await accepted.save());

    const rejected = await openDocx(saved);
    rejected.rejectRevisions("all");
    expect(rejected.getPlainText()).toBe(golden("contract.docx.txt"));
    keepOutput("compare-contract-rejected.docx", await rejected.save());

    // One by one: accepting only the longer term changes that clause and nothing else.
    const partial = await openDocx(saved);
    const term = partial.listRevisions().filter((revision) => (revision.kind === "delete" && revision.text === "24") || (revision.kind === "insert" && revision.text === "36"));
    expect(term).toHaveLength(2);
    partial.acceptRevisions(term.map((revision) => revision.id));
    expect(partial.listRevisions().length).toBe(summary.total - 2);
    expect(partial.getPlainText({ view: "original" })).toContain("initial period of 36 months");
    expect(partial.getPlainText({ view: "original" })).toContain("at least 90 days’ written notice");
  });

  it("finds nothing when a document is compared with itself, and does not change its inputs", async () => {
    const v1 = loadFixture("contract.docx");
    const copy = v1.slice();
    const first = await openDocx(v1);
    const { document, summary } = await compareDocxDetailed(first, v1, OPTIONS);
    expect(summary.identical).toBe(true);
    expect(document.listRevisions()).toEqual([]);
    expect(first.listRevisions()).toEqual([]);
    expect(v1).toEqual(copy);
    expect(await changedParts(v1, await first.save())).toEqual([]);
  });
});
