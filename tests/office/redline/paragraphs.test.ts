import { describe, expect, it } from "vitest";
import { diffParagraphs, type ParagraphDiffOp } from "../../../packages/office/src/redline/index.js";
import { mutate, randomText, rng } from "./helpers.js";

const P = [
  "This Agreement is made between the Supplier and the Customer on the Effective Date.",
  "The Supplier shall deliver the Goods to the Customer at the agreed delivery address.",
  "The Customer shall pay each invoice within thirty days of the date of the invoice.",
  "Either party may terminate this Agreement by giving ninety days written notice.",
  "This Agreement is governed by the laws of Switzerland and the courts of Zurich.",
  "Confidential Information must not be disclosed to any third party without consent.",
];

/** Checks that the ops cover both sides in order and that moves pair up. */
function expectValid(a: readonly string[], b: readonly string[], ops: readonly ParagraphDiffOp[]): void {
  let aPos = 0;
  let bPos = 0;
  const from = new Map<string, ParagraphDiffOp>();
  const to = new Map<string, ParagraphDiffOp>();
  for (const op of ops) {
    expect(op.aStart).toBe(aPos);
    expect(op.bStart).toBe(bPos);
    const aLen = op.aEnd - op.aStart;
    const bLen = op.bEnd - op.bStart;
    expect(aLen + bLen).toBeGreaterThan(0);
    expect(op.similarity).toBeGreaterThanOrEqual(0);
    expect(op.similarity).toBeLessThanOrEqual(1);
    switch (op.type) {
      case "equal":
        expect(a.slice(op.aStart, op.aEnd)).toEqual(b.slice(op.bStart, op.bEnd));
        break;
      case "modify":
        expect([aLen, bLen]).toEqual([1, 1]);
        expect(a[op.aStart]).not.toBe(b[op.bStart]);
        break;
      case "split":
        expect(aLen).toBe(1);
        expect(bLen).toBeGreaterThan(1);
        break;
      case "merge":
        expect(aLen).toBeGreaterThan(1);
        expect(bLen).toBe(1);
        break;
      case "delete":
      case "moveFrom":
        expect(bLen).toBe(0);
        break;
      case "insert":
      case "moveTo":
        expect(aLen).toBe(0);
        break;
    }
    if (op.type === "moveFrom") from.set(op.moveId as string, op);
    else if (op.type === "moveTo") to.set(op.moveId as string, op);
    else {
      expect(op.moveId).toBeNull();
      expect(op.peer).toBeNull();
    }
    aPos = op.aEnd;
    bPos = op.bEnd;
  }
  expect(aPos).toBe(a.length);
  expect(bPos).toBe(b.length);
  expect([...from.keys()].sort()).toEqual([...to.keys()].sort());
  for (const [id, source] of from) {
    const target = to.get(id) as ParagraphDiffOp;
    expect(source.peer).toEqual({ start: target.bStart, end: target.bEnd });
    expect(target.peer).toEqual({ start: source.aStart, end: source.aEnd });
    expect(source.aEnd - source.aStart).toBe(target.bEnd - target.bStart);
  }
}

const types = (ops: readonly ParagraphDiffOp[]): string[] => ops.map((op) => op.type);

