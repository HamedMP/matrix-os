import { expect } from "vitest";
import type { DiffOp, SequenceDiffOp } from "../../../packages/office/src/api/redline.js";

/** Deterministic pseudo-random numbers (mulberry32), so a failure can be replayed from its seed. */
export function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)] as T;
}

const WORDS = [
  "the", "agreement", "party", "shall", "pay", "within", "thirty", "days", "notice", "of",
  "termination", "and", "all", "fees", "due", "under", "this", "clause", "a", "to", "liable",
  "naïve", "café", "don't", "it's", "2026", "10%", "§4.2", "Zürich", "résumé",
];
const SEPARATORS = [" ", " ", " ", " ", ", ", ". ", "\n", "\n\n", "; ", " - "];

export function randomText(random: () => number, words: number): string {
  let out = "";
  for (let i = 0; i < words; i += 1) {
    out += pick(random, WORDS);
    if (i < words - 1) out += pick(random, SEPARATORS);
  }
  return out;
}

/** Applies a few random word-level edits: delete, insert, replace, relocate a span. */
export function mutate(random: () => number, text: string, edits: number): string {
  let parts = text.split(/(\s+)/);
  for (let e = 0; e < edits; e += 1) {
    if (parts.length === 0) parts = ["seed"];
    const at = Math.floor(random() * parts.length);
    const roll = random();
    if (roll < 0.25) {
      parts.splice(at, 1 + Math.floor(random() * 3));
    } else if (roll < 0.5) {
      parts.splice(at, 0, pick(random, WORDS), " ");
    } else if (roll < 0.75) {
      parts[at] = pick(random, WORDS);
    } else {
      const moved = parts.splice(at, 2 + Math.floor(random() * 12));
      parts.splice(Math.floor(random() * (parts.length + 1)), 0, ...moved);
    }
  }
  return parts.join("");
}

/** Checks every invariant the contract states for a text diff. */
export function expectValidDiff(a: string, b: string, ops: readonly DiffOp[]): void {
  let aPos = 0;
  let bPos = 0;
  let fromA = "";
  let fromB = "";
  const moveFrom = new Map<string, string>();
  const moveTo = new Map<string, string>();
  ops.forEach((op, index) => {
    expect(op.text.length, `op ${index} is empty`).toBeGreaterThan(0);
    expect(op.aStart).toBe(aPos);
    expect(op.bStart).toBe(bPos);
    const onA = op.type === "equal" || op.type === "delete" || op.type === "moveFrom";
    const onB = op.type === "equal" || op.type === "insert" || op.type === "moveTo";
    expect(op.aEnd - op.aStart).toBe(onA ? op.text.length : 0);
    expect(op.bEnd - op.bStart).toBe(onB ? op.text.length : 0);
    if (onA) {
      expect(a.slice(op.aStart, op.aEnd)).toBe(op.text);
      fromA += op.text;
    }
    if (onB) {
      expect(b.slice(op.bStart, op.bEnd)).toBe(op.text);
      fromB += op.text;
    }
    if (op.type === "moveFrom" || op.type === "moveTo") {
      expect(op.moveId).toEqual(expect.any(String));
      const side = op.type === "moveFrom" ? moveFrom : moveTo;
      expect(side.has(op.moveId as string), `move ${op.moveId} appears twice`).toBe(false);
      side.set(op.moveId as string, op.text);
    } else {
      expect(op.moveId).toBeNull();
      const previous = ops[index - 1];
      if (previous) expect(previous.type, `ops ${index - 1} and ${index} should be merged`).not.toBe(op.type);
    }
    aPos = op.aEnd;
    bPos = op.bEnd;
  });
  expect(aPos).toBe(a.length);
  expect(bPos).toBe(b.length);
  expect(fromA).toBe(a);
  expect(fromB).toBe(b);
  expect([...moveFrom.entries()].sort()).toEqual([...moveTo.entries()].sort());
}

