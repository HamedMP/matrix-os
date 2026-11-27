import { describe, expect, it } from "vitest";
import {
  REVIEW_ORIGIN,
  acceptFormattingChanges,
  resolveByAuthor,
  resolveRevisions,
} from "../../../../home/apps/docs/src/review/index";
import type { DocumentChange } from "../../../../home/apps/docs/src/session/index";
import { ALEX, PRIYA, finalText, fixtureSession, originalText, plainSession, revisionIds } from "./helpers";

describe("resolveRevisions on tracked.docx", () => {
  it("accepting one insertion keeps its text and leaves the others pending; undo brings it back", async () => {
    const session = await fixtureSession("tracked.docx");
    const doc = session.requireDocument();
    const revised = doc.listRevisions().find((revision) => revision.text === "revised ")!;
    const before = revisionIds(session);
    const changes: DocumentChange[] = [];
    session.onChange((change) => changes.push(change));

    const outcome = resolveRevisions(session, "accept", [revised.id]);

    expect(outcome).toEqual({ ok: true, resolvedIds: [revised.id] });
    expect(revisionIds(session)).toEqual(before.filter((id) => id !== revised.id));
    expect(originalText(session)).toContain("the revised report");
    expect(changes.at(-1)).toMatchObject({ kind: "resolve", origin: REVIEW_ORIGIN });
    expect(session.getState()).toMatchObject({ dirty: true, canUndo: true, revisionCount: before.length - 1 });

    expect(session.undo()).toBe(true);
    expect(revisionIds(session)).toEqual(before);
    expect(originalText(session)).not.toContain("revised report");
  });

  it("rejecting a deletion restores the text; rejecting its paired insertion removes the replacement", async () => {
    const session = await fixtureSession("tracked.docx");
    const revisions = session.requireDocument().listRevisions();
    const ten = revisions.find((revision) => revision.text === "ten")!;
    const fifteen = revisions.find((revision) => revision.text === "fifteen")!;
    expect(resolveRevisions(session, "reject", [ten.id, fifteen.id]).ok).toBe(true);
    expect(finalText(session)).toContain("within ten business days");
    expect(finalText(session)).not.toContain("fifteen");
  });

  it("accept all gives the final text with no revisions; reject all gives the original text", async () => {
    const accepted = await fixtureSession("tracked.docx");
    const expectedFinal = finalText(accepted);
    expect(resolveRevisions(accepted, "accept", "all").ok).toBe(true);
    expect(revisionIds(accepted)).toEqual([]);
    expect(finalText(accepted)).toBe(expectedFinal);

    const rejected = await fixtureSession("tracked.docx");
    const expectedOriginal = originalText(rejected);
    expect(resolveRevisions(rejected, "reject", "all").ok).toBe(true);
    expect(revisionIds(rejected)).toEqual([]);
    expect(finalText(rejected)).toBe(expectedOriginal);
    // One undo step undoes the whole bulk action.
    expect(rejected.undo()).toBe(true);
    expect(revisionIds(rejected)).toHaveLength(14);
  });

  it("resolving one half of a move resolves the other half", async () => {
    const session = await fixtureSession("tracked.docx");
    const from = session.requireDocument().listRevisions().find((revision) => revision.kind === "moveFrom")!;
    const outcome = resolveRevisions(session, "accept", [from.id]);
    expect(outcome.ok && outcome.resolvedIds.sort()).toEqual([from.id, from.pairedWith!].sort());
    expect(session.requireDocument().listRevisions().some((revision) => revision.kind === "moveTo")).toBe(false);
  });

  it("skips ids that are gone and reports when nothing is left to do", async () => {
    const session = await fixtureSession("tracked.docx");
    const first = revisionIds(session)[0]!;
    expect(resolveRevisions(session, "accept", [first, "rev-missing"]).ok).toBe(true);
    expect(resolveRevisions(session, "accept", [first])).toEqual({ ok: false, reason: "nothing" });
    const plain = await plainSession(["No changes here"]);
    expect(resolveRevisions(plain, "accept", "all")).toEqual({ ok: false, reason: "nothing" });
    expect(plain.getState().canUndo).toBe(false);
  });
});

describe("bulk actions", () => {
  it("accepts every revision by one author and keeps the other author's", async () => {
    const session = await fixtureSession("tracked.docx");
    expect(resolveByAuthor(session, "accept", ALEX).ok).toBe(true);
    const authors = new Set(session.requireDocument().listRevisions().map((revision) => revision.author));
    expect([...authors]).toEqual([PRIYA]);
  });

  it("accepts formatting changes and keeps every substantive change pending", async () => {
    const session = await fixtureSession("tracked.docx");
    const doc = session.requireDocument();
    const substantive = doc.listRevisions().filter((revision) => revision.kind !== "format").map((revision) => revision.id);
    const textBefore = finalText(session);
    const originalBefore = originalText(session);

    const outcome = acceptFormattingChanges(session);

    expect(outcome.ok && outcome.resolvedIds).toHaveLength(2);
    expect(revisionIds(session)).toEqual(substantive);
    // Accepting formatting changes no text in either view.
    expect(finalText(session)).toBe(textBefore);
    expect(originalText(session)).toBe(originalBefore);
    // The new formatting is kept: bold on "net thirty days", centred governing-law paragraph.
    const view = doc.getView();
    const payment = view.body.blocks.find((block) => block.type === "paragraph" && block.text.startsWith("Payment terms"));
    expect(payment?.type === "paragraph" && payment.runs.find((run) => run.text.includes("net thirty days"))?.bold).toBe(true);
    const law = view.body.blocks.find((block) => block.type === "paragraph" && block.text.startsWith("Governing law"));
    expect(law?.type === "paragraph" && law.style.alignment).toBe("center");
    // A second run has nothing left to accept.
    expect(acceptFormattingChanges(session)).toEqual({ ok: false, reason: "nothing" });
    expect(session.undo()).toBe(true);
    expect(revisionIds(session)).toHaveLength(14);
  });
});