describe("diffParagraphs", () => {
  it("returns nothing for two empty documents and one op for identical ones", () => {
    expect(diffParagraphs([], [])).toEqual([]);
    expect(diffParagraphs(P, P)).toEqual([
      { type: "equal", aStart: 0, aEnd: 6, bStart: 0, bEnd: 6, moveId: null, similarity: 1, peer: null },
    ]);
  });

  it("aligns identical paragraphs and reports insertions and deletions between them", () => {
    const a = [P[0], P[1], P[2], P[3]] as string[];
    const b = [P[0], P[2], P[5], P[3]] as string[];
    const ops = diffParagraphs(a, b);
    expectValid(a, b, ops);
    expect(types(ops)).toEqual(["equal", "delete", "equal", "insert", "equal"]);
  });

  it("pairs an edited paragraph with its original by token overlap", () => {
    const edited = (P[2] as string).replace("thirty", "sixty").replace("invoice.", "invoice, without set-off.");
    const a = [P[0], P[1], P[2], P[3]] as string[];
    const b = [P[0], P[1], edited, P[3]] as string[];
    const ops = diffParagraphs(a, b);
    expectValid(a, b, ops);
    expect(types(ops)).toEqual(["equal", "modify", "equal"]);
    expect(ops[1]).toMatchObject({ aStart: 2, aEnd: 3, bStart: 2, bEnd: 3 });
    expect(ops[1]?.similarity).toBeGreaterThan(0.6);
    expect(ops[1]?.similarity).toBeLessThan(1);
  });

  it("does not pair unrelated paragraphs", () => {
    const a = [P[0], P[1], P[3]] as string[];
    const b = [P[0], P[5], P[3]] as string[];
    const ops = diffParagraphs(a, b);
    expectValid(a, b, ops);
    expect(types(ops)).toEqual(["equal", "delete", "insert", "equal"]);
  });

  it("picks the best match when several edited paragraphs sit together", () => {
    const a = [P[1], P[2], P[3]] as string[];
    const b = [`${P[1]} Risk passes on delivery.`, "A brand new paragraph about insurance cover and limits.", `${P[2]} Late payment bears interest.`, P[3]] as string[];
    const ops = diffParagraphs(a, b);
    expectValid(a, b, ops);
    expect(types(ops)).toEqual(["modify", "insert", "modify", "equal"]);
  });

  it("detects a paragraph split in two", () => {
    const first = "The Supplier shall deliver the Goods to the Customer at the agreed delivery address.";
    const second = "Risk in the Goods passes to the Customer when they are handed over.";
    const a = [P[0], `${first} ${second}`, P[3]] as string[];
    const b = [P[0], first, second, P[3]] as string[];
    const ops = diffParagraphs(a, b);
    expectValid(a, b, ops);
    expect(types(ops)).toEqual(["equal", "split", "equal"]);
    expect(ops[1]).toMatchObject({ aStart: 1, aEnd: 2, bStart: 1, bEnd: 3 });
  });

  it("detects two paragraphs merged into one, with a small edit", () => {
    const a = [P[0], P[1], P[2], P[3]] as string[];
    const b = [P[0], `${P[1]} In addition, ${(P[2] as string).toLowerCase()}`, P[3]] as string[];
    const ops = diffParagraphs(a, b);
    expectValid(a, b, ops);
    expect(types(ops)).toEqual(["equal", "merge", "equal"]);
    expect(ops[1]).toMatchObject({ aStart: 1, aEnd: 3, bStart: 1, bEnd: 2 });
  });

  it("does not report a split when the neighbour is new text", () => {
    const a = [P[0], P[1], P[3]] as string[];
    const b = [P[0], P[1], P[5], P[3]] as string[];
    const ops = diffParagraphs(a, b);
    expectValid(a, b, ops);
    expect(types(ops)).toEqual(["equal", "insert", "equal"]);
  });

  it("reports a relocated paragraph as a move", () => {
    const a = [P[0], P[1], P[2], P[3], P[4]] as string[];
    const b = [P[0], P[2], P[3], P[1], P[4]] as string[];
    const ops = diffParagraphs(a, b);
    expectValid(a, b, ops);
    expect(types(ops)).toEqual(["equal", "moveFrom", "equal", "moveTo", "equal"]);
    expect(ops[1]?.moveId).toBe(ops[3]?.moveId);
    expect(ops[1]?.similarity).toBe(1);
  });

  it("reports a relocated and edited paragraph as a move with its similarity", () => {
    const edited = (P[1] as string).replace("agreed delivery address", "address stated in the order");
    const a = [P[0], P[1], P[2], P[3], P[4]] as string[];
    const b = [P[0], P[2], P[3], P[4], edited] as string[];
    const ops = diffParagraphs(a, b);
    expectValid(a, b, ops);
    const move = ops.find((op) => op.type === "moveFrom");
    expect(move).toMatchObject({ aStart: 1, aEnd: 2, peer: { start: 4, end: 5 } });
    expect(move?.similarity).toBeGreaterThan(0.6);
    expect(move?.similarity).toBeLessThan(1);
  });

  it("moves a block of neighbouring paragraphs as one move, short heading included", () => {
    const a = ["Delivery", P[1], P[0], P[2], P[3], P[4]] as string[];
    const b = [P[0], P[2], P[3], "Delivery", P[1], P[4]] as string[];
    const ops = diffParagraphs(a, b);
    expectValid(a, b, ops);
    const move = ops.find((op) => op.type === "moveFrom");
    expect(move).toMatchObject({ aStart: 0, aEnd: 2, peer: { start: 3, end: 5 } });
    expect(ops.filter((op) => op.type === "moveFrom")).toHaveLength(1);
  });

  it("does not treat a relocated blank or one-word paragraph as a move on its own", () => {
    const a = ["", P[0], "Yes", P[1], P[2]] as string[];
    const b = [P[0], "", P[1], P[2], "Yes"] as string[];
    const ops = diffParagraphs(a, b);
    expectValid(a, b, ops);
    expect(ops.some((op) => op.type === "moveFrom")).toBe(false);
  });

  it("reports no moves when detectMoves is false", () => {
    const a = [P[0], P[1], P[2]] as string[];
    const b = [P[1], P[2], P[0]] as string[];
    const ops = diffParagraphs(a, b, { detectMoves: false });
    expectValid(a, b, ops);
    expect(ops.some((op) => op.type === "moveFrom" || op.type === "moveTo")).toBe(false);
  });

  it("is deterministic and valid for seeded random documents", () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const random = rng(seed);
      const a = Array.from({ length: 3 + Math.floor(random() * 25) }, () => randomText(random, 4 + Math.floor(random() * 30)).replace(/\n+/g, " "));
      let b = a.map((p) => (random() < 0.3 ? mutate(random, p, 2).replace(/\n+/g, " ") : p));
      if (random() < 0.5) b.splice(Math.floor(random() * b.length), 1);
      if (random() < 0.5) b.splice(Math.floor(random() * b.length), 0, randomText(random, 12).replace(/\n+/g, " "));
      if (random() < 0.5 && b.length > 2) {
        const [moved] = b.splice(Math.floor(random() * b.length), 1);
        b.splice(Math.floor(random() * b.length), 0, moved as string);
      }
      if (random() < 0.3 && b.length > 2) {
        const at = Math.floor(random() * (b.length - 1));
        b = [...b.slice(0, at), `${b[at]} ${b[at + 1]}`, ...b.slice(at + 2)];
      }
      const ops = diffParagraphs(a, b);
      try {
        expectValid(a, b, ops);
      } catch (error) {
        throw new Error(`seed ${seed}: ${String(error)}`);
      }
      expect(diffParagraphs(a, b)).toEqual(ops);
    }
  });

  it("aligns a 5 000 paragraph document within the time bound", () => {
    const random = rng(42);
    const a = Array.from({ length: 5000 }, (_, i) => `${i}. ${randomText(random, 30).replace(/\n+/g, " ")}`);
    const b = a.map((p, i) => (i % 40 === 0 ? `${p} amended` : p));
    b.splice(1000, 50);
    const [moved] = b.splice(2000, 1);
    b.splice(4000, 0, moved as string);
    const started = performance.now();
    const ops = diffParagraphs(a, b);
    expect(performance.now() - started).toBeLessThan(4000);
    expectValid(a, b, ops);
    expect(ops.filter((op) => op.type === "modify").length).toBeGreaterThan(100);
    expect(ops.filter((op) => op.type === "moveFrom")).toHaveLength(1);
  });

  it("stays bounded when nothing matches", () => {
    const random = rng(8);
    const a = Array.from({ length: 3000 }, () => `a${Math.floor(random() * 1e9)} b${Math.floor(random() * 1e9)} c d`);
    const b = Array.from({ length: 3000 }, () => `x${Math.floor(random() * 1e9)} y${Math.floor(random() * 1e9)} z w`);
    const started = performance.now();
    const ops = diffParagraphs(a, b);
    expect(performance.now() - started).toBeLessThan(4000);
    expectValid(a, b, ops);
  });
});
