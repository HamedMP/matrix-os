import { describe, expect, it } from "vitest";
import type { AgentModule, AgentParseResult } from "../../../packages/office/src/api/agent.js";
import * as agent from "../../../packages/office/src/agent/index.js";
import { agentEditInstructions, parseAgentEdits } from "../../../packages/office/src/agent/index.js";

const contract: AgentModule = agent;

const DOCX = { kind: "docx", edits: [{ op: "replaceText", blockId: "b2", find: "30 days", replace: "45 days" }] };
const SHEET = { kind: "sheet", edits: [{ op: "setCell", sheet: "Data", cell: "B7", value: 12.5 }] };

function failure(result: AgentParseResult): { code: string; path: string | null; message: string } {
  if (result.ok) throw new Error("expected a failure");
  return result.error;
}

function parseObject(value: unknown, kind?: "docx" | "sheet"): AgentParseResult {
  return parseAgentEdits(JSON.stringify(value), kind);
}

describe("the agent module", () => {
  it("exports every value of the contract", () => {
    expect(Object.keys(agent.agentModule).sort()).toEqual(
      ["agentEditInstructions", "applySheetEdits", "describeDocx", "describeSheet", "parseAgentEdits", "toDocxOps", "toSheetEdits"].sort(),
    );
    expect(contract.parseAgentEdits).toBe(parseAgentEdits);
  });
});

describe("finding the JSON object in an answer", () => {
  it("reads a bare object", () => {
    expect(parseObject(DOCX)).toEqual({ ok: true, envelope: DOCX });
  });

  it("reads an object in a fenced code block", () => {
    const text = `Here are the edits.\n\n\`\`\`json\n${JSON.stringify(SHEET, null, 2)}\n\`\`\`\nLet me know {if} that works.`;
    expect(parseAgentEdits(text)).toEqual({ ok: true, envelope: SHEET });
  });

  it("skips a fenced block that holds no object", () => {
    const text = `\`\`\`text\nnotes\n\`\`\`\n\`\`\`\n${JSON.stringify(DOCX)}\n\`\`\``;
    expect(parseAgentEdits(text)).toEqual({ ok: true, envelope: DOCX });
  });

  it("takes the first balanced object out of prose", () => {
    const text = `I changed the notice period: ${JSON.stringify(DOCX)} and nothing else. {"kind":"sheet","edits":[]}`;
    expect(parseAgentEdits(text)).toEqual({ ok: true, envelope: DOCX });
  });

  it("does not count braces and quotes inside strings", () => {
    const tricky = { kind: "docx", edits: [{ op: "replaceText", blockId: "b1", find: 'a } "quoted" { b', replace: "\\}" }] };
    expect(parseAgentEdits(`Result: ${JSON.stringify(tricky)} done`)).toEqual({ ok: true, envelope: tricky });
  });

  it("reports text without an object as no_json", () => {
    expect(failure(parseAgentEdits("I could not find anything to change.")).code).toBe("no_json");
    expect(failure(parseAgentEdits("")).code).toBe("no_json");
    expect(failure(parseAgentEdits(42 as unknown as string)).code).toBe("no_json");
  });

  it("reports an unclosed or malformed object as invalid_json without quoting it", () => {
    expect(failure(parseAgentEdits('{"kind":"docx","edits":[')).code).toBe("invalid_json");
    const secret = "the secret clause text";
    const result = failure(parseAgentEdits(`{"kind":"docx","edits":[{"find":"${secret}",}]}`));
    expect(result.code).toBe("invalid_json");
    expect(result.message).not.toContain("secret");
  });

  it("never throws, whatever the text", () => {
    const hostile = ["{", "}", "{}", "[]", "null", '{"__proto__":{"kind":"docx"}}', "{".repeat(5000), `{"a":${"[".repeat(3000)}${"]".repeat(3000)}}`, "```\n{", '"{"'];
    for (const text of hostile) expect(parseAgentEdits(text).ok).toBe(false);
  });
});

