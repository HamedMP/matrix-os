import { describe, expect, it } from "vitest";
import { diffWords } from "../../../packages/office/src/redline/index.js";
import { brief, expectValidDiff } from "./helpers.js";

const S1 = "The supplier shall deliver the goods on time.";
const S2 = "The buyer pays within thirty days of delivery.";
const S3 = "Either party may end this agreement by written notice.";
const S4 = "This agreement is governed by Swiss law.";

describe("diffWords: moves", () => {
  it("reports a relocated sentence as a move, not a deletion and an insertion", () => {
    const a = `${S1} ${S2} ${S3} ${S4}`;
    const b = `${S2} ${S3} ${S1} ${S4}`;
    const ops = diffWords(a, b);
    expectValidDiff(a, b, ops);
    const from = ops.filter((op) => op.type === "moveFrom");
    const to = ops.filter((op) => op.type === "moveTo");
    expect(from).toHaveLength(1);
    expect(to).toHaveLength(1);
    expect(from[0]?.text.trim()).toBe(S1);
    expect(from[0]?.moveId).toBe("m1");
    expect(to[0]?.moveId).toBe("m1");
    expect(to[0]?.text).toBe(from[0]?.text);
    const changed = ops.filter((op) => op.type === "delete" || op.type === "insert").map((op) => op.text.trim());
    expect(changed.join("")).toBe("");
  });

  it("gives each move its own id, numbered by where the text left", () => {
    const a = `${S1}\n${S2}\n${S3}\n${S4}\nEnd.`;
    const b = `${S2}\n${S1}\n${S4}\n${S3}\nEnd.`;
    const ops = diffWords(a, b);
    expectValidDiff(a, b, ops);
    const from = ops.filter((op) => op.type === "moveFrom");
    expect(from.map((op) => op.moveId)).toEqual(["m1", "m2"]);
    expect(new Set(ops.filter((op) => op.type === "moveTo").map((op) => op.moveId))).toEqual(new Set(["m1", "m2"]));
  });

  it("finds a moved sentence inside a larger rewrite", () => {
    const a = `Opening words here. ${S2} Some filler text follows now. ${S4}`;
    const b = `Opening words here. Entirely new material appears instead. ${S4} ${S2}`;
    const ops = diffWords(a, b);
    expectValidDiff(a, b, ops);
    const moved = ops.find((op) => op.type === "moveFrom");
    expect(moved?.text.trim() === S2 || moved?.text.trim() === S4).toBe(true);
  });

  it("does not call a short relocated phrase a move", () => {
    const a = "red big house on the hill";
    const b = "big red house on the hill";
    const ops = diffWords(a, b);
    expectValidDiff(a, b, ops);
    expect(ops.some((op) => op.type === "moveFrom" || op.type === "moveTo")).toBe(false);
  });

  it("honours minMoveTokens", () => {
    const a = "alpha beta gamma. one two three four five six seven eight nine ten.";
    const b = "one two three four five six seven eight nine ten. alpha beta gamma.";
    const strict = diffWords(a, b, { minMoveTokens: 20 });
    expectValidDiff(a, b, strict);
    expect(strict.some((op) => op.type === "moveFrom")).toBe(false);
    const loose = diffWords(a, b, { minMoveTokens: 2 });
    expectValidDiff(a, b, loose);
    expect(loose.some((op) => op.type === "moveFrom")).toBe(true);
  });

  it("reports no moves when detectMoves is false", () => {
    const a = `${S1} ${S2} ${S3}`;
    const b = `${S3} ${S1} ${S2}`;
    const ops = diffWords(a, b, { detectMoves: false });
    expectValidDiff(a, b, ops);
    expect(ops.every((op) => op.moveId === null)).toBe(true);
  });

  it("does not report unchanged text as moved when a rewrite surrounds it", () => {
    const a = "We completely rewrote the first part of it, and then this stays, and the last part was also rewritten here.";
    const b = "Our team fully revised the opening section of it, and then this stays, and the closing section got changed too.";
    const ops = diffWords(a, b);
    expectValidDiff(a, b, ops);
    expect(ops.some((op) => op.type === "moveFrom")).toBe(false);
  });

  it("does not invent moves when the token budget left the middle unaligned", () => {
    const a = `start ${"same words again and again ".repeat(30)}end one`;
    const b = `begin ${"same words again and again ".repeat(30)}end two`;
    const ops = diffWords(a, b, { maxTokens: 5 });
    expectValidDiff(a, b, ops);
    expect(ops.some((op) => op.type === "moveFrom")).toBe(false);
  });

  it("detects a moved paragraph in a long document", () => {
    const paragraphs = Array.from({ length: 200 }, (_, i) => `Clause ${i}: the parties agree on item number ${i} as set out in schedule ${i % 7}.`);
    const revised = [...paragraphs];
    const [moved] = revised.splice(20, 1);
    revised.splice(150, 0, moved as string);
    const a = paragraphs.join("\n");
    const b = revised.join("\n");
    const ops = diffWords(a, b);
    expectValidDiff(a, b, ops);
    expect(brief(ops).filter((line) => line.startsWith("<"))).toEqual([`<${paragraphs[20]}\n`]);
    expect(ops.filter((op) => op.type === "delete" || op.type === "insert")).toEqual([]);
  });
});
