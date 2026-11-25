import { describe, expect, it } from "vitest";
import { createRedline } from "../../../../home/apps/_shared/office-engine/redline/index";
import {
  DEL_STYLE,
  INS_STYLE,
  degradeMarkup,
  editorMarkup,
  hasTrackedMarkup,
  htmlToPlainText,
  markedText,
  redlineFromDraftHtml,
} from "../../../../home/apps/mail/src/compose/redline-body";

const DATE = "2026-11-20T10:00:00.000Z";
const LATER = "2026-11-20T11:00:00.000Z";

function sample() {
  return createRedline(
    "<div>Hello world, how are you?</div><div>See you on Monday.</div>",
    "<div>Hello there world, how is it going?</div><div>See you on Tuesday.</div>",
    { author: "Assistant", date: DATE, format: "html" },
  );
}

describe("degradeMarkup", () => {
  it("styles insertions as coloured underline and deletions as strikethrough for any mail client", () => {
    const html = degradeMarkup(sample().toHtml("markup"));
    expect(html).toContain(`<ins class="redline-ins"`);
    expect(html).toContain(`style="${INS_STYLE}"`);
    expect(html).toContain(`style="${DEL_STYLE}"`);
    expect(INS_STYLE).toMatch(/text-decoration:\s*underline/);
    expect(INS_STYLE).toMatch(/color:/);
    expect(DEL_STYLE).toMatch(/text-decoration:\s*line-through/);
    expect(html).toContain('title="Inserted by Assistant"');
    expect(html).toContain('title="Deleted by Assistant"');
    // Every pending change is still wrapped, and nothing else is added.
    expect((html.match(/<ins\b/g) ?? []).length).toBe((sample().toHtml("markup").match(/<ins\b/g) ?? []).length);
    expect(html).not.toMatch(/<script|on\w+=/i);
  });

  it("escapes author names inside the title", () => {
    const doc = createRedline("<div>a</div>", "<div>a b</div>", { author: 'Eve "x" <script>', date: DATE, format: "html" });
    const html = degradeMarkup(doc.toHtml("markup"));
    expect(html).toContain('title="Inserted by Eve &quot;x&quot; &lt;script&gt;"');
    expect(html).not.toContain("<script>");
  });

  it("leaves markup without changes untouched", () => {
    expect(degradeMarkup("<div>plain <b>text</b></div>")).toBe("<div>plain <b>text</b></div>");
  });
});

describe("markedText", () => {
  it("gives a plain-text part that shows the changes with markers", () => {
    const text = markedText(sample().toHtml("markup"));
    expect(text).toBe("Hello {+there +}world, how [-are you-]{+is it going+}?\nSee you on [-Monday-]{+Tuesday+}.");
  });

  it("is the plain text when nothing is pending", () => {
    expect(markedText("<div>One</div><div>Two</div>")).toBe("One\nTwo");
    expect(htmlToPlainText("<div>One<br>Two</div><ul><li>x</li></ul>")).toBe("One\nTwo\nx");
  });
});

describe("editorMarkup", () => {
  it("makes deletions read-only so typing never lands inside struck text", () => {
    const html = editorMarkup(sample().toHtml("markup"));
    expect(html).toMatch(/<del class="redline-del"[^>]*contenteditable="false"/);
    expect(html).not.toMatch(/<ins[^>]*contenteditable/);
  });
});

describe("redlineFromDraftHtml", () => {
  it("returns null for a body without tracked changes", () => {
    expect(hasTrackedMarkup("<div>Hi <del>old</del></div>")).toBe(false);
    expect(redlineFromDraftHtml("<div>Hello</div>", DATE)).toBeNull();
  });

  it("round-trips a redline through the stored draft HTML", () => {
    const doc = sample();
    const stored = degradeMarkup(doc.toHtml("markup"));
    expect(hasTrackedMarkup(stored)).toBe(true);
    const live = redlineFromDraftHtml(stored, LATER)!;
    expect(live).not.toBeNull();
    expect(live.toHtml("final")).toBe(doc.toHtml("final"));
    expect(live.toHtml("original")).toBe(doc.toHtml("original"));
    const kinds = (changes: { kind: string; text: string; author: string }[]) => changes.map((c) => [c.kind, c.text, c.author]);
    expect(kinds(live.listChanges())).toEqual(kinds(doc.listChanges()));
    expect(live.listChanges()[0].date).toBe(DATE);
  });

  it("keeps each author's changes apart", () => {
    const doc = createRedline("<div>The quick fox jumps.</div>", "<div>The quick brown fox jumps.</div>", { author: "Assistant", date: DATE, format: "html" });
    doc.applyUserEdit("<div>The quick brown fox jumps high.</div>", { author: "Me", date: LATER });
    const live = redlineFromDraftHtml(degradeMarkup(doc.toHtml("markup")), LATER)!;
    expect(live.listChanges().map((c) => [c.text, c.author])).toEqual([["brown ", "Assistant"], [" high", "Me"]]);
    live.reject(live.listChanges().filter((c) => c.author === "Me").map((c) => c.id));
    expect(live.toFinalText()).toBe("The quick brown fox jumps.");
  });

  it("survives a provider that re-serialises attributes and reorders them", () => {
    const stored = '<div>Keep <ins style="color:#1a7f37" data-author="A <b>" class="redline-ins" data-change-id="c1">new </ins>words <DEL class="redline-del" data-author=\'A <b>\'>old</DEL></div>';
    const live = redlineFromDraftHtml(stored, LATER)!;
    expect(live.toFinalText()).toBe("Keep new words");
    expect(live.toText("original")).toBe("Keep words old");
    expect(live.listChanges().every((c) => c.author === "A <b>")).toBe(true);
  });

  it("reparses inserted paragraphs and list items without leaving empty blocks behind", () => {
    const doc = createRedline("<div>Intro</div>", "<div>Intro</div><ul><li>first</li><li>second</li></ul>", { author: "Assistant", date: DATE, format: "html" });
    const live = redlineFromDraftHtml(degradeMarkup(doc.toHtml("markup")), LATER)!;
    expect(live.toHtml("final")).toBe(doc.toHtml("final"));
    expect(live.toHtml("original")).toBe("<div>Intro</div>");
    live.reject("all");
    expect(live.toHtml("final")).toBe("<div>Intro</div>");
  });

  it("drops anything unsafe while reparsing", () => {
    const live = redlineFromDraftHtml('<div onclick="x()">a <ins class="redline-ins" data-author="A">b<script>alert(1)</script></ins><img src=x onerror=y></div>', LATER)!;
    const markup = live.toHtml("markup");
    expect(markup).not.toMatch(/script|onerror|onclick|<img/i);
    expect(live.toFinalText()).toBe("a b");
  });

  it("falls back to a default author when the stored markup has none", () => {
    const live = redlineFromDraftHtml("<div>a <ins>b</ins></div>".replace("<ins>", '<ins class="redline-ins">'), LATER)!;
    expect(live.listChanges()[0]).toMatchObject({ kind: "insert", date: LATER });
    expect(live.toFinalText()).toBe("a b");
    expect(live.listChanges()[0].author.length).toBeGreaterThan(0);
  });
});
