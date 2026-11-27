import { describe, expect, it } from "vitest";
import { readDocument, validateEdits } from "../../../../home/apps/docs/src/agent/index";
import type { AgentDocxEdit } from "../../../../home/apps/_shared/office-engine/index";
import { contractSession } from "./helpers";

async function contract() {
  const { session } = await contractSession();
  const doc = session.requireDocument();
  const text = readDocument(doc);
  const all = new Set(text.blocks.map((block) => block.id));
  const run = (edits: AgentDocxEdit[], options: { scope?: Set<string>; mode?: "edit" | "comment" } = {}) =>
    validateEdits({ doc, text, edits, scope: options.scope ?? all, mode: options.mode ?? "edit", chunk: 1 });
  return { session, doc, run };
}

describe("docs assistant: edit validation", () => {
  it("keeps an edit whose quote is in its block", async () => {
    const { run } = await contract();
    const result = run([{ op: "replaceText", blockId: "b38", find: "30 days", replace: "45 days" }]);
    expect(result.dropped).toEqual([]);
    expect(result.relocated).toEqual([]);
    expect(result.edits).toEqual([{ op: "replaceText", blockId: "b38", find: "30 days", replace: "45 days" }]);
  });

  it("relocates a quote the agent put on the wrong paragraph of the same clause", async () => {
    const { run } = await contract();
    // "4% a year" is in 5.3 (b39), not 5.2 (b38).
    const result = run([{ op: "replaceText", blockId: "b38", find: "4% a year", replace: "3% a year" }]);
    expect(result.dropped).toEqual([]);
    expect(result.edits[0]).toMatchObject({ blockId: "b39", find: "4% a year" });
    expect(result.relocated).toEqual([{ chunk: 1, index: 0, fromBlockId: "b38", toBlockId: "b39", how: "exact" }]);
  });

  it("relocates a quote with straight quotes and other case to the exact text", async () => {
    const { run } = await contract();
    // The document has a curly apostrophe: "Customer’s reasonable security policies".
    const result = run([{ op: "replaceText", blockId: "b30", find: "customer's Reasonable security policies", replace: "Customer's security policies" }]);
    expect(result.dropped).toEqual([]);
    expect(result.edits[0]).toMatchObject({ blockId: "b30", find: "Customer’s reasonable security policies" });
    expect(result.relocated[0]).toMatchObject({ how: "normalised", toBlockId: "b30" });
  });

  it("relocates a quote with a small typo by fuzzy search", async () => {
    const { run } = await contract();
    const result = run([{ op: "replaceText", blockId: "b53", find: "profesional indemnity insurence of at least", replace: "professional indemnity insurance of not less than" }]);
    expect(result.dropped).toEqual([]);
    expect(result.edits[0]).toMatchObject({ blockId: "b53", find: "professional indemnity insurance of at least" });
    expect(result.relocated[0]).toMatchObject({ how: "fuzzy" });
  });

  it("drops a quote that is only in another clause, and an unknown block", async () => {
    const { run } = await contract();
    const result = run([
      // "Bank of England" is in clause 5, not in clause 7.
      { op: "replaceText", blockId: "b45", find: "Bank of England base rate", replace: "base rate" },
      { op: "comment", blockId: "b9999", find: "x", text: "?" },
      { op: "replaceText", blockId: "b45", find: "confidential", replace: "secret", occurrence: 1 },
    ]);
    expect(result.dropped.map((entry) => [entry.index, entry.code])).toEqual([
      [0, "stale_reference"],
      [1, "not_found"],
    ]);
    expect(result.edits).toHaveLength(1);
    expect(result.indexes).toEqual([2]);
  });

  it("drops edits to blocks the agent was not shown", async () => {
    const { run } = await contract();
    const result = run([{ op: "replaceText", blockId: "b38", find: "30 days", replace: "45 days" }], { scope: new Set(["b37"]) });
    expect(result.dropped[0]).toMatchObject({ code: "out_of_scope", blockId: "b38" });
    expect(result.edits).toEqual([]);
  });

  it("never relocates an edit to a paragraph of the clause the agent was not shown", async () => {
    const { run } = await contract();
    // "4% a year" is only in 5.3 (b39); the agent was shown 5.2 (b38) alone.
    const scope = new Set(["b38"]);
    const result = run(
      [
        { op: "replaceText", blockId: "b38", find: "4% a year", replace: "3% a year" },
        { op: "comment", blockId: "b38", find: "4% a year", text: "Too high?" },
        { op: "deleteParagraph", blockId: "b38", startsWith: "5.3" },
      ],
      { scope },
    );
    expect(result.edits).toEqual([]);
    expect(result.relocated).toEqual([]);
    expect(result.dropped.map((entry) => [entry.index, entry.code])).toEqual([
      [0, "stale_reference"],
      [1, "stale_reference"],
      [2, "stale_reference"],
    ]);
  });

  it("checks each edit against the blocks of its own part", async () => {
    const { doc } = await contract();
    const text = readDocument(doc);
    const scopes = [new Set(["b38"]), new Set(["b39"])];
    const result = validateEdits({
      doc,
      text,
      edits: [
        { op: "replaceText", blockId: "b38", find: "4% a year", replace: "3% a year" },
        { op: "replaceText", blockId: "b39", find: "4% a year", replace: "3% a year" },
      ],
      scope: (index) => scopes[index] as Set<string>,
      mode: "edit",
      chunk: 0,
    });
    expect(result.indexes).toEqual([1]);
    expect(result.dropped.map((entry) => [entry.index, entry.code])).toEqual([[0, "stale_reference"]]);
  });

  it("allows only comments in comment-only review", async () => {
    const { run } = await contract();
    const result = run(
      [
        { op: "replaceText", blockId: "b38", find: "30 days", replace: "45 days" },
        { op: "comment", blockId: "b38", find: "30 days", text: "The instructions ask for 45 days." },
        { op: "deleteParagraph", blockId: "b39", startsWith: "5.3" },
      ],
      { mode: "comment" },
    );
    expect(result.dropped.map((entry) => entry.code)).toEqual(["not_allowed", "not_allowed"]);
    expect(result.edits).toEqual([{ op: "comment", blockId: "b38", find: "30 days", text: "The instructions ask for 45 days." }]);
  });

  it("relocates a paragraph deletion by the start of its text within the clause", async () => {
    const { run } = await contract();
    const result = run([{ op: "deleteParagraph", blockId: "b39", startsWith: "5.4 The Supplier may increase" }]);
    expect(result.dropped).toEqual([]);
    expect(result.edits[0]).toMatchObject({ op: "deleteParagraph", blockId: "b40" });
    expect((result.edits[0] as { startsWith: string }).startsWith).toHaveLength(40);
  });

  it("reports what the engine refuses, such as an ambiguous quote", async () => {
    const { run } = await contract();
    // "Charges" occurs twice in 4.2 (b34).
    const result = run([{ op: "replaceText", blockId: "b34", find: "monthly Charges", replace: "monthly fees" }]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]).toMatchObject({ code: "ambiguous", index: 0 });
    expect(result.edits).toEqual([]);
  });

  it("checks against the live document: text the owner changed is relocated or dropped", async () => {
    const { session, run } = await contract();
    const paragraph = session.requireDocument().getBlock("b38") as { text: string };
    const whole = { start: { blockId: "b38", offset: 0 }, end: { blockId: "b38", offset: paragraph.text.length } };
    session.apply([{ type: "replaceRange", range: whole, text: "5.2\tInvoices are due on receipt." }], { track: false });
    const result = run([{ op: "replaceText", blockId: "b38", find: "within 30 days of receipt", replace: "within 45 days of receipt" }]);
    expect(result.dropped[0]).toMatchObject({ code: "stale_reference" });
  });
});
