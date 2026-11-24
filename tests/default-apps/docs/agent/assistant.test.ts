import { describe, expect, it } from "vitest";
import { ASSISTANT_AUTHOR, runAssistantEdit } from "../../../../home/apps/docs/src/agent/index";
import { openDocx } from "../../../../home/apps/_shared/office-engine/index";
import { contractSession, envelope, finalText, longParagraphs, scripted, sessionWith, shownIds } from "./helpers";

describe("docs assistant: edits as tracked changes", () => {
  it("applies the agent's edits to contract.docx as revisions by Matrix Assistant, in one undo step", async () => {
    const { session } = await contractSession();
    const doc = session.requireDocument();
    const before = finalText(doc);
    const model = scripted(
      envelope(
        [
          { op: "replaceText", blockId: "b38", find: "within 30 days of receipt", replace: "within 45 days of receipt" },
          { op: "insertParagraph", blockId: "b40", text: "5.5\tAll amounts are stated in pounds sterling." },
          { op: "comment", blockId: "b37", find: "£18,500", text: "Confirm the fee with finance." },
        ],
        "Extends the payment term and adds a currency clause.",
      ),
    );
    const result = await runAssistantEdit({ session, generate: model.generate }, { instruction: "Give the customer 45 days to pay and state the currency." });
    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    expect(result.summary).toBe("Extends the payment term and adds a currency clause.");
    expect(result.dropped).toEqual([]);

    const revisions = doc.listRevisions();
    expect(revisions.length).toBeGreaterThanOrEqual(3);
    expect(new Set(revisions.map((revision) => revision.author))).toEqual(new Set([ASSISTANT_AUTHOR]));
    expect(result.revisionIds.sort()).toEqual(revisions.map((revision) => revision.id).sort());
    expect(finalText(doc)).toContain("within 45 days of receipt");
    expect(finalText(doc)).toContain("5.5\tAll amounts are stated in pounds sterling.");
    expect(doc.getPlainText({ view: "original" })).toBe(before);

    // The summary: a replacement and an insertion, with blocks to jump to.
    expect(result.changes.map((change) => [change.kind, change.blockId])).toEqual([
      ["replace", "b38"],
      ["insert", expect.any(String)],
    ]);
    expect(result.changes[0]).toMatchObject({ before: "30", after: "45" });
    expect(result.comments).toEqual([expect.objectContaining({ blockId: "b37", anchorText: "£18,500", text: "Confirm the fee with finance." })]);
    expect(doc.listComments()[0]?.author).toBe(ASSISTANT_AUTHOR);

    // Rejecting everything restores the original text; one undo removes all of it.
    expect(session.undo()).toBe(true);
    expect(doc.listRevisions()).toEqual([]);
    expect(doc.listComments()).toEqual([]);
    expect(finalText(doc)).toBe(before);
  });

  it("survives save and reopen with the revisions intact", async () => {
    const { session, files } = await contractSession();
    const model = scripted(envelope([{ op: "replaceText", blockId: "b25", find: "24 months", replace: "36 months" }]));
    await runAssistantEdit({ session, generate: model.generate }, { instruction: "Make the initial term 36 months." });
    await session.save();
    const reopened = await openDocx(files.bytes("Documents/contract.docx")!);
    expect(reopened.listRevisions().map((revision) => [revision.kind, revision.text, revision.author])).toEqual([
      ["delete", "24", ASSISTANT_AUTHOR],
      ["insert", "36", ASSISTANT_AUTHOR],
    ]);
  });

  it("applies nothing when the answer cannot be read, after exactly one retry", async () => {
    const { session } = await contractSession();
    const model = scripted("Sure! I changed the term for you.", "```json\n{\"kind\":\"docx\",\"edits\":[{\"op\":\"rewrite\"}]}\n```");
    const result = await runAssistantEdit({ session, generate: model.generate }, { instruction: "Make the initial term 36 months." });
    expect(result).toMatchObject({ status: "invalid_reply", chunk: 1 });
    expect(model.prompts).toHaveLength(2);
    expect(model.prompts[1]).toContain("# Problems with your previous answer");
    expect(model.prompts[1]).toContain("The answer could not be read");
    const doc = session.requireDocument();
    expect(doc.listRevisions()).toEqual([]);
    expect(session.getState()).toMatchObject({ dirty: false, canUndo: false });
  });

  it("feeds validation errors back once and applies the corrected answer", async () => {
    const { session } = await contractSession();
    const model = scripted(
      envelope([{ op: "replaceText", blockId: "b25", find: "an initial period of two years", replace: "an initial period of three years" }]),
      envelope([{ op: "replaceText", blockId: "b25", find: "24 months", replace: "36 months" }]),
    );
    const result = await runAssistantEdit({ session, generate: model.generate }, { instruction: "Make the initial term 36 months." });
    expect(model.prompts).toHaveLength(2);
    expect(model.prompts[1]).toContain('edits[0]: the quoted "find" text is not in block b25');
    expect(result).toMatchObject({ status: "applied", dropped: [] });
    expect(finalText(session.requireDocument())).toContain("initial period of 36 months");
  });

  it("applies the valid edits and reports the dropped one when the retry still has a bad edit", async () => {
    const { session } = await contractSession();
    const bad = { op: "replaceText", blockId: "b25", find: "a term that does not exist", replace: "x" };
    const good = { op: "replaceText", blockId: "b26", find: "90 days’ written notice", replace: "60 days’ written notice" };
    const model = scripted(envelope([bad, good]), envelope([bad, good]));
    const result = await runAssistantEdit({ session, generate: model.generate }, { instruction: "Shorten the renewal notice to 60 days." });
    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    expect(result.dropped).toEqual([expect.objectContaining({ index: 0, code: "stale_reference", blockId: "b25" })]);
    expect(finalText(session.requireDocument())).toContain("at least 60 days’ written notice");
  });

  it("keeps the first answer's valid edits when the retry is unreadable", async () => {
    const { session } = await contractSession();
    const model = scripted(
      envelope([
        { op: "replaceText", blockId: "b26", find: "12 months", replace: "6 months" },
        { op: "replaceText", blockId: "b26", find: "nothing like this", replace: "x" },
      ]),
      "not json at all",
    );
    const result = await runAssistantEdit({ session, generate: model.generate }, { instruction: "Renew for 6 months." });
    expect(result).toMatchObject({ status: "applied" });
    expect(finalText(session.requireDocument())).toContain("successive periods of 6 months");
  });

  it("in a long document applies nothing when one part's answer cannot be read, though other parts were fine", async () => {
    const session = await sessionWith(longParagraphs(40, 12));
    const model = scripted((prompt) => {
      if (prompt.includes("# Part 2 of")) return "I could not do that part.";
      const first = shownIds(prompt.slice(prompt.indexOf("# Part"))).find((id) => /^b/.test(id)) as string;
      return envelope([{ op: "comment", blockId: first, find: "", text: "Looks fine." }]);
    });
    const result = await runAssistantEdit({ session, generate: model.generate }, { instruction: "Proofread.", scope: "document" });
    expect(result).toMatchObject({ status: "invalid_reply", chunk: 2 });
    expect(session.requireDocument().listComments()).toEqual([]);
    expect(session.requireDocument().listRevisions()).toEqual([]);
  });

  it("in a long document applies the edits of every part together, in one undo step", async () => {
    const session = await sessionWith(longParagraphs(40, 12));
    const model = scripted((prompt) => {
      const ids = shownIds(prompt.slice(prompt.indexOf("# Part")));
      // The second line of each part is a numbered paragraph with "ten Business Days".
      return envelope([{ op: "replaceText", blockId: ids[1] as string, find: "ten Business Days", replace: "five Business Days" }]);
    });
    const result = await runAssistantEdit({ session, generate: model.generate }, { instruction: "Shorten the deadlines.", scope: "document" });
    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    expect(result.chunks).toBe(model.prompts.length);
    expect(result.changes).toHaveLength(model.prompts.length);
    const changed = finalText(session.requireDocument()).match(/five Business Days/g) ?? [];
    expect(changed).toHaveLength(model.prompts.length);
    session.undo();
    expect(finalText(session.requireDocument())).not.toContain("five Business Days");
  });

  it("comment-only review adds comments and changes no text", async () => {
    const { session } = await contractSession();
    const doc = session.requireDocument();
    const before = finalText(doc);
    const model = scripted(
      envelope([
        { op: "comment", blockId: "b38", find: "within 30 days of receipt", text: "The instructions require 45-day payment terms." },
        { op: "replaceText", blockId: "b38", find: "30 days", replace: "45 days" },
      ]),
      envelope([{ op: "comment", blockId: "b38", find: "within 30 days of receipt", text: "The instructions require 45-day payment terms." }]),
    );
    const result = await runAssistantEdit({ session, generate: model.generate }, { instruction: "Payment terms must be 45 days.", mode: "comment" });
    expect(model.prompts[0]).toContain('Use only "comment" edits');
    expect(result).toMatchObject({ status: "applied", revisionIds: [] });
    expect(doc.listRevisions()).toEqual([]);
    expect(finalText(doc)).toBe(before);
    expect(doc.listComments().map((comment) => [comment.author, comment.anchorText])).toEqual([[ASSISTANT_AUTHOR, "within 30 days of receipt"]]);
  });

  it("reports a model failure generically and applies nothing", async () => {
    const { session } = await contractSession();
    const logged: unknown[] = [];
    const model = scripted(new Error("upstream provider exploded: secret detail"));
    const result = await runAssistantEdit({ session, generate: model.generate, log: (_m, e) => logged.push(e) }, { instruction: "Proofread." });
    expect(result).toEqual({ status: "failed", reason: "unavailable", message: "The assistant is unavailable right now. Try again." });
    expect(logged).toHaveLength(1);
    expect(session.requireDocument().listRevisions()).toEqual([]);
  });

  it("applies nothing when another document was opened while the model worked", async () => {
    const { session } = await contractSession();
    const model = {
      async generate() {
        await session.createNew({ discardChanges: true });
        return { text: envelope([{ op: "replaceText", blockId: "b25", find: "24 months", replace: "36 months" }]) };
      },
    };
    const result = await runAssistantEdit({ session, generate: model.generate }, { instruction: "Make the term 36 months." });
    expect(result).toMatchObject({ status: "failed", reason: "document_changed" });
    expect(session.requireDocument().listRevisions()).toEqual([]);
  });

  it("stops when cancelled", async () => {
    const { session } = await contractSession();
    const controller = new AbortController();
    const model = {
      async generate() {
        controller.abort();
        return { text: envelope([{ op: "replaceText", blockId: "b25", find: "24 months", replace: "36 months" }]) };
      },
    };
    const result = await runAssistantEdit({ session, generate: model.generate }, { instruction: "Make the term 36 months.", signal: controller.signal });
    expect(result).toEqual({ status: "cancelled" });
    expect(session.requireDocument().listRevisions()).toEqual([]);
  });

  it("returns no_changes for an empty edit list and needs a document and an instruction", async () => {
    const { session } = await contractSession();
    const model = scripted(envelope([], "Nothing to change."));
    expect(await runAssistantEdit({ session, generate: model.generate }, { instruction: "Proofread." })).toMatchObject({ status: "no_changes", summary: "Nothing to change." });
    expect(await runAssistantEdit({ session, generate: model.generate }, { instruction: "  " })).toMatchObject({ status: "failed", reason: "empty_instruction" });
    await session.close({ discardChanges: true });
    expect(await runAssistantEdit({ session, generate: model.generate }, { instruction: "Proofread." })).toMatchObject({ status: "failed", reason: "no_document" });
  });
});
