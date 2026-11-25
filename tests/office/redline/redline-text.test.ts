import { describe, expect, it } from "vitest";
import type { RedlineModule } from "../../../packages/office/src/api/redline.js";
import { isOfficeError } from "../../../packages/office/src/errors.js";
import * as redline from "../../../packages/office/src/redline/index.js";
import {
  applyUserEdit,
  createRedline,
  deserialiseRedline,
  loadRedline,
  serialiseRedline,
} from "../../../packages/office/src/redline/index.js";
import { mutate, randomText, rng } from "./helpers.js";

const ANN = { author: "Ann", date: "2026-11-23T10:00:00Z" };
const BOB = { author: "Bob", date: "2026-11-24T09:30:00Z" };

function codeOf(run: () => unknown): string | null {
  try {
    run();
  } catch (error) {
    return isOfficeError(error) ? error.code : `not an OfficeError: ${String(error)}`;
  }
  return null;
}

describe("contract", () => {
  it("exports the values the contract names", () => {
    const contract: RedlineModule = redline;
    expect(typeof contract.diffWords).toBe("function");
    expect(typeof contract.diffSequences).toBe("function");
    expect(typeof contract.createRedline).toBe("function");
    expect(typeof contract.loadRedline).toBe("function");
  });
});

describe("createRedline (text)", () => {
  it("lists a replacement as a deletion and an insertion that name each other", () => {
    const doc = createRedline("The cat sat", "The dog sat", ANN);
    expect(doc.format).toBe("text");
    expect(doc.listChanges()).toEqual([
      { id: "c1", kind: "delete", text: "cat", author: "Ann", date: ANN.date, pairedWith: "c2" },
      { id: "c2", kind: "insert", text: "dog", author: "Ann", date: ANN.date, pairedWith: "c1" },
    ]);
  });

  it("renders the three modes", () => {
    const doc = createRedline("The cat sat", "The dog sat", ANN);
    expect(doc.toText("original")).toBe("The cat sat");
    expect(doc.toText("final")).toBe("The dog sat");
    expect(doc.toFinalText()).toBe("The dog sat");
    expect(doc.toText("markup")).toBe("The catdog sat");
    expect(doc.toHtml("original")).toBe("The cat sat");
    expect(doc.toHtml("final")).toBe("The dog sat");
    expect(doc.toFinalHtml()).toBe("The dog sat");
    expect(doc.toHtml("markup")).toBe(
      'The <del class="redline-del" data-change-id="c1" data-author="Ann" data-date="2026-11-23T10:00:00Z">cat</del>' +
        '<ins class="redline-ins" data-change-id="c2" data-author="Ann" data-date="2026-11-23T10:00:00Z">dog</ins> sat',
    );
  });

  it("has no changes for identical texts", () => {
    const doc = createRedline("same", "same", ANN);
    expect(doc.listChanges()).toEqual([]);
    expect(doc.toHtml("markup")).toBe("same");
  });

  it("handles empty texts on either side", () => {
    expect(createRedline("", "", ANN).toHtml("markup")).toBe("");
    const added = createRedline("", "new", ANN);
    expect(added.listChanges().map((c) => [c.kind, c.text])).toEqual([["insert", "new"]]);
    expect(added.toText("original")).toBe("");
    const removed = createRedline("old", "", ANN);
    expect(removed.listChanges().map((c) => [c.kind, c.text])).toEqual([["delete", "old"]]);
    expect(removed.toFinalText()).toBe("");
  });

  it("escapes text and attribute values and turns line breaks into br", () => {
    const doc = createRedline("a < b\nline", 'a < b & "c"\nline <script>alert(1)</script>', {
      author: 'Eve" onmouseover="x',
      date: "2026-01-01",
    });
    const html = doc.toHtml("markup");
    expect(html).not.toContain("<script");
    expect(html).not.toContain('" onmouseover="x"');
    expect(html).toContain("a &lt; b");
    expect(html).toContain("<br>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain('data-author="Eve&quot; onmouseover=&quot;x"');
    expect(doc.toHtml("final")).toBe("a &lt; b &amp; &quot;c&quot;<br>line &lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("requires an author and a date", () => {
    expect(codeOf(() => createRedline("a", "b", { author: "Ann" } as never))).toBe("invalid_argument");
    expect(codeOf(() => createRedline("a", "b", { author: "Ann", date: "" }))).toBe("invalid_argument");
    expect(codeOf(() => createRedline("a", 5 as never, ANN))).toBe("invalid_argument");
    expect(codeOf(() => createRedline("a", "b", { ...ANN, format: "rtf" as never }))).toBe("invalid_argument");
  });

  it("refuses a text above the size bound", () => {
    expect(codeOf(() => createRedline("x".repeat(redline.MAX_REDLINE_LENGTH + 1), "", ANN))).toBe("limit_exceeded");
  });
});

describe("accept and reject (text)", () => {
  it("accepts one change and keeps the other pending", () => {
    const doc = createRedline("The cat sat", "The dog sat", ANN);
    doc.accept(["c1"]);
    expect(doc.listChanges().map((c) => c.id)).toEqual(["c2"]);
    expect(doc.listChanges()[0]?.pairedWith).toBeNull();
    expect(doc.toText("original")).toBe("The  sat");
    expect(doc.toText("final")).toBe("The dog sat");
    doc.reject(["c2"]);
    expect(doc.listChanges()).toEqual([]);
    expect(doc.toText("final")).toBe("The  sat");
    expect(doc.toText("original")).toBe("The  sat");
  });

  it("accept all gives the revised text and reject all the original", () => {
    const accepted = createRedline("one two three", "one 2 three four", ANN);
    accepted.accept("all");
    expect(accepted.listChanges()).toEqual([]);
    expect(accepted.toText("markup")).toBe("one 2 three four");
    expect(accepted.toText("original")).toBe("one 2 three four");
    expect(accepted.toHtml("markup")).toBe("one 2 three four");
    const rejected = createRedline("one two three", "one 2 three four", ANN);
    rejected.reject("all");
    expect(rejected.listChanges()).toEqual([]);
    expect(rejected.toText("final")).toBe("one two three");
    expect(rejected.toHtml("markup")).toBe("one two three");
  });

  it("throws stale_reference for an unknown id and changes nothing", () => {
    const doc = createRedline("The cat sat", "The dog sat", ANN);
    const before = serialiseRedline(doc);
    expect(codeOf(() => doc.accept(["c1", "c9"]))).toBe("stale_reference");
    expect(codeOf(() => doc.reject(["nope"]))).toBe("stale_reference");
    expect(serialiseRedline(doc)).toBe(before);
    doc.accept(["c1"]);
    expect(codeOf(() => doc.accept(["c1"]))).toBe("stale_reference");
  });

  it("reports a relocated sentence as a paired move and resolves both halves together", () => {
    const s1 = "The supplier shall deliver the goods on time.";
    const s2 = "The buyer pays within thirty days of delivery.";
    const s3 = "Either party may end this agreement by written notice.";
    const original = `${s1} ${s2} ${s3}`;
    const revised = `${s2} ${s3} ${s1}`;
    const doc = createRedline(original, revised, ANN);
    const moves = doc.listChanges().filter((c) => c.kind === "moveFrom" || c.kind === "moveTo");
    expect(moves.map((c) => c.kind)).toEqual(["moveFrom", "moveTo"]);
    expect(moves[0]?.pairedWith).toBe(moves[1]?.id);
    expect(moves[1]?.pairedWith).toBe(moves[0]?.id);
    expect(moves[0]?.text).toBe(moves[1]?.text);
    const html = doc.toHtml("markup");
    expect(html).toContain('<del class="redline-move-from"');
    expect(html).toContain('<ins class="redline-move-to"');
    const rejected = loadRedline(doc.toJSON());
    rejected.reject([moves[1]?.id as string]);
    expect(rejected.listChanges().some((c) => c.kind === "moveFrom" || c.kind === "moveTo")).toBe(false);
    rejected.reject("all");
    expect(rejected.toFinalText()).toBe(original);
    doc.accept([moves[0]?.id as string]);
    expect(doc.listChanges().some((c) => c.kind === "moveFrom" || c.kind === "moveTo")).toBe(false);
    doc.accept("all");
    expect(doc.toFinalText()).toBe(revised);
  });

  it("does not report moves when detectMoves is false", () => {
    const a = "alpha beta gamma delta epsilon. one two three four five six.";
    const b = "one two three four five six. alpha beta gamma delta epsilon.";
    const doc = createRedline(a, b, { ...ANN, detectMoves: false });
    expect(doc.listChanges().every((c) => c.kind === "insert" || c.kind === "delete")).toBe(true);
  });

  it("accept(all) equals the revised text and reject(all) the original for seeded random edits", () => {
    for (let seed = 1; seed <= 150; seed += 1) {
      const random = rng(seed);
      const original = randomText(random, 3 + Math.floor(random() * 80));
      const revised = mutate(random, original, 1 + Math.floor(random() * 10));
      const doc = createRedline(original, revised, ANN);
      expect(doc.toText("original"), `seed ${seed}`).toBe(original);
      expect(doc.toText("final"), `seed ${seed}`).toBe(revised);
      const state = doc.toJSON();
      const accepted = loadRedline(state);
      accepted.accept("all");
      expect(accepted.toText("final"), `seed ${seed}`).toBe(revised);
      expect(accepted.toText("original"), `seed ${seed}`).toBe(revised);
      expect(accepted.listChanges()).toEqual([]);
      const rejected = loadRedline(state);
      rejected.reject("all");
      expect(rejected.toText("final"), `seed ${seed}`).toBe(original);
      expect(rejected.listChanges()).toEqual([]);
    }
  });

  it("resolves changes one at a time in a random order to a consistent text", () => {
    for (let seed = 300; seed <= 380; seed += 1) {
      const random = rng(seed);
      const original = randomText(random, 20 + Math.floor(random() * 60));
      const revised = mutate(random, original, 2 + Math.floor(random() * 8));
      const doc = createRedline(original, revised, ANN);
      let allAccepted = true;
      let allRejected = true;
      for (let guard = 0; guard < 1000 && doc.listChanges().length > 0; guard += 1) {
        const changes = doc.listChanges();
        const target = changes[Math.floor(random() * changes.length)] as (typeof changes)[number];
        const before = changes.length;
        if (random() < 0.5) {
          doc.accept([target.id]);
          allRejected = false;
        } else {
          doc.reject([target.id]);
          allAccepted = false;
        }
        expect(doc.listChanges().length).toBeLessThan(before);
      }
      expect(doc.listChanges()).toEqual([]);
      expect(doc.toText("final"), `seed ${seed}`).toBe(doc.toText("original"));
      if (allAccepted) expect(doc.toText("final")).toBe(revised);
      if (allRejected) expect(doc.toText("final")).toBe(original);
    }
  });
});

describe("saving a draft", () => {
  it("round-trips a document with unresolved changes through JSON", () => {
    const doc = createRedline("The cat sat on the mat", "A dog sat on the rug today", ANN);
    doc.accept([doc.listChanges()[0]?.id as string]);
    const json = serialiseRedline(doc);
    const copy = deserialiseRedline(json);
    expect(copy.listChanges()).toEqual(doc.listChanges());
    expect(copy.toHtml("markup")).toBe(doc.toHtml("markup"));
    expect(copy.toText("original")).toBe(doc.toText("original"));
    expect(serialiseRedline(copy)).toBe(json);
    expect(loadRedline(JSON.parse(json)).toHtml("markup")).toBe(doc.toHtml("markup"));
    expect(doc.toJSON().version).toBe(1);
    expect(doc.toJSON().format).toBe("text");
  });

  it("keeps new change ids unique after loading", () => {
    const doc = createRedline("one two", "one 2", ANN);
    const copy = deserialiseRedline(serialiseRedline(doc));
    applyUserEdit(copy, "one 2 three", BOB);
    const ids = copy.listChanges().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("c3");
  });

  it("refuses states it does not recognise", () => {
    const good = createRedline("The cat sat", "The dog sat", ANN).toJSON();
    const tamper = (edit: (state: Record<string, unknown>) => void): string | null => {
      const state = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
      edit(state);
      return codeOf(() => loadRedline(state as never));
    };
    expect(tamper(() => undefined)).toBeNull();
    expect(tamper((s) => (s.version = 2))).toBe("invalid_argument");
    expect(tamper((s) => (s.format = "rtf"))).toBe("invalid_argument");
    expect(tamper((s) => (s.items = []))).toBe("invalid_argument");
    expect(tamper((s) => (s.items = "x"))).toBe("invalid_argument");
    expect(tamper((s) => ((s.items as unknown[][])[1] = [0, "x", null, null, null]))).toBe("invalid_argument");
    expect(tamper((s) => ((s.items as unknown[][])[2] = [0, "cat", "", null, "c7"]))).toBe("invalid_argument");
    expect(tamper((s) => ((s.items as unknown[][])[2] = [0, "cat", null, "", "c1"]))).toBe("invalid_argument");
    expect(tamper((s) => ((s.changes as Record<string, unknown>[])[0] as Record<string, unknown>).kind = "format")).toBe("invalid_argument");
    expect(tamper((s) => (s.changes as unknown[]).push({ id: "c5", kind: "insert", author: "x", date: "y", pairedWith: null }))).toBe("invalid_argument");
    expect(tamper((s) => (s.nextChange = 1))).toBe("invalid_argument");
    expect(tamper((s) => delete s.accepted)).toBe("invalid_argument");
    expect(codeOf(() => loadRedline(null as never))).toBe("invalid_argument");
    expect(codeOf(() => deserialiseRedline("{not json"))).toBe("invalid_argument");
    expect(codeOf(() => deserialiseRedline("[]"))).toBe("invalid_argument");
  });
});

describe("applyUserEdit (text)", () => {
  it("records further typing as changes by the person who typed", () => {
    const doc = createRedline("The cat sat", "The dog sat", ANN);
    applyUserEdit(doc, "The dog sat down", BOB);
    expect(doc.toFinalText()).toBe("The dog sat down");
    expect(doc.toText("original")).toBe("The cat sat");
    expect(doc.listChanges()).toEqual([
      { id: "c1", kind: "delete", text: "cat", author: "Ann", date: ANN.date, pairedWith: "c2" },
      { id: "c2", kind: "insert", text: "dog", author: "Ann", date: ANN.date, pairedWith: "c1" },
      { id: "c3", kind: "insert", text: " down", author: "Bob", date: BOB.date, pairedWith: null },
    ]);
  });

  it("grows one insertion while the same person keeps typing", () => {
    const doc = createRedline("Dear team,", "Dear team,", ANN);
    let text = "Dear team,";
    for (const piece of [" th", "ank", "s", " for", " the", " dr", "aft."]) {
      text += piece;
      applyUserEdit(doc, text, BOB);
      expect(doc.listChanges().map((c) => c.id)).toEqual(["c1"]);
    }
    expect(doc.listChanges()).toEqual([
      { id: "c1", kind: "insert", text: " thanks for the draft.", author: "Bob", date: BOB.date, pairedWith: null },
    ]);
    expect(doc.toFinalText()).toBe("Dear team, thanks for the draft.");
  });

  it("starts a new change when someone else continues", () => {
    const doc = createRedline("Hello", "Hello world", ANN);
    applyUserEdit(doc, "Hello world again", BOB);
    expect(doc.listChanges().map((c) => [c.author, c.text])).toEqual([["Ann", " world"], ["Bob", " again"]]);
  });

  it("removes a pending insertion that is deleted again instead of tracking the deletion", () => {
    const doc = createRedline("Hello", "Hello", ANN);
    applyUserEdit(doc, "Hello brave world", BOB);
    applyUserEdit(doc, "Hello world", BOB);
    expect(doc.listChanges()).toEqual([
      { id: "c1", kind: "insert", text: " world", author: "Bob", date: BOB.date, pairedWith: null },
    ]);
    applyUserEdit(doc, "Hello", BOB);
    expect(doc.listChanges()).toEqual([]);
    expect(doc.toHtml("markup")).toBe("Hello");
  });

  it("tracks deleting original text, and joins deletions made one after another", () => {
    const doc = createRedline("one two three four", "one two three four", ANN);
    applyUserEdit(doc, "one two three", BOB);
    applyUserEdit(doc, "one two", BOB);
    expect(doc.listChanges()).toEqual([
      { id: "c1", kind: "delete", text: " three four", author: "Bob", date: BOB.date, pairedWith: null },
    ]);
    expect(doc.toText("original")).toBe("one two three four");
    doc.reject("all");
    expect(doc.toFinalText()).toBe("one two three four");
  });

  it("keeps one deletion while the same person backspaces through a sentence", () => {
    const doc = createRedline("The quick brown fox", "The quick brown fox", ANN);
    for (const text of ["The quick brown fo", "The quick brown f", "The quick brown ", "The quick brown", "The quick brow", "The quick"]) {
      applyUserEdit(doc, text, BOB);
      expect(doc.toFinalText()).toBe(text);
      expect(doc.listChanges().filter((c) => c.kind === "delete").map((c) => c.id)).toEqual(["c1"]);
    }
    expect(doc.listChanges()).toEqual([
      { id: "c1", kind: "delete", text: " brown fox", author: "Bob", date: BOB.date, pairedWith: null },
    ]);
  });

  it("keeps a replacement as one pair while its new word is typed letter by letter", () => {
    const doc = createRedline("Meet on Monday at noon", "Meet on Monday at noon", ANN);
    const pairs: string[] = [];
    for (const text of ["Meet on Monda at noon", "Meet on  at noon", "Meet on T at noon", "Meet on Tu at noon", "Meet on Tuesday at noon"]) {
      applyUserEdit(doc, text, BOB);
      expect(doc.toFinalText()).toBe(text);
      expect(doc.toText("original")).toBe("Meet on Monday at noon");
      pairs.push(doc.listChanges().map((c) => `${c.id}:${c.kind}:${c.text}`).join(" "));
    }
    expect(pairs).toEqual([
      "c1:delete:Monday c2:insert:Monda",
      "c1:delete:Monday",
      "c1:delete:Monday c3:insert:T",
      "c1:delete:Monday c3:insert:Tu",
      "c1:delete:Monday c3:insert:Tuesday",
    ]);
    const [gone, come] = doc.listChanges();
    expect(gone?.pairedWith).toBe(come?.id);
    expect(come?.pairedWith).toBe(gone?.id);
  });

  it("keeps the id of an insertion that is edited in the middle", () => {
    const doc = createRedline("Hello world", "Hello world", ANN);
    for (const text of ["Hello bg world", "Hello big world", "Hello big bad world"]) {
      applyUserEdit(doc, text, BOB);
      expect(doc.listChanges().map((c) => c.id)).toEqual(["c1"]);
    }
    expect(doc.listChanges()[0]?.text).toBe("big bad ");
  });

  it("keeps other people's pending deletions in place", () => {
    const doc = createRedline("alpha beta gamma", "alpha gamma", ANN);
    applyUserEdit(doc, "alpha gamma delta", BOB);
    expect(doc.toText("markup")).toBe("alpha beta gamma delta");
    expect(doc.toText("original")).toBe("alpha beta gamma");
    expect(doc.listChanges().map((c) => [c.kind, c.author])).toEqual([["delete", "Ann"], ["insert", "Bob"]]);
  });

  it("keeps the final text equal to what was typed for seeded random edit sessions", () => {
    for (let seed = 500; seed <= 560; seed += 1) {
      const random = rng(seed);
      const original = randomText(random, 30);
      let current = mutate(random, original, 4);
      const doc = createRedline(original, current, ANN);
      for (let step = 0; step < 6; step += 1) {
        current = mutate(random, current, 1 + Math.floor(random() * 3));
        applyUserEdit(doc, current, step % 2 === 0 ? BOB : ANN);
        expect(doc.toFinalText(), `seed ${seed} step ${step}`).toBe(current);
        expect(doc.toText("original"), `seed ${seed} step ${step}`).toBe(original);
        const ids = doc.listChanges().map((c) => c.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(deserialiseRedline(serialiseRedline(doc)).toHtml("markup")).toBe(doc.toHtml("markup"));
      }
      const rejected = deserialiseRedline(serialiseRedline(doc));
      rejected.reject("all");
      expect(rejected.toFinalText(), `seed ${seed}`).toBe(original);
      doc.accept("all");
      expect(doc.toFinalText(), `seed ${seed}`).toBe(current);
    }
  });

  it("leaves the document untouched when the edit is refused", () => {
    const doc = createRedline("a", "b", ANN);
    const before = serialiseRedline(doc);
    expect(codeOf(() => applyUserEdit(doc, "c", { author: "Bob" } as never))).toBe("invalid_argument");
    expect(codeOf(() => applyUserEdit(doc, "x".repeat(redline.MAX_REDLINE_LENGTH + 1), BOB))).toBe("limit_exceeded");
    expect(serialiseRedline(doc)).toBe(before);
  });
});
