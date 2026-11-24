import { describe, expect, it } from "vitest";
import { isOfficeError } from "../../../packages/office/src/errors.js";
import {
  applyUserEdit,
  createRedline,
  loadRedline,
  sanitiseHtml,
} from "../../../packages/office/src/redline/index.js";
import { expectAllowedMarkup, rng } from "./helpers.js";

const ANN = { author: "Ann", date: "2026-11-23T10:00:00Z", format: "html" as const };

/** Markup that must never survive in any form that a browser would act on. */
const HOSTILE: ReadonlyArray<readonly [string, string]> = [
  ["script element", "<p>a</p><script>alert(1)</script><p>b</p>"],
  ["script in upper case with attributes", '<SCRIPT SRC="https://evil.example/x.js" async></SCRIPT>text'],
  ["script never closed", "before<script>alert(1)"],
  ["script with a fake end tag in a string", "<script>var s = '</scr' + 'ipt>'; alert(1)</script>after"],
  ["nested script openers", "<<script>script>alert(1)<</script>/script>"],
  ["event handler attributes", '<p onclick="alert(1)" onmouseover=alert(2)>x</p><b onfocus=\'alert(3)\' tabindex=0>y</b>'],
  ["javascript link", '<a href="javascript:alert(1)">x</a>'],
  ["javascript link in mixed case with whitespace", '<a href="  JaVaScRiPt:alert(1)">x</a>'],
  ["javascript link split by a tab reference", '<a href="jav&#x09;ascript:alert(1)">x</a>'],
  ["javascript link split by a raw newline", '<a href="java\nscript:alert(1)">x</a>'],
  ["javascript link with entity-encoded colon", '<a href="javascript&colon;alert(1)">x</a><a href="javascript&#58;alert(1)">y</a>'],
  ["vbscript and data links", '<a href="vbscript:msgbox(1)">x</a><a href="data:text/html,<script>alert(1)</script>">y</a>'],
  ["protocol-relative and relative links", '<a href="//evil.example/x">x</a><a href="/local">y</a><a href="?q=1">z</a>'],
  ["unquoted attribute that breaks out", "<a href=https://ok.example/\"onmouseover=\"alert(1)>x</a>"],
  ["quote inside a link target", '<a href="https://ok.example/?q=&quot;><script>alert(1)</script>">x</a>'],
  ["image with error handler", '<img src=x onerror="alert(1)">text'],
  ["svg with load handler and script", '<svg onload="alert(1)"><script>alert(2)</script><text>t</text></svg>'],
  ["style element and style attribute", '<style>body{background:url("javascript:alert(1)")}</style><p style="background:url(javascript:alert(1))">x</p>'],
  ["iframe, object and embed", '<iframe src="javascript:alert(1)">in</iframe><object data="x.swf">in</object><embed src="x.swf">tail'],
  ["head with meta refresh and base", '<head><meta http-equiv="refresh" content="0;url=javascript:alert(1)"><base href="https://evil.example/"></head>body'],
  ["form controls", '<form action="https://evil.example"><input name="password" type="password"><button formaction="javascript:alert(1)">go</button></form>'],
  ["comment that hides markup", "<!-- <script>alert(1)</script> -->x<!--[if IE]><script>alert(2)</script><![endif]-->"],
  ["unterminated comment", "a<!-- <script>alert(1)</script>"],
  ["unterminated tag", '<p>x</p><a href="javascript:alert(1)" onclick="alert(2)'],
  ["unterminated attribute then markup", '<a title="x><script>alert(1)</script>'],
  ["null bytes and control characters", "<scr\u0000ipt>alert(1)</scr\u0000ipt><a href=\"java\u0000script:alert(1)\">x</a>"],
  ["processing instruction and doctype", '<?xml version="1.0"?><!DOCTYPE html [<!ENTITY x "y">]><p>x</p>'],
  ["markup built from character references", "&lt;script&gt;alert(1)&lt;/script&gt; &#60;img src=x onerror=alert(1)&#62;"],
  ["allowed element with a namespaced or odd name", "<p:script>alert(1)</p:script><a/href='javascript:alert(1)'>x</a>"],
  ["deeply nested elements", `${"<div><b>".repeat(500)}deep${"</b></div>".repeat(500)}`],
  ["many unclosed lists", `${"<ul><li>".repeat(300)}x`],
];

const FORBIDDEN = /<script|<style|<iframe|<object|<embed|<img|<svg|<form|<input|<meta|<base|javascript:|vbscript:|data:text|\son[a-z]+\s*=/i;

