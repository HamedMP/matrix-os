// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { htmlToText, quoteText, renderMailBody, snippetFromHtml, textToHtml } from "../../../../home/apps/mail/src/html";
import { expectInert } from "./helpers";

describe("textToHtml", () => {
  it("escapes markup and keeps line breaks", () => {
    const result = textToHtml("Hi <b>there</b> & welcome\n\n<script>alert(1)</script>\n  indented \"quoted\"");
    const body = expectInert(result.html);
    expect(body.querySelector("b, script")).toBeNull();
    expect(body.textContent).toBe('Hi <b>there</b> & welcome<script>alert(1)</script>  indented "quoted"');
    expect(body.querySelectorAll("br").length).toBe(3);
    expect(body.querySelector(".mx-plain")).not.toBeNull();
    expect(result).toMatchObject({ css: "", blockedImages: 0, hasQuote: false, hasOwnColors: false, fallback: false });
  });

  it("turns web addresses into safe links", () => {
    const body = expectInert(textToHtml("See https://example.com/path?a=1&b=2#frag, or www.example.org/docs. (http://example.net/a_(b))").html);
    const links = Array.from(body.querySelectorAll("a"));
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "https://example.com/path?a=1&b=2#frag",
      "https://www.example.org/docs",
      "http://example.net/a_(b)",
    ]);
    expect(links.map((link) => link.textContent)).toEqual(["https://example.com/path?a=1&b=2#frag", "www.example.org/docs", "http://example.net/a_(b)"]);
    expect(body.textContent).toBe("See https://example.com/path?a=1&b=2#frag, or www.example.org/docs. (http://example.net/a_(b))");
  });

  it("turns mail addresses into mailto links", () => {
    const body = expectInert(textToHtml("Write to ada.lovelace+news@mail.example.com or <grace@example.org>.").html);
    expect(Array.from(body.querySelectorAll("a")).map((link) => link.getAttribute("href"))).toEqual([
      "mailto:ada.lovelace+news@mail.example.com",
      "mailto:grace@example.org",
    ]);
  });

  it("does not link other schemes or markup hidden in addresses", () => {
    const body = expectInert(textToHtml('javascript:alert(1) data:text/html,<script>x</script> file:///etc/passwd https://ok.example/"onmouseover="alert(1) https://user:pw@evil.example/').html);
    const hrefs = Array.from(body.querySelectorAll("a")).map((link) => link.getAttribute("href"));
    expect(hrefs).toEqual(["https://ok.example/"]);
  });

  it("handles empty and very long text", () => {
    expect(textToHtml("").html).toBe("");
    expect(textToHtml(undefined as unknown as string).html).toBe("");
    const long = textToHtml(`${"word ".repeat(300_000)}`);
    expect(long.truncated).toBe(true);
    expectInert(long.html);
  });
});

