import { describe, expect, it } from "vitest";
import {
  applyUserEdit,
  createRedline,
  deserialiseRedline,
  sanitiseHtml,
  serialiseRedline,
} from "../../../packages/office/src/redline/index.js";
import { expectAllowedMarkup, pick, rng } from "./helpers.js";

const ANN = { author: "Ann", date: "2026-11-23T10:00:00Z", format: "html" as const };
const BOB = { author: "Bob", date: "2026-11-24T09:30:00Z" };
const ATTRS = ' data-change-id="ID" data-author="Ann" data-date="2026-11-23T10:00:00Z"';
const del = (id: string, body: string, cls = "redline-del"): string => `<del class="${cls}"${ATTRS.replace("ID", id)}>${body}</del>`;
const ins = (id: string, body: string, cls = "redline-ins"): string => `<ins class="${cls}"${ATTRS.replace("ID", id)}>${body}</ins>`;

describe("sanitiseHtml keeps the allowed structure", () => {
  const stable = [
    "<p>Hello <b>world</b></p>",
    "<p>One</p><p>Two</p>",
    "<h1>Title</h1><p>Body with <i>italic</i>, <u>underline</u>, <s>strike</s> and <strong>strong <em>nested</em></strong>.</p>",
    '<p>See <a href="https://example.com/a?b=1&amp;c=2">the link</a> or <a href="mailto:ann@example.com">write</a>.</p>',
    "<ul><li>one</li><li>two</li></ul><ol><li>first</li><li>second</li></ol>",
    "<ul><li>parent<ul><li>child</li></ul></li><li>next</li></ul>",
    "<p>line one<br>line two</p>",
    "<blockquote><p>quoted</p><p>more</p></blockquote>",
    "<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td></td></tr></tbody></table>",
    "<div>intro<p>para</p>tail</div>",
    "<pre>a  b<br>  c</pre>",
    "<p></p><p>after an empty paragraph</p>",
    "plain text only",
    "",
  ];
  it.each(stable)("%s", (html) => {
    expect(sanitiseHtml(html)).toBe(html);
  });

  it("collapses whitespace and trims blocks", () => {
    expect(sanitiseHtml("<p>  Hello \n  <b> big </b>  world  </p>\n\n<p>Next</p>\n")).toBe("<p>Hello <b>big </b>world</p><p>Next</p>");
  });

  it("drops unknown elements and keeps their text, as separate blocks where they are block-like", () => {
    expect(sanitiseHtml("<section><p>a</p></section><font color=red>b</font><img src=x><hr>c")).toBe("<p>a</p>b<br>c");
    expect(sanitiseHtml("<p>x <span style='color:red' class=y>y</span> <custom-tag>z</custom-tag></p>")).toBe("<p>x <span>y</span> z</p>");
  });

  it("decodes character references and escapes them again", () => {
    expect(sanitiseHtml("<p>&lt;b&gt; &amp; &quot;q&quot; &#65;&#x42; &nbsp;&eacute;&unknown; &copy</p>")).toBe(
      "<p>&lt;b&gt; &amp; &quot;q&quot; AB  é&amp;unknown; &amp;copy</p>",
    );
  });

  it("reads a line or paragraph separator character in text as a space", () => {
    expect(sanitiseHtml("<p>one\u2028two\u2029three</p>")).toBe("<p>one two three</p>");
    const doc = createRedline("<p>one\u2028two</p>", "<p>one<br>two</p>", ANN);
    expect(doc.toHtml("original")).toBe("<p>one two</p>");
    expect(doc.toHtml("final")).toBe("<p>one<br>two</p>");
  });

  it("keeps line breaks and spacing inside pre", () => {
    expect(sanitiseHtml("<pre>\nfirst line\n  second\tline\n</pre>")).toBe("<pre>first line<br>  second\tline<br></pre>");
  });

  it("repairs unclosed and misnested markup", () => {
    expect(sanitiseHtml("<p>one<p>two")).toBe("<p>one</p><p>two</p>");
    expect(sanitiseHtml("<ul><li>a<li>b</ul>")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(sanitiseHtml("<p><b>bold</p>after</b>")).toBe("<p><b>bold</b></p>after");
    expect(sanitiseHtml("<table><tr><td>a<td>b<tr><td>c</table>")).toBe("<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>");
    expect(sanitiseHtml("</p></div>text</b>")).toBe("text");
    expect(sanitiseHtml("a < b and c > d")).toBe("a &lt; b and c &gt; d");
  });

  it("is idempotent on generated markup", () => {
    const random = rng(21);
    for (let i = 0; i < 80; i += 1) {
      const html = randomHtml(random);
      const once = sanitiseHtml(html);
      expect(sanitiseHtml(once), html).toBe(once);
    }
  });
});

describe("createRedline (html)", () => {
  it("marks a changed word inside its formatting", () => {
    const doc = createRedline("<p>Hello <b>world</b></p>", "<p>Hello <b>there</b></p>", ANN);
    expect(doc.format).toBe("html");
    expect(doc.toHtml("markup")).toBe(`<p>Hello ${del("c1", "<b>world</b>")}${ins("c2", "<b>there</b>")}</p>`);
    expect(doc.toHtml("original")).toBe("<p>Hello <b>world</b></p>");
    expect(doc.toHtml("final")).toBe("<p>Hello <b>there</b></p>");
    expect(doc.toFinalHtml()).toBe("<p>Hello <b>there</b></p>");
    expect(doc.listChanges().map((c) => [c.kind, c.text])).toEqual([["delete", "world"], ["insert", "there"]]);
  });

  it("refuses an unknown view mode", () => {
    const doc = createRedline("<p>a</p>", "<p>b</p>", ANN);
    expect(() => doc.toHtml("print" as never)).toThrowError(/mode must be/);
    expect(() => doc.toText("print" as never)).toThrowError(/mode must be/);
  });

  it("keeps the formatting of the side a change comes from", () => {
    const doc = createRedline("<p>pay <i>promptly</i> please</p>", '<p>pay <a href="https://example.com/terms">on the terms</a> please</p>', ANN);
    expect(doc.toHtml("markup")).toBe(
      `<p>pay ${del("c1", "<i>promptly</i>")}${ins("c2", '<a href="https://example.com/terms">on the terms</a>')} please</p>`,
    );
  });

  it("takes a formatting-only change from the revised side without tracking it", () => {
    const doc = createRedline("<p>Hello world</p>", "<p>Hello <b>world</b></p>", ANN);
    expect(doc.listChanges()).toEqual([]);
    expect(doc.toHtml("markup")).toBe("<p>Hello <b>world</b></p>");
    expect(doc.toHtml("original")).toBe("<p>Hello world</p>");
  });

  it("shows an inserted paragraph as its own block", () => {
    const doc = createRedline("<p>One.</p><p>Three.</p>", "<p>One.</p><p>Two.</p><p>Three.</p>", ANN);
    expect(doc.toHtml("markup")).toBe(`<p>One.</p><p>${ins("c1", "Two.")}</p><p>${ins("c1", "", "redline-ins redline-para")}Three.</p>`);
    expect(doc.listChanges()).toEqual([{ id: "c1", kind: "insert", text: "Two.\n", author: "Ann", date: ANN.date, pairedWith: null }]);
    expect(doc.toText("final")).toBe("One.\nTwo.\nThree.");
    const rejected = deserialiseRedline(serialiseRedline(doc));
    rejected.reject(["c1"]);
    expect(rejected.toHtml("markup")).toBe("<p>One.</p><p>Three.</p>");
    doc.accept(["c1"]);
    expect(doc.toHtml("markup")).toBe("<p>One.</p><p>Two.</p><p>Three.</p>");
    expect(doc.toHtml("original")).toBe("<p>One.</p><p>Two.</p><p>Three.</p>");
  });

  it("shows a deleted first heading in its own element and restores it on reject", () => {
    const original = "<h1>Title</h1><p>Body text.</p>";
    const doc = createRedline(original, "<p>Body text.</p>", ANN);
    expect(doc.toHtml("markup")).toBe(`<h1>${del("c1", "Title")}</h1><p>${del("c1", "", "redline-del redline-para")}Body text.</p>`);
    const kept = deserialiseRedline(serialiseRedline(doc));
    kept.accept("all");
    expect(kept.toHtml("final")).toBe("<p>Body text.</p>");
    expect(kept.toHtml("original")).toBe("<p>Body text.</p>");
    doc.reject("all");
    expect(doc.toHtml("final")).toBe(original);
  });

  it("joins two merged paragraphs in the markup view and splits them again on reject", () => {
    const original = "<p>First part.</p><p>Second part.</p>";
    const doc = createRedline(original, "<p>First part. Second part.</p>", ANN);
    const html = doc.toHtml("markup");
    expect(html.startsWith("<p>First part.")).toBe(true);
    expect(html.endsWith("Second part.</p>")).toBe(true);
    expect(html.match(/<p>/g)).toHaveLength(1);
    expect(html).toContain("redline-para");
    expect(doc.toHtml("original")).toBe(original);
    doc.reject("all");
    expect(doc.toHtml("final")).toBe(original);
  });

  it("keeps a deleted list item inside its list", () => {
    const doc = createRedline("<ul><li>one</li><li>two</li><li>three</li></ul>", "<ul><li>one</li><li>three</li></ul>", ANN);
    const html = doc.toHtml("markup");
    expect(html.match(/<ul>/g)).toHaveLength(1);
    expect(html.match(/<li>/g)).toHaveLength(3);
    expect(html).toContain(">two</del>");
    expect(doc.toHtml("final")).toBe("<ul><li>one</li><li>three</li></ul>");
    expect(doc.toHtml("original")).toBe("<ul><li>one</li><li>two</li><li>three</li></ul>");
  });

  it("keeps an added list item inside its list", () => {
    const doc = createRedline("<ol><li>one</li><li>three</li></ol>", "<ol><li>one</li><li>two</li><li>three</li></ol>", ANN);
    const html = doc.toHtml("markup");
    expect(html.match(/<ol>/g)).toHaveLength(1);
    expect(html.match(/<li>/g)).toHaveLength(3);
    doc.reject("all");
    expect(doc.toHtml("markup")).toBe("<ol><li>one</li><li>three</li></ol>");
  });

  it("tracks a line break as text", () => {
    const doc = createRedline("<p>one two</p>", "<p>one<br>two</p>", ANN);
    expect(doc.toText("final")).toBe("one\ntwo");
    expect(doc.listChanges().map((c) => [c.kind, c.text])).toEqual([["delete", " "], ["insert", "\n"]]);
    expect(doc.toHtml("final")).toBe("<p>one<br>two</p>");
    doc.reject("all");
    expect(doc.toHtml("final")).toBe("<p>one two</p>");
  });

  it("reports a moved paragraph as a move", () => {
    const p = [
      "<p>The supplier shall deliver the goods on time.</p>",
      "<p>The buyer pays within thirty days of delivery.</p>",
      "<p>Either party may end this agreement by written notice.</p>",
    ];
    const doc = createRedline(p.join(""), `${p[1]}${p[2]}${p[0]}`, ANN);
    const changes = doc.listChanges();
    expect(changes.filter((c) => c.kind === "moveFrom").map((c) => c.text)).toEqual(["The supplier shall deliver the goods on time."]);
    expect(changes.filter((c) => c.kind === "moveTo").map((c) => c.text)).toEqual(["The supplier shall deliver the goods on time."]);
    // The paragraph went from first to last, so one boundary after it goes and one before it comes.
    expect(changes.filter((c) => c.kind === "delete" || c.kind === "insert").map((c) => c.text)).toEqual(["\n", "\n"]);
    const html = doc.toHtml("markup");
    expect(html).toContain("redline-move-from");
    expect(html).toContain("redline-move-to");
    doc.reject("all");
    expect(doc.toHtml("final")).toBe(p.join(""));
  });

  it("final equals the cleaned revised markup and original the cleaned original, before and after resolving", () => {
    for (let seed = 1; seed <= 150; seed += 1) {
      const random = rng(seed);
      const original = randomHtml(random);
      const revised = random() < 0.3 ? randomHtml(random) : editHtml(random, original);
      const doc = createRedline(original, revised, ANN);
      const label = `seed ${seed}\n${original}\n${revised}`;
      expect(doc.toHtml("original"), label).toBe(sanitiseHtml(original));
      expect(doc.toHtml("final"), label).toBe(sanitiseHtml(revised));
      const markup = doc.toHtml("markup");
      expectAllowedMarkup(markup);
      const state = serialiseRedline(doc);
      expect(deserialiseRedline(state).toHtml("markup"), label).toBe(markup);
      const accepted = deserialiseRedline(state);
      accepted.accept("all");
      expect(accepted.toHtml("final"), label).toBe(sanitiseHtml(revised));
      expect(accepted.toHtml("markup"), label).toBe(sanitiseHtml(revised));
      expect(accepted.toHtml("original"), label).toBe(sanitiseHtml(revised));
      const rejected = deserialiseRedline(state);
      rejected.reject("all");
      expect(rejected.toHtml("final"), label).toBe(sanitiseHtml(original));
      expect(rejected.toHtml("markup"), label).toBe(sanitiseHtml(original));
    }
  });

  it("stays well-formed and consistent when changes are resolved one at a time", () => {
    for (let seed = 400; seed <= 460; seed += 1) {
      const random = rng(seed);
      const original = randomHtml(random);
      const revised = editHtml(random, original);
      const doc = createRedline(original, revised, ANN);
      const originalText = doc.toText("original");
      const finalText = doc.toText("final");
      let onlyAccepts = true;
      let onlyRejects = true;
      for (let guard = 0; guard < 500 && doc.listChanges().length > 0; guard += 1) {
        const changes = doc.listChanges();
        const target = pick(random, changes);
        if (random() < 0.5) {
          doc.accept([target.id]);
          onlyRejects = false;
        } else {
          doc.reject([target.id]);
          onlyAccepts = false;
        }
        expectAllowedMarkup(doc.toHtml("markup"));
        expect(sanitiseHtml(doc.toHtml("final"))).toBe(doc.toHtml("final"));
      }
      expect(doc.toHtml("final"), `seed ${seed}`).toBe(doc.toHtml("original"));
      expect(doc.toHtml("markup"), `seed ${seed}`).toBe(doc.toHtml("final"));
      if (onlyAccepts) expect(doc.toText("final")).toBe(finalText);
      if (onlyRejects) expect(doc.toHtml("final")).toBe(sanitiseHtml(original));
      if (onlyRejects) expect(doc.toText("final")).toBe(originalText);
    }
  });
});

describe("applyUserEdit (html)", () => {
  it("tracks typing in an html draft and keeps new formatting", () => {
    const doc = createRedline("<p>Dear Ann,</p><p>Thanks.</p>", "<p>Dear Ann,</p><p>Thanks.</p>", ANN);
    applyUserEdit(doc, "<p>Dear Ann,</p><p>Thanks <b>a lot</b>.</p>", BOB);
    expect(doc.listChanges()).toEqual([{ id: "c1", kind: "insert", text: " a lot", author: "Bob", date: BOB.date, pairedWith: null }]);
    expect(doc.toHtml("final")).toBe("<p>Dear Ann,</p><p>Thanks <b>a lot</b>.</p>");
    expect(doc.toHtml("original")).toBe("<p>Dear Ann,</p><p>Thanks.</p>");
    applyUserEdit(doc, "<p>Dear Ann,</p><p>Thanks <b>a lot</b>.</p><p>Bob</p>", BOB);
    expect(doc.listChanges().map((c) => [c.id, c.text])).toEqual([["c1", " a lot"], ["c2", "\nBob"]]);
    doc.reject("all");
    expect(doc.toHtml("final")).toBe("<p>Dear Ann,</p><p>Thanks.</p>");
  });

  it("layers a person's edits over an agent's pending changes", () => {
    const doc = createRedline("<p>We can meet on Monday.</p>", "<p>We can meet on Tuesday at noon.</p>", { ...ANN, author: "Agent" });
    applyUserEdit(doc, "<p>We could meet on Tuesday at noon.</p>", BOB);
    expect(doc.toHtml("final")).toBe("<p>We could meet on Tuesday at noon.</p>");
    expect(doc.toHtml("original")).toBe("<p>We can meet on Monday.</p>");
    const authors = doc.listChanges().map((c) => c.author);
    expect(authors).toContain("Agent");
    expect(authors).toContain("Bob");
    const mine = doc.listChanges().filter((c) => c.author === "Bob").map((c) => c.id);
    doc.reject(mine);
    expect(doc.toHtml("final")).toBe("<p>We can meet on Tuesday at noon.</p>");
  });

  it("keeps final equal to the typed markup through seeded random sessions", () => {
    for (let seed = 700; seed <= 740; seed += 1) {
      const random = rng(seed);
      const original = randomHtml(random);
      let current = editHtml(random, original);
      const doc = createRedline(original, current, ANN);
      for (let step = 0; step < 5; step += 1) {
        current = editHtml(random, current);
        applyUserEdit(doc, current, BOB);
        const label = `seed ${seed} step ${step}`;
        expect(doc.toHtml("final"), label).toBe(sanitiseHtml(current));
        expect(doc.toText("original"), label).toBe(createRedline(original, original, ANN).toText("final"));
        expectAllowedMarkup(doc.toHtml("markup"));
        expect(deserialiseRedline(serialiseRedline(doc)).toHtml("markup"), label).toBe(doc.toHtml("markup"));
      }
      const rejected = deserialiseRedline(serialiseRedline(doc));
      rejected.reject("all");
      expect(rejected.toHtml("final"), `seed ${seed}`).toBe(sanitiseHtml(original));
      doc.accept("all");
      expect(doc.toHtml("final"), `seed ${seed}`).toBe(sanitiseHtml(current));
    }
  });
});

const SENTENCES = [
  "The supplier delivers the goods.", "Payment is due in thirty days.", "Either party may terminate.", "Notices are sent by email.",
  "This clause survives termination.", "Fees exclude VAT & duties.", "Prices are < 100 EUR.", "See schedule 2.",
];

function inline(random: () => number): string {
  const text = pick(random, SENTENCES);
  const roll = random();
  if (roll < 0.15) return `<b>${text}</b>`;
  if (roll < 0.25) return `<i>${text}</i> and <u>more</u>`;
  if (roll < 0.35) return `<a href="https://example.com/${Math.floor(random() * 9)}">${text}</a>`;
  if (roll < 0.42) return `${text}<br>${pick(random, SENTENCES)}`;
  return text;
}

function block(random: () => number): string {
  const roll = random();
  if (roll < 0.5) return `<p>${inline(random)}</p>`;
  if (roll < 0.6) return `<h2>${pick(random, SENTENCES)}</h2>`;
  if (roll < 0.75) return `<ul>${Array.from({ length: 1 + Math.floor(random() * 3) }, () => `<li>${inline(random)}</li>`).join("")}</ul>`;
  if (roll < 0.85) return `<ol><li>${inline(random)}</li><li>${inline(random)}<ul><li>${inline(random)}</li></ul></li></ol>`;
  if (roll < 0.92) return `<blockquote><p>${inline(random)}</p></blockquote>`;
  return `<table><tbody><tr><td>${inline(random)}</td><td>${inline(random)}</td></tr></tbody></table>`;
}

function randomHtml(random: () => number): string {
  return Array.from({ length: 1 + Math.floor(random() * 6) }, () => block(random)).join("");
}

/** Edits markup the way a person would: changes words, and adds, removes or relocates whole blocks. */
function editHtml(random: () => number, html: string): string {
  const blocks: string[] = [...(html.match(/<(p|h2|ul|ol|blockquote|table)>.*?<\/\1>/g) ?? [])];
  const edits = 1 + Math.floor(random() * 3);
  for (let i = 0; i < edits; i += 1) {
    const at = Math.floor(random() * Math.max(1, blocks.length));
    const roll = random();
    if (roll < 0.2 && blocks.length > 1) blocks.splice(at, 1);
    else if (roll < 0.4) blocks.splice(at, 0, block(random));
    else if (roll < 0.5 && blocks.length > 1) {
      const [moved] = blocks.splice(at, 1);
      blocks.splice(Math.floor(random() * (blocks.length + 1)), 0, moved as string);
    } else if (blocks.length > 0) {
      const words = ["goods", "thirty", "party", "email", "termination", "VAT", "schedule"];
      const word = pick(random, words);
      const replacement = pick(random, ["services", "sixty", "side", "post", "expiry", "tax", "annex", ""]);
      blocks[at] = (blocks[at] as string).replace(word, replacement);
    }
  }
  return blocks.join("");
}