export function expectValidSequenceDiff(a: readonly string[], b: readonly string[], ops: readonly SequenceDiffOp[]): void {
  let aPos = 0;
  let bPos = 0;
  const moves = new Map<string, string[]>();
  for (const op of ops) {
    expect(op.aStart).toBe(aPos);
    expect(op.bStart).toBe(bPos);
    const onA = op.type === "equal" || op.type === "delete" || op.type === "moveFrom";
    const onB = op.type === "equal" || op.type === "insert" || op.type === "moveTo";
    if (!onA) expect(op.aEnd).toBe(op.aStart);
    if (!onB) expect(op.bEnd).toBe(op.bStart);
    expect(op.aEnd - op.aStart + (op.bEnd - op.bStart)).toBeGreaterThan(0);
    if (op.type === "equal") expect(a.slice(op.aStart, op.aEnd)).toEqual(b.slice(op.bStart, op.bEnd));
    if (op.type === "moveFrom" || op.type === "moveTo") {
      const keys = op.type === "moveFrom" ? a.slice(op.aStart, op.aEnd) : b.slice(op.bStart, op.bEnd);
      const seen = moves.get(op.moveId as string);
      if (seen) expect(seen).toEqual(keys);
      else moves.set(op.moveId as string, keys);
    } else {
      expect(op.moveId).toBeNull();
    }
    aPos = op.aEnd;
    bPos = op.bEnd;
  }
  expect(aPos).toBe(a.length);
  expect(bPos).toBe(b.length);
}

/** Compact form for assertions: `=text`, `-text`, `+text`, `<text` (moved from), `>text` (moved to). */
export function brief(ops: readonly DiffOp[]): string[] {
  const sign = { equal: "=", delete: "-", insert: "+", moveFrom: "<", moveTo: ">" } as const;
  return ops.map((op) => sign[op.type] + op.text);
}

const ALLOWED = new Set([
  "p", "div", "br", "ul", "ol", "li", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "b", "strong", "i", "em",
  "u", "s", "span", "a", "table", "thead", "tbody", "tr", "th", "td", "ins", "del",
]);

/** Fails unless the markup holds only allowed elements, allowed attributes, balanced tags and escaped text. */
export function expectAllowedMarkup(html: string): void {
  const stack: string[] = [];
  const tag = /<(\/?)([a-z0-9]+)((?: [a-z-]+="[^"<>]*")*)>/y;
  const badText = />|&(?!(amp|lt|gt|quot|#39);)/;
  let at = 0;
  while (at < html.length) {
    if (html[at] !== "<") {
      const next = html.indexOf("<", at);
      const text = html.slice(at, next === -1 ? html.length : next);
      if (badText.test(text)) throw new Error(`unescaped text ${JSON.stringify(text.slice(0, 60))}`);
      at += text.length;
      continue;
    }
    tag.lastIndex = at;
    const match = tag.exec(html);
    if (!match) throw new Error(`unexpected markup at: ${html.slice(at, at + 60)}`);
    const [whole, closing, name, attrs] = match as unknown as [string, string, string, string];
    if (!ALLOWED.has(name)) throw new Error(`element ${name} is not allowed`);
    if (closing) {
      if (attrs !== "" || stack.pop() !== name) throw new Error(`unbalanced </${name}> at ${at}`);
    } else {
      const ok =
        name === "a"
          ? /^(?: href="(?:https?:|mailto:)[^"]*")?$/i.test(attrs)
          : name === "ins" || name === "del"
            ? /^ class="redline-[a-z -]+" data-change-id="c[0-9]+" data-author="[^"]*" data-date="[^"]*"$/.test(attrs)
            : attrs === "";
      if (!ok) throw new Error(`attributes not allowed on <${name}>: ${attrs}`);
      if (name !== "br") stack.push(name);
    }
    at += whole.length;
  }
  expect(stack, "unclosed elements").toEqual([]);
}