describe("htmlToText", () => {
  it("turns blocks, breaks, lists and tables into lines", () => {
    const text = htmlToText("<h1>Title</h1><p>First <b>bold</b>\n   paragraph.</p><p>Second<br>line</p><ul><li>One</li><li>Two</li></ul><ol><li>Uno</li><li>Dos</li></ol><table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table><div>End</div>");
    expect(text).toBe("Title\n\nFirst bold paragraph.\n\nSecond\nline\n\n- One\n- Two\n\n1. Uno\n2. Dos\n\nA B\nC D\n\nEnd");
  });

  it("drops what a reader would not see", () => {
    const text = htmlToText('<html><head><title>T</title><style>p{color:red}</style></head><body><script>alert(1)</script><p>Visible</p><div style="display:none">Hidden preheader</div><span style="font-size:0;max-height:0">tiny</span><p hidden>nope</p><!-- comment --><svg><text>vector</text></svg><template>tpl</template><textarea>field</textarea></body></html>');
    expect(text).toBe("Visible");
  });

  it("decodes entities and removes invisible characters", () => {
    expect(htmlToText("<p>Caf&eacute;&nbsp;&amp;&nbsp;bar &lt;3 &#x1F600;</p><p>zero\u200Bwidth\u00AD\uFEFF\u034F</p>")).toBe("Café & bar <3 😀\n\nzerowidth");
  });

  it("can include link targets and image descriptions", () => {
    const html = '<p>Read <a href="https://example.com/a">the post</a>, mail <a href="mailto:a@example.com">a@example.com</a> or <a href="javascript:alert(1)">click</a>. <a href="https://example.com/">https://example.com/</a><img src="x.png" alt="Chart"><img src="https://t.example/p.gif" width="1" height="1" alt="pixel"></p>';
    expect(htmlToText(html)).toBe("Read the post, mail a@example.com or click. https://example.com/");
    expect(htmlToText(html, { links: true, images: true })).toBe("Read the post (https://example.com/a), mail a@example.com or click. https://example.com/ [Chart]");
  });

  it("prefixes quotes, or leaves the quoted trail out", () => {
    const html = '<div>Agreed.</div><div class="gmail_quote">On Mon, Ada wrote:<blockquote>Shall we?<blockquote>Earlier</blockquote></blockquote></div>';
    expect(htmlToText(html)).toBe("Agreed.\nOn Mon, Ada wrote:\n\n> Shall we?\n>\n> > Earlier");
    expect(htmlToText(html, { quotes: "omit" })).toBe("Agreed.");
  });

  it("keeps preformatted text and bounds its output", () => {
    expect(htmlToText("<pre>a\n  b\n\tc</pre>")).toBe("a\n  b\n\tc");
    const cut = htmlToText(`<p>${"word ".repeat(1000)}</p>`, { maxLength: 50 });
    expect(cut.length).toBeLessThanOrEqual(50);
    expect(cut.endsWith("…")).toBe(true);
  });

  it("returns nothing for empty input and survives broken markup", () => {
    expect(htmlToText("")).toBe("");
    expect(htmlToText(null as unknown as string)).toBe("");
    expect(htmlToText("<p>unclosed <b>bold <i>text")).toBe("unclosed bold text");
    expect(htmlToText(`${"<div>".repeat(3000)}deep${"</div>".repeat(3000)}`)).toBe("deep");
  });
});

describe("snippetFromHtml", () => {
  it("gives one bounded line without the quoted trail", () => {
    const html = '<p>Hello   there,</p><p>The report\nis ready.</p><div class="gmail_quote">On Mon, Ada wrote:<blockquote>Old</blockquote></div>';
    expect(snippetFromHtml(html)).toBe("Hello there, The report is ready.");
    expect(snippetFromHtml(html, 12)).toBe("Hello there…");
  });
});

describe("quoteText", () => {
  it("prefixes every line and deepens existing quotes", () => {
    expect(quoteText("Hello\n\n> Earlier\nBye")).toBe("> Hello\n>\n> > Earlier\n> Bye");
    expect(quoteText("")).toBe("");
  });
});

describe("renderMailBody", () => {
  it("prefers the HTML part and falls back to the text part", () => {
    expect(renderMailBody({ html: "<p>Rich <script>alert(1)</script></p>", text: "Plain" }).html).toContain("<p>Rich </p>");
    const plain = renderMailBody({ html: null, text: "Plain https://example.com" });
    expect(expectInert(plain.html).querySelector("a")?.getAttribute("href")).toBe("https://example.com/");
    expect(renderMailBody({ html: "   ", text: "Plain" }).html).toContain("Plain");
    expect(renderMailBody({ html: "<script>alert(1)</script>", text: "Plain" }).html).toContain("Plain");
    expect(renderMailBody({ html: null, text: "" }).html).toBe("");
  });

  it("passes options through to both paths", () => {
    const html = renderMailBody({ html: '<img src="https://cdn.example/a.png">', text: "" }, { remoteImages: "allow" });
    expect(html.html).toContain("<img");
    const text = renderMailBody({ html: null, text: "Ok.\n\nOn Mon, Ada wrote:\n> Old" }, { quotes: "show" });
    expect(text.quoteCollapsed).toBe(false);
    expect(text.html).toContain("Old");
  });
});