/** Text content of markup this module produced, with its own escapes undone once. */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&(lt|gt|quot|#39|amp);/g, (_, name: string) => ({ lt: "<", gt: ">", quot: '"', "#39": "'", amp: "&" })[name] as string);
}

describe("hostile HTML", () => {
  it.each(HOSTILE)("sanitiseHtml: %s", (_name, html) => {
    const out = sanitiseHtml(html);
    expectAllowedMarkup(out);
    // Whatever is left of the attack is inert text: no tag or attribute of the output matches.
    expect(out.replace(/&[a-z#0-9]+;/g, ""), out).not.toMatch(/<script|<style|<iframe|<object|<embed|<img|<svg|<form|<input|<meta|<base|\son[a-z]+\s*=\s*["']?[^"'<>]*>/i);
    for (const tag of out.match(/<[^>]*>/g) ?? []) expect(tag, out).not.toMatch(FORBIDDEN);
    expect(sanitiseHtml(out)).toBe(out);
  });

  it.each(HOSTILE)("redline views: %s", (_name, html) => {
    const clean = "<p>A harmless paragraph of text.</p>";
    for (const [original, revised] of [[clean, html], [html, clean], [html, `${html}<p>more</p>`]] as const) {
      const doc = createRedline(original, revised, { ...ANN, author: '"><script>alert(1)</script>' });
      for (const mode of ["markup", "final", "original"] as const) {
        const out = doc.toHtml(mode);
        expectAllowedMarkup(out);
        for (const tag of out.match(/<[^>]*>/g) ?? []) {
          expect(tag.replace(/ data-author="[^"]*"/, ""), out).not.toMatch(FORBIDDEN);
        }
      }
      doc.accept("all");
      expectAllowedMarkup(doc.toHtml("final"));
    }
  });

  it("drops script content whole and keeps the text around it", () => {
    expect(sanitiseHtml("<p>a</p><script>alert(1)</script><p>b</p>")).toBe("<p>a</p><p>b</p>");
    expect(sanitiseHtml("before<script>alert(1)")).toBe("before");
    expect(sanitiseHtml("<style>p{color:red}</style>x<iframe src=x>y</iframe>z")).toBe("xz");
  });

  it("drops event handlers and unsafe links but keeps the element and its text", () => {
    expect(sanitiseHtml('<p onclick="alert(1)">x</p>')).toBe("<p>x</p>");
    expect(sanitiseHtml('<a href="javascript:alert(1)" onclick="alert(2)">x</a>')).toBe("<a>x</a>");
    expect(sanitiseHtml('<a href="jav&#x09;ascript:alert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitiseHtml('<a href="/relative">x</a>')).toBe("<a>x</a>");
    expect(sanitiseHtml('<a HREF="https://ok.example/a b" target="_blank" rel="x">ok</a>')).toBe('<a href="https://ok.example/a%20b">ok</a>');
    expect(sanitiseHtml('<a href="MAILTO:ann@example.com">m</a>')).toBe('<a href="MAILTO:ann@example.com">m</a>');
  });

  it("escapes markup that arrives as character references", () => {
    const out = sanitiseHtml("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(visibleText(out)).toBe("<script>alert(1)</script>");
  });

  it("escapes a link target that tries to close its attribute", () => {
    const out = sanitiseHtml('<a href="https://ok.example/?q=&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">x</a>');
    expectAllowedMarkup(out);
    expect(out).toBe('<a href="https://ok.example/?q=&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">x</a>');
  });

  it("survives random byte soup without throwing and yields allowed markup", () => {
    const pieces = ["<", ">", "</", "/>", "<!--", "-->", '"', "'", "=", " ", "p", "a", "b", "script", "href", "onclick", "javascript:", "&", "&#", ";", "x", "\n", "<![CDATA[", "]]>", "li", "ul", "table", "td", "\u0000", "&lt;"];
    const random = rng(77);
    for (let i = 0; i < 400; i += 1) {
      let html = "";
      const length = Math.floor(random() * 60);
      for (let k = 0; k < length; k += 1) html += pieces[Math.floor(random() * pieces.length)];
      const out = sanitiseHtml(html);
      expectAllowedMarkup(out);
      expect(sanitiseHtml(out), JSON.stringify(html)).toBe(out);
      const doc = createRedline(html, `${html}<p>tail</p>`, ANN);
      expectAllowedMarkup(doc.toHtml("markup"));
      applyUserEdit(doc, html.split("").reverse().join(""), { author: "Bob", date: "2026-11-24" });
      expectAllowedMarkup(doc.toHtml("markup"));
    }
  });

  it("parses pathological input in linear time", () => {
    const inputs = [
      "<".repeat(200000),
      "<a ".repeat(60000),
      '<a href="'.repeat(40000),
      "<!--".repeat(60000),
      "<p>".repeat(60000),
      "<b>".repeat(60000),
      "&#".repeat(100000),
      `<script>${"</scrip".repeat(40000)}`,
      `<div ${'x="y" '.repeat(50000)}>t</div>`,
    ];
    for (const input of inputs) {
      const started = performance.now();
      expectAllowedMarkup(sanitiseHtml(input));
      expect(performance.now() - started, input.slice(0, 12)).toBeLessThan(2000);
    }
  });
});

describe("a saved state is untrusted", () => {
  const state = (): Record<string, unknown> =>
    JSON.parse(
      JSON.stringify(createRedline('<p>See <a href="https://ok.example/">this</a> text.</p>', '<p>See <a href="https://ok.example/">that</a> text.</p><ul><li>x</li></ul>', ANN).toJSON()),
    ) as Record<string, unknown>;
  const refused = (edit: (items: unknown[][], whole: Record<string, unknown>) => void): boolean => {
    const s = state();
    edit(s.items as unknown[][], s);
    try {
      loadRedline(s as never);
    } catch (error) {
      return isOfficeError(error, "invalid_argument");
    }
    return false;
  };

  it("loads an untouched state", () => {
    expect(refused(() => undefined)).toBe(false);
  });

  it("refuses element names outside the allow-list", () => {
    expect(refused((items) => ((items[0] as unknown[])[3] = "script:1"))).toBe(true);
    expect(refused((items) => ((items[0] as unknown[])[2] = 'p onclick="x":1'))).toBe(true);
    expect(refused((items) => ((items[0] as unknown[])[3] = "p:1/img:2"))).toBe(true);
    expect(refused((items) => ((items[0] as unknown[])[3] = "p"))).toBe(true);
    const text = (items: unknown[][]): unknown[] => items.find((item) => item[0] === 0) as unknown[];
    expect(refused((items) => (text(items)[3] = "script"))).toBe(true);
    expect(refused((items) => (text(items)[3] = 'b"><script>'))).toBe(true);
    expect(refused((items) => (text(items)[3] = "b  i"))).toBe(true);
  });

  it("refuses unsafe link targets", () => {
    const link = (items: unknown[][]): unknown[] => items.find((item) => typeof item[3] === "string" && (item[3] as string).includes("|")) as unknown[];
    expect(refused((items) => (link(items)[3] = "a|javascript:alert(1)"))).toBe(true);
    expect(refused((items) => (link(items)[3] = "a|java\tscript:alert(1)"))).toBe(true);
    expect(refused((items) => (link(items)[3] = "a|https://ok.example/ x"))).toBe(true);
    expect(refused((items) => (link(items)[3] = "b|https://ok.example/"))).toBe(true);
    expect(refused((items) => (link(items)[3] = "a|https://other.example/"))).toBe(false);
  });

  it("refuses items that contradict their change", () => {
    expect(refused((items) => items.push([0, "x", null, "", null]))).toBe(true);
    expect(refused((items) => items.push([0, "x", "", null, "c2"]))).toBe(true);
    expect(refused((items) => items.push([2, "x", "p:1", "p:1", null]))).toBe(true);
    expect(refused((items) => items.push([1, "\n", "", "", null]))).toBe(true);
    expect(refused((items) => items.push([7, "x", "", "", null]))).toBe(true);
    expect(refused((items) => items.push(["x"]))).toBe(true);
    expect(refused((_items, whole) => ((whole.changes as Record<string, unknown>[])[0] as Record<string, unknown>).id = "c1<script>")).toBe(true);
    expect(refused((_items, whole) => ((whole.changes as Record<string, unknown>[])[0] as Record<string, unknown>).pairedWith = "c1")).toBe(true);
  });

  it("escapes author and date from a state on output", () => {
    const s = state();
    ((s.changes as Record<string, unknown>[])[0] as Record<string, unknown>).author = '"><img src=x onerror=alert(1)>';
    ((s.changes as Record<string, unknown>[])[0] as Record<string, unknown>).date = "'\"><script>";
    const html = loadRedline(s as never).toHtml("markup");
    expectAllowedMarkup(html);
    expect(html).toContain("data-author=\"&quot;&gt;&lt;img src=x onerror=alert(1)&gt;\"");
  });
});
