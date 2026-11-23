import { describe, expect, it } from "vitest";

import type { ApplyOptions } from "../../../../packages/office/src/api/docx.js";
import { DATE, RAE, documentXml, open, prng, revisionXmlIds, text } from "./helpers.js";
import { expected, newDocument, step } from "./random-support.js";

const SEEDS = Array.from({ length: 40 }, (_, at) => 1000 + at * 7919);

describe("randomised tracked edit sequences", () => {
  it.each(SEEDS)("seed %i: accepting gives the intended text, rejecting the original", async (seed) => {
    const random = prng(seed);
    const doc = newDocument();
    const original = text(doc);
    const reference = original.split("\n").slice(0, -1);
    const options: ApplyOptions = { track: true, author: RAE, date: DATE };
    const history: string[] = [];
    for (let count = 0; count < 30; count++) {
      const op = step(doc, reference, random, options);
      if (op === null) continue;
      history.push(JSON.stringify(op));
      // After every step both views must hold, before anything is resolved.
      expect(text(doc, "final"), history.join("\n")).toBe(expected(reference));
      expect(text(doc, "original"), history.join("\n")).toBe(original);
    }
    // The generator skips a few impossible picks; most steps are real edits that leave revisions.
    expect(history.length).toBeGreaterThan(20);
    const ids = revisionXmlIds(doc);
    expect(ids.length).toBeGreaterThan(3);
    expect(new Set(ids).size).toBe(ids.length);

    const bytes = await doc.save();
    const accepted = await open(bytes);
    expect(text(accepted, "final")).toBe(expected(reference));
    expect(text(accepted, "original")).toBe(original);
    accepted.acceptRevisions("all");
    expect(accepted.listRevisions()).toEqual([]);
    expect(text(accepted, "markup")).toBe(expected(reference));
    expect(documentXml(accepted)).not.toMatch(/<w:(ins|del|rPrChange|pPrChange)\b/);

    const rejected = await open(bytes);
    rejected.rejectRevisions("all");
    expect(rejected.listRevisions()).toEqual([]);
    expect(text(rejected, "markup")).toBe(original);
    expect(documentXml(rejected)).not.toMatch(/<w:(ins|del|delText|rPrChange|pPrChange)\b/);
  });
});

describe("randomised direct edit sequences", () => {
  it.each(SEEDS.slice(0, 20))("seed %i: the text follows the reference and nothing is tracked", async (seed) => {
    const random = prng(seed);
    const doc = newDocument();
    const reference = text(doc).split("\n").slice(0, -1);
    const options: ApplyOptions = { track: false, author: RAE, date: DATE };
    const history: string[] = [];
    for (let count = 0; count < 30; count++) {
      const op = step(doc, reference, random, options);
      if (op === null) continue;
      history.push(JSON.stringify(op));
      expect(text(doc, "markup"), history.join("\n")).toBe(expected(reference));
    }
    expect(doc.listRevisions()).toEqual([]);
    const saved = await open(await doc.save());
    expect(text(saved, "markup")).toBe(expected(reference));
  });
});

describe("randomised edits by two authors", () => {
  it.each(SEEDS.slice(0, 20))("seed %i: resolving everything gives the intended and the original text", async (seed) => {
    const random = prng(seed);
    const doc = newDocument();
    const original = text(doc);
    const reference = original.split("\n").slice(0, -1);
    const authors: ApplyOptions[] = [
      { track: true, author: RAE, date: DATE },
      { track: true, author: "Jun Ito", date: "2026-11-23T11:30:00Z" },
    ];
    for (let count = 0; count < 30; count++) {
      step(doc, reference, random, authors[Math.floor(random() * 2)] as ApplyOptions);
    }
    const ids = revisionXmlIds(doc);
    expect(new Set(ids).size).toBe(ids.length);
    const bytes = await doc.save();
    const accepted = await open(bytes);
    accepted.acceptRevisions("all");
    expect(accepted.listRevisions()).toEqual([]);
    expect(text(accepted, "markup")).toBe(expected(reference));
    const rejected = await open(bytes);
    rejected.rejectRevisions("all");
    expect(rejected.listRevisions()).toEqual([]);
    expect(text(rejected, "markup")).toBe(original);
  });
});