describe("the envelope", () => {
  it("needs an object with a known kind and an array of edits", () => {
    expect(failure(parseObject({ edits: [] }))).toMatchObject({ code: "invalid_shape", path: "kind" });
    expect(failure(parseObject({ kind: "pptx", edits: [] }))).toMatchObject({ code: "invalid_shape", path: "kind" });
    expect(failure(parseObject({ kind: "docx" }))).toMatchObject({ code: "invalid_shape", path: "edits" });
    expect(failure(parseObject({ kind: "docx", edits: {} }))).toMatchObject({ code: "invalid_shape", path: "edits" });
  });

  it("accepts an empty list of edits and a summary", () => {
    expect(parseObject({ kind: "sheet", edits: [], summary: "Nothing to change." })).toEqual({
      ok: true,
      envelope: { kind: "sheet", edits: [], summary: "Nothing to change." },
    });
  });

  it("rejects unknown properties at every level", () => {
    expect(failure(parseObject({ ...DOCX, apply: true }))).toMatchObject({ code: "invalid_shape", path: "apply" });
    const edit = { ...DOCX.edits[0], track: false };
    expect(failure(parseObject({ kind: "docx", edits: [edit] }))).toMatchObject({ code: "invalid_shape", path: "edits[0].track" });
    expect(failure(parseAgentEdits('{"kind":"docx","edits":[],"__proto__":{"x":1}}')).code).toBe("invalid_shape");
  });

  it("rejects an envelope of the other kind", () => {
    expect(failure(parseObject(DOCX, "sheet"))).toMatchObject({ code: "wrong_kind", path: "kind" });
    expect(failure(parseObject(SHEET, "docx")).code).toBe("wrong_kind");
    expect(parseObject(SHEET, "sheet").ok).toBe(true);
  });

  it("rejects a document edit inside a sheet envelope and the reverse", () => {
    expect(failure(parseObject({ kind: "sheet", edits: DOCX.edits }))).toMatchObject({ code: "invalid_shape", path: "edits[0].op" });
    expect(failure(parseObject({ kind: "docx", edits: SHEET.edits }))).toMatchObject({ code: "invalid_shape", path: "edits[0].op" });
    expect(failure(parseObject({ kind: "docx", edits: ["replaceText"] }))).toMatchObject({ code: "invalid_shape", path: "edits[0]" });
  });

  it("bounds the text, the number of edits and every string", () => {
    expect(failure(parseAgentEdits(`${JSON.stringify(DOCX)}${" ".repeat(1_048_576)}`)).code).toBe("too_large");
    const many = { kind: "docx", edits: new Array(501).fill(DOCX.edits[0]) };
    expect(failure(parseObject(many))).toMatchObject({ code: "too_large", path: "edits" });
    expect(parseObject({ kind: "docx", edits: new Array(500).fill(DOCX.edits[0]) }).ok).toBe(true);
    const long = { kind: "docx", edits: [{ op: "replaceText", blockId: "b1", find: "x", replace: "y".repeat(20_001) }] };
    expect(failure(parseObject(long))).toMatchObject({ code: "too_large", path: "edits[0].replace" });
    expect(failure(parseObject({ kind: "docx", edits: [], summary: "s".repeat(20_001) }))).toMatchObject({ code: "too_large", path: "summary" });
  });
});

describe("document edits", () => {
  const edit = (fields: Record<string, unknown>): AgentParseResult => parseObject({ kind: "docx", edits: [fields] });

  it("accepts every operation with its optional fields", () => {
    const edits = [
      { op: "replaceText", blockId: "b1", find: "a", replace: "", occurrence: 2 },
      { op: "insertParagraph", blockId: "b1", position: "before", text: "New\ttext\nsecond line", headingLevel: 2 },
      { op: "insertParagraph", blockId: "b1", text: "" },
      { op: "deleteParagraph", blockId: "b1", startsWith: "" },
      { op: "comment", blockId: "b1", find: "", text: "Why?", occurrence: 1 },
    ];
    expect(parseObject({ kind: "docx", edits })).toEqual({ ok: true, envelope: { kind: "docx", edits } });
  });

  it("checks the type and range of every field", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ op: "replaceText", blockId: "b1", find: "", replace: "x" }, "edits[0].find"],
      [{ op: "replaceText", blockId: "b1", find: "x" }, "edits[0].replace"],
      [{ op: "replaceText", blockId: 12, find: "x", replace: "y" }, "edits[0].blockId"],
      [{ op: "replaceText", blockId: "", find: "x", replace: "y" }, "edits[0].blockId"],
      [{ op: "replaceText", blockId: "b 1", find: "x", replace: "y" }, "edits[0].blockId"],
      [{ op: "replaceText", blockId: "b1", find: "x", replace: "y", occurrence: 0 }, "edits[0].occurrence"],
      [{ op: "replaceText", blockId: "b1", find: "x", replace: "y", occurrence: 1.5 }, "edits[0].occurrence"],
      [{ op: "replaceText", blockId: "b1", find: "x", replace: "y", occurrence: "1" }, "edits[0].occurrence"],
      [{ op: "replaceText", blockId: "b1", find: "x", replace: "bell\u0007" }, "edits[0].replace"],
      [{ op: "insertParagraph", blockId: "b1", text: "x", position: "inside" }, "edits[0].position"],
      [{ op: "insertParagraph", blockId: "b1", text: "x", headingLevel: 10 }, "edits[0].headingLevel"],
      [{ op: "insertParagraph", blockId: "b1" }, "edits[0].text"],
      [{ op: "deleteParagraph", blockId: "b1" }, "edits[0].startsWith"],
      [{ op: "comment", blockId: "b1", find: "x", text: "" }, "edits[0].text"],
      [{ op: "format", blockId: "b1" }, "edits[0].op"],
      [{ blockId: "b1" }, "edits[0].op"],
    ];
    for (const [fields, path] of cases) expect(failure(edit(fields))).toMatchObject({ code: "invalid_shape", path });
  });
});

