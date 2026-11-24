import { describe, expect, it } from "vitest";
import { askDocument, explainSelection, parseCitations, summariseDocument } from "../../../../home/apps/docs/src/agent/index";
import { MAX_PROMPT_CHARS } from "../../../../home/apps/docs/src/agent/index";
import { contractSession, longParagraphs, scripted, sessionWith } from "./helpers";

describe("docs assistant: answers with citations", () => {
  it("splits an answer into text and citations of known blocks only", () => {
    const valid = new Set(["b12", "b14", "b20"]);
    const { segments, citedBlockIds } = parseCitations("Charges are in clause 5 [b14]. Services [b20, b12]; see also [note] and [b999].", valid);
    expect(segments).toEqual([
      { type: "text", text: "Charges are in clause 5 " },
      { type: "citation", blockId: "b14", number: 1 },
      { type: "text", text: ". Services " },
      { type: "citation", blockId: "b20", number: 2 },
      { type: "citation", blockId: "b12", number: 3 },
      { type: "text", text: "; see also [note] and [b999]." },
    ]);
    expect(citedBlockIds).toEqual(["b14", "b20", "b12"]);
  });

  it("answers a question about contract.docx with clickable citations of shown paragraphs", async () => {
    const { session } = await contractSession();
    const model = scripted("The Customer must pay within 30 days of receipt [b38]. Late payment carries interest [b39] [b404].");
    const result = await askDocument({ session, generate: model.generate }, { question: "When must invoices be paid?" });
    expect(result.status).toBe("answered");
    if (result.status !== "answered") return;
    expect(result.citedBlockIds).toEqual(["b38", "b39"]);
    expect(result.segments.filter((segment) => segment.type === "citation")).toHaveLength(2);
    const prompt = model.prompts[0] as string;
    expect(prompt).toContain("When must invoices be paid?");
    expect(prompt).toContain("cite the paragraph it comes from by its block id");
    expect(prompt).toContain("[b38] 5.2");
    expect(session.requireDocument().listRevisions()).toEqual([]);
  });

  it("explains the selection with the selected text in the prompt, and needs a selection", async () => {
    const { session } = await contractSession();
    const model = scripted("This caps each party's liability at 125% of a year's Charges [b50].");
    const selection = { start: { blockId: "b50", offset: 0 }, end: { blockId: "b50", offset: 40 } };
    const result = await explainSelection({ session, generate: model.generate }, { selection });
    expect(result).toMatchObject({ status: "answered", citedBlockIds: ["b50"] });
    expect(model.prompts[0]).toContain("Explain the selected text in plain language");
    expect(model.prompts[0]).toContain("Source: document (selection)");
    expect(await explainSelection({ session, generate: model.generate }, { selection: null })).toMatchObject({ status: "failed" });
  });

  it("summarises a long document part by part, then combines the parts within the budget", async () => {
    const session = await sessionWith(longParagraphs(40, 12));
    const model = scripted((prompt) => (prompt.includes("# Part answers") ? "Overall: obligations with ten-day deadlines [b2]." : `Part summary [b2]. ${"detail ".repeat(3000)}`));
    const result = await summariseDocument({ session, generate: model.generate });
    expect(model.prompts.length).toBeGreaterThan(2);
    for (const prompt of model.prompts) expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    expect(model.prompts.at(-1)).toContain("# Part answers");
    expect(result).toMatchObject({ status: "answered", text: "Overall: obligations with ten-day deadlines [b2].", citedBlockIds: ["b2"] });
  });

  it("reports a model failure generically", async () => {
    const { session } = await contractSession();
    const model = scripted(new Error("raw provider error"));
    const result = await askDocument({ session, generate: model.generate, log: () => undefined }, { question: "Who are the parties?" });
    expect(result).toEqual({ status: "failed", reason: "unavailable", message: "The assistant is unavailable right now. Try again." });
  });
});
