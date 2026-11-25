/**
 * Acceptance check 2: an agent edit to a `.docx` appears as tracked
 * revisions that can be accepted or rejected one by one, and the saved file
 * is valid for independent readers.
 *
 * The flow is the one the Docs app and the agent tools run: describe the
 * document, read the agent's JSON answer, plan it against the document,
 * apply it as tracked changes, let the owner resolve them, save, reopen.
 */

import { describe, expect, it } from "vitest";
import type { DocxDocument, Revision } from "../../../packages/office/src/index.js";
import { describeDocx, openDocx, parseAgentEdits, toDocxOps } from "../../../packages/office/src/index.js";
import { AGENT, AGENT_TRACKED, DATE, changedParts, keepOutput, loadFixture, paragraphStarting } from "./helpers.js";

/** The block id at the start of the description line that holds `text`. */
function idOfLine(description: string, text: string): string {
  const line = description.split("\n").find((entry) => entry.includes(text));
  const id = line === undefined ? undefined : /^\[([^\]]+)\]/.exec(line)?.[1];
  if (id === undefined) throw new Error(`no described paragraph holds ${JSON.stringify(text)}`);
  return id;
}

/** What an agent would answer after reading the description: prose around a fenced JSON envelope. */
function agentAnswer(description: string): string {
  const envelope = {
    kind: "docx",
    edits: [
      { op: "replaceText", blockId: idOfLine(description, "initial period of 24 months"), find: "24 months", replace: "36 months" },
      { op: "replaceText", blockId: idOfLine(description, "at least 90 days’ written notice"), find: "90 days’", replace: "60 days’" },
      { op: "replaceText", blockId: idOfLine(description, "“Commencement Date” means"), find: "1 February 2027", replace: "1 March 2027" },
      {
        op: "insertParagraph",
        blockId: idOfLine(description, "“Term” has the meaning"),
        text: "“Customer Data” means all data supplied by the Customer to the Supplier under this Agreement.",
      },
      { op: "deleteParagraph", blockId: idOfLine(description, "“Change Request” means"), startsWith: "“Change Request” means a written request" },
      { op: "comment", blockId: idOfLine(description, "12.5"), find: "clause 14.3", text: "There is no clause 14.3 in this agreement." },
      // Two edits the document does not support: a stale quote and a block that does not exist.
      { op: "replaceText", blockId: idOfLine(description, "initial period of 24 months"), find: "48 months", replace: "60 months" },
      { op: "replaceText", blockId: "b9999", find: "anything", replace: "nothing" },
    ],
    summary: "Extends the term, shortens the notice period, defines Customer Data and removes an unused definition.",
  };
  return `I reviewed the agreement. Proposed edits:\n\n\`\`\`json\n${JSON.stringify(envelope, null, 2)}\n\`\`\`\n\nEach one is a tracked change for you to accept or reject.`;
}

async function proposeEdits(): Promise<{ document: DocxDocument; source: Uint8Array; originalText: string }> {
  const source = loadFixture("contract.docx");
  const document = await openDocx(source);
  const originalText = document.getPlainText();
  const description = describeDocx(document, { maxChars: 60_000 });
  expect(description.truncated).toBe(false);
  const parsed = parseAgentEdits(agentAnswer(description.text), "docx");
  if (!parsed.ok || parsed.envelope.kind !== "docx") throw new Error("the agent answer did not parse");
  const plan = toDocxOps(document, parsed.envelope.edits);
  expect(plan.rejected.map((entry) => [entry.index, entry.code])).toEqual([
    [6, "stale_reference"],
    [7, "not_found"],
  ]);
  expect([...plan.opEditIndexes].sort()).toEqual([0, 1, 2, 3, 4, 5]);
  // Planning changed nothing.
  expect(document.listRevisions()).toEqual([]);
  expect(document.getPlainText()).toBe(originalText);
  const result = document.applyOps(plan.ops, AGENT_TRACKED);
  expect(result.revisionIds.length).toBeGreaterThan(0);
  return { document, source, originalText };
}

function find(revisions: readonly Revision[], kind: string, text: string): Revision {
  const found = revisions.find((revision) => revision.kind === kind && revision.text.includes(text));
  if (found === undefined) throw new Error(`no ${kind} revision holds ${JSON.stringify(text)}`);
  return found;
}