describe("sheet edits", () => {
  const edit = (fields: Record<string, unknown>): AgentParseResult => parseObject({ kind: "sheet", edits: [fields] });

  it("accepts every operation and every kind of value", () => {
    const edits = [
      { op: "setCell", sheet: "Data", cell: "B7", value: "=SUM(B1:B6)", expect: "" },
      { op: "setCell", sheet: "Data", cell: "$AA$10", value: null },
      { op: "setCell", sheet: "Data", cell: "c3", value: true },
      { op: "setRange", sheet: "Data", start: "A2", values: [["North", 1200, false], [], [null]] },
      { op: "clearRange", sheet: "Data", range: "A2:C9" },
      { op: "clearRange", sheet: "Data", range: "B:D" },
      { op: "clearRange", sheet: "Data", range: "2:5" },
      { op: "clearRange", sheet: "Data", range: "F4" },
    ];
    expect(parseObject({ kind: "sheet", edits })).toEqual({ ok: true, envelope: { kind: "sheet", edits } });
  });

  it("checks addresses, values and names", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ op: "setCell", sheet: "Data", cell: "7B", value: 1 }, "edits[0].cell"],
      [{ op: "setCell", sheet: "Data", cell: "A0", value: 1 }, "edits[0].cell"],
      [{ op: "setCell", sheet: "Data", cell: "A1:B2", value: 1 }, "edits[0].cell"],
      [{ op: "setCell", sheet: "Data", cell: "Sheet2!A1", value: 1 }, "edits[0].cell"],
      [{ op: "setCell", sheet: "", cell: "A1", value: 1 }, "edits[0].sheet"],
      [{ op: "setCell", sheet: "Data", cell: "A1" }, "edits[0].value"],
      [{ op: "setCell", sheet: "Data", cell: "A1", value: { formula: "A2" } }, "edits[0].value"],
      [{ op: "setCell", sheet: "Data", cell: "A1", value: [1] }, "edits[0].value"],
      [{ op: "setCell", sheet: "Data", cell: "A1", value: 1, expect: 1 }, "edits[0].expect"],
      [{ op: "setRange", sheet: "Data", start: "A1", values: [] }, "edits[0].values"],
      [{ op: "setRange", sheet: "Data", start: "A1", values: [[]] }, "edits[0].values"],
      [{ op: "setRange", sheet: "Data", start: "A1", values: [1, 2] }, "edits[0].values[0]"],
      [{ op: "setRange", sheet: "Data", start: "A1", values: [[1, {}]] }, "edits[0].values[0][1]"],
      [{ op: "clearRange", sheet: "Data", range: "A1:B2:C3" }, "edits[0].range"],
      [{ op: "clearRange", sheet: "Data", range: "everything" }, "edits[0].range"],
      [{ op: "deleteRows", sheet: "Data", index: 1 }, "edits[0].op"],
    ];
    for (const [fields, path] of cases) expect(failure(edit(fields))).toMatchObject({ code: "invalid_shape", path });
  });

  it("rejects a number JSON cannot hold", () => {
    expect(failure(parseAgentEdits('{"kind":"sheet","edits":[{"op":"setCell","sheet":"Data","cell":"A1","value":1e999}]}'))).toMatchObject({
      code: "invalid_shape",
      path: "edits[0].value",
    });
  });

  it("bounds the cells of one setRange", () => {
    const row = new Array(101).fill(1);
    const values = new Array(100).fill(row);
    expect(failure(edit({ op: "setRange", sheet: "Data", start: "A1", values }))).toMatchObject({ code: "too_large", path: "edits[0].values" });
    expect(edit({ op: "setRange", sheet: "Data", start: "A1", values: new Array(100).fill(new Array(100).fill(1)) }).ok).toBe(true);
  });
});

describe("the instructions for a prompt", () => {
  it("describe every operation of the kind, and only that kind", () => {
    const docx = agentEditInstructions("docx");
    for (const op of ["replaceText", "insertParagraph", "deleteParagraph", "comment"]) expect(docx).toContain(`"op":"${op}"`);
    expect(docx).not.toContain("setCell");
    const sheet = agentEditInstructions("sheet");
    for (const op of ["setCell", "setRange", "clearRange"]) expect(sheet).toContain(`"op":"${op}"`);
    expect(sheet).not.toContain("replaceText");
  });

  it("contain an example that the parser accepts", () => {
    for (const kind of ["docx", "sheet"] as const) {
      const example = agentEditInstructions(kind).split("\n").at(-1) ?? "";
      const parsed = parseAgentEdits(example, kind);
      expect(parsed.ok).toBe(true);
    }
  });

  it("refuse an unknown kind", () => {
    expect(() => agentEditInstructions("pptx" as "docx")).toThrow();
  });
});