describe("agent edits to contract.docx", () => {
  it("arrive as tracked revisions by the agent and leave the original text in place", async () => {
    const { document, originalText } = await proposeEdits();
    const revisions = document.listRevisions();
    expect(revisions.map((revision) => [revision.kind, revision.text.trim()])).toEqual([
      ["delete", "“Change Request” means a written request by either party to change the scope of the Services."],
      ["delete", "February"],
      ["insert", "March"],
      ["insert", "“Customer Data” means all data supplied by the Customer to the Supplier under this Agreement."],
      ["delete", "24"],
      ["insert", "36"],
      ["delete", "90"],
      ["insert", "60"],
    ]);
    for (const revision of revisions) {
      expect(revision).toMatchObject({ author: AGENT, date: DATE, storyId: "body" });
      expect(revision.blockIds.length).toBeGreaterThan(0);
    }
    // A replacement is a deletion and an insertion that name each other.
    const deleted = find(revisions, "delete", "24");
    const inserted = find(revisions, "insert", "36");
    expect(deleted.pairedWith).toBe(inserted.id);
    expect(inserted.pairedWith).toBe(deleted.id);
    // Rejecting everything would give the document the owner started with.
    expect(document.getPlainText({ view: "original" })).toBe(originalText);
    expect(document.getPlainText({ view: "final" })).toContain("initial period of 36 months");
    expect(document.listComments().map((comment) => [comment.author, comment.anchorText, comment.text])).toEqual([
      [AGENT, "clause 14.3", "There is no clause 14.3 in this agreement."],
    ]);
    expect(document.getView().revisionCount).toBe(revisions.length);
  });

  it("are resolved one by one, saved, and read back", async () => {
    const { document, source, originalText } = await proposeEdits();
    const before = document.listRevisions();
    const term = [find(before, "delete", "24"), find(before, "insert", "36")];
    const notice = [find(before, "delete", "90"), find(before, "insert", "60")];
    const date = [find(before, "delete", "February"), find(before, "insert", "March")];
    const definition = find(before, "insert", "“Customer Data” means");
    const removal = find(before, "delete", "“Change Request” means");

    // The owner accepts the longer term (one half; the other stays pending until it is resolved too) …
    const acceptedDelete = document.acceptRevisions([term[0]?.id ?? ""]);
    expect(acceptedDelete.resolvedIds).toEqual([term[0]?.id]);
    expect(document.listRevisions().map((revision) => revision.id)).not.toContain(term[0]?.id);
    expect(document.listRevisions().map((revision) => revision.id)).toContain(term[1]?.id);
    document.acceptRevisions([term[1]?.id ?? ""]);
    // … accepts the new definition, rejects the shorter notice period and the removal, and leaves the date pending.
    document.acceptRevisions([definition.id]);
    document.rejectRevisions(notice.map((revision) => revision.id));
    document.rejectRevisions([removal.id]);

    const pending = document.listRevisions();
    expect(pending.map((revision) => revision.id).sort()).toEqual(date.map((revision) => revision.id).sort());
    const final = document.getPlainText({ view: "final" });
    expect(final).toContain("initial period of 36 months");
    expect(final).toContain("at least 90 days’ written notice");
    expect(final).toContain("“Customer Data” means all data supplied by the Customer");
    expect(final).toContain("“Change Request” means a written request");
    expect(final).toContain("“Commencement Date” means 1 March 2027.");
    expect(document.getPlainText({ view: "original" })).toContain("“Commencement Date” means 1 February 2027.");
    // A resolved revision cannot be resolved again.
    expect(() => document.acceptRevisions([removal.id])).toThrow();

    const saved = await document.save();
    keepOutput("agent-review-contract.docx", saved);
    // Only the parts the edits touch changed: the text, and the parts a first comment brings.
    const changed = await changedParts(source, saved);
    expect(changed).toContain("/word/document.xml");
    for (const name of changed) expect(name).toMatch(/^\/word\/(document\.xml|comments[A-Za-z]*\.xml|people\.xml|settings\.xml|_rels\/document\.xml\.rels)$/);
    expect(changed).not.toContain("/word/styles.xml");

    const reopened = await openDocx(saved);
    expect(reopened.getPlainText({ view: "final" })).toBe(final);
    expect(reopened.listRevisions().map((revision) => [revision.kind, revision.text, revision.author, revision.date])).toEqual([
      ["delete", "February", AGENT, DATE],
      ["insert", "March", AGENT, DATE],
    ]);
    expect(reopened.listComments().map((comment) => comment.anchorText)).toEqual(["clause 14.3"]);

    // Resolving what is left, both ways, from the saved file.
    reopened.rejectRevisions("all");
    expect(reopened.listRevisions()).toEqual([]);
    expect(reopened.getPlainText()).toContain("“Commencement Date” means 1 February 2027.");
    const other = await openDocx(saved);
    other.acceptRevisions("all");
    expect(other.getPlainText()).toContain("“Commencement Date” means 1 March 2027.");
    keepOutput("agent-review-contract-accepted.docx", await other.save());
    expect(originalText).toContain("initial period of 24 months");
  });

  it("can all be rejected, which gives back the text the owner started with", async () => {
    const { document, originalText } = await proposeEdits();
    keepOutput("agent-proposed-contract.docx", await document.save());
    const result = document.rejectRevisions("all");
    expect(result.resolvedIds.length).toBe(8);
    expect(document.listRevisions()).toEqual([]);
    expect(document.getPlainText()).toBe(originalText);
    expect(document.getPlainText({ view: "markup" })).toBe(originalText);
    const saved = await document.save();
    keepOutput("agent-rejected-contract.docx", saved);
    expect((await openDocx(saved)).getPlainText()).toBe(originalText);
  });

  it("can all be accepted, which gives the agent's text without revisions", async () => {
    const { document } = await proposeEdits();
    const final = document.getPlainText({ view: "final" });
    document.acceptRevisions("all");
    expect(document.listRevisions()).toEqual([]);
    expect(document.getPlainText({ view: "original" })).toBe(final);
    expect(final).not.toContain("“Change Request”");
    const term = paragraphStarting(document, "2.1\t");
    expect(term.text).toContain("36 months");
    expect(term.runs.every((run) => run.revision === null)).toBe(true);
  });

  it("can be undone as a whole through a snapshot", async () => {
    const source = loadFixture("contract.docx");
    const document = await openDocx(source);
    const snapshot = document.snapshot();
    const block = paragraphStarting(document, "2.1\t");
    const plan = toDocxOps(document, [{ op: "replaceText", blockId: block.id, find: "24 months", replace: "36 months" }]);
    document.applyOps(plan.ops, AGENT_TRACKED);
    expect(document.listRevisions()).toHaveLength(2);
    document.restore(snapshot);
    expect(document.listRevisions()).toEqual([]);
    expect(await changedParts(source, await document.save())).toEqual([]);
  });
});
