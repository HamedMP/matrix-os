// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  attachmentToDataUrl,
  createCidResolver,
  sanitizeEmailHtml,
  sanitizeForQuote,
} from "../../../../home/apps/mail/src/html";
import { expectInert, PNG_BASE64, PNG_DATA_URL } from "./helpers";

const NEWSLETTER = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Weekly digest</title>
<style>
  body { margin: 0; background-color: #f4f4f7; }
  .wrapper { width: 100%; }
  .button { background-color: #1a73e8; color: #ffffff !important; border-radius: 4px; padding: 12px 24px; }
  @media only screen and (max-width: 600px) { .container { width: 100% !important; } .hide-mobile { display: none; } }
  @import url("https://cdn.example/font.css");
  .hero { background-image: url(https://cdn.example/hero.png); color: #333333; }
</style></head>
<body bgcolor="#f4f4f7" style="margin:0;padding:0">
<center>
<table class="wrapper" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr><td align="center">
    <table class="container" width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border:1px solid #e0e0e0;border-radius:8px">
      <thead><tr><th colspan="2" align="left" style="padding:24px;font-family:Helvetica,Arial,sans-serif;font-size:22px">Weekly digest</th></tr></thead>
      <tbody>
        <tr>
          <td width="50%" valign="top" style="padding:16px"><h2 style="margin:0 0 8px">First story</h2><p>Some <strong>bold</strong>, <em>emphasised</em> and <u>underlined</u> text.</p></td>
          <td width="50%" valign="top" style="padding:16px"><ul><li>One</li><li>Two</li></ul><ol start="3"><li>Three</li></ol></td>
        </tr>
        <tr><td colspan="2" align="center" style="padding:24px"><a class="button" href="https://news.example/read?utm_source=mail&amp;id=42" style="display:inline-block;text-decoration:none">Read more</a></td></tr>
        <tr><td colspan="2"><blockquote style="margin:0 16px;border-left:3px solid #cccccc;padding-left:12px">A pull quote.</blockquote><hr><font color="#888888" size="2" face="Arial, sans-serif">You get this because you signed up.</font> <a href="mailto:unsubscribe@news.example?subject=unsubscribe">Unsubscribe</a></td></tr>
      </tbody>
    </table>
  </td></tr>
</table>
</center>
</body></html>`;

describe("sanitizeEmailHtml on a legitimate newsletter", () => {
  const result = sanitizeEmailHtml(NEWSLETTER);
  const body = expectInert(result.html);

  it("keeps the table layout, headings, lists and inline formatting", () => {
    expect(body.querySelectorAll("table").length).toBe(2);
    expect(body.querySelector("table.container")?.getAttribute("width")).toBe("600");
    expect(body.querySelector("table.wrapper")?.getAttribute("role")).toBe("presentation");
    expect(body.querySelector("th")?.getAttribute("colspan")).toBe("2");
    expect(body.querySelector("td[valign=top]")?.getAttribute("width")).toBe("50%");
    expect(body.querySelector("h2")?.textContent).toBe("First story");
    expect(body.querySelectorAll("li").length).toBe(3);
    expect(body.querySelector("ol")?.getAttribute("start")).toBe("3");
    expect(body.querySelector("strong")?.textContent).toBe("bold");
    expect(body.querySelector("em")).not.toBeNull();
    expect(body.querySelector("u")).not.toBeNull();
    expect(body.querySelector("blockquote")?.textContent).toBe("A pull quote.");
    expect(body.querySelector("hr")).not.toBeNull();
    expect(body.querySelector("font")?.getAttribute("color")).toBe("#888888");
    expect(body.querySelector("center")).not.toBeNull();
    expect(body.textContent).not.toContain("Weekly digest\n<style");
  });

  it("keeps safe inline styles", () => {
    const container = body.querySelector<HTMLElement>("table.container");
    expect(container?.getAttribute("style")).toContain("background-color:#ffffff");
    expect(container?.getAttribute("style")).toContain("border-radius:8px");
    expect(body.querySelector("th")?.getAttribute("style")).toContain("font-family:Helvetica,Arial,sans-serif");
  });

  it("carries the body's own attributes on a wrapper", () => {
    const wrapper = body.querySelector(".mx-body");
    expect(wrapper?.getAttribute("bgcolor")).toBe("#f4f4f7");
    expect(wrapper?.getAttribute("style")).toContain("margin:0");
    expect(wrapper?.getAttribute("lang")).toBeNull();
    expect(result.hasOwnColors).toBe(true);
  });

  it("opens links in a new context and keeps their query strings", () => {
    const link = body.querySelector("a.button");
    expect(link?.getAttribute("href")).toBe("https://news.example/read?utm_source=mail&id=42");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(body.querySelector('a[href^="mailto:"]')?.getAttribute("href")).toBe("mailto:unsubscribe@news.example?subject=unsubscribe");
  });

  it("returns the safe part of the stylesheet separately, retargeted at the wrapper", () => {
    expect(result.css).toContain(".mx-body{margin:0;background-color:#f4f4f7}");
    expect(result.css).toContain(".button{background-color:#1a73e8;color:#ffffff !important;border-radius:4px;padding:12px 24px}");
    expect(result.css).toContain("@media only screen and (max-width: 600px){.container{width:100% !important}.hide-mobile{display:none}}");
    expect(result.css).toContain(".hero{color:#333333}");
    expect(result.css).not.toContain("@import");
    expect(result.css).not.toContain("font.css");
    expect(result.css).not.toContain("url(");
    expect(result.html).not.toContain("<style");
  });

  it("leaves nothing to report for a mail without images or quotes", () => {
    expect(result).toMatchObject({ blockedImages: 0, trackersRemoved: 0, cidRefs: [], missingCids: [], hasQuote: false, quoteCollapsed: false, truncated: false, fallback: false });
  });

  it("reports no colours of its own for unstyled mail", () => {
    expect(sanitizeEmailHtml("<div>Hi,<br>See you <b>tomorrow</b>.</div>").hasOwnColors).toBe(false);
    expect(sanitizeEmailHtml('<p style="color:#000">dark text</p>').hasOwnColors).toBe(true);
    expect(sanitizeEmailHtml('<font color="red">x</font>').hasOwnColors).toBe(true);
  });
});

describe("remote images", () => {
  const html = '<p>Hello</p><img src="https://cdn.example/banner.png" alt="Spring sale" width="600" height="200"><img src="http://cdn.example/b.gif"><img src="//cdn.example/c.png" alt="c">';

  it("replaces them with placeholders by default and counts them", () => {
    const result = sanitizeEmailHtml(html);
    const body = expectInert(result.html);
    expect(result.blockedImages).toBe(3);
    expect(body.querySelectorAll("img").length).toBe(0);
    expect(result.html).not.toContain("cdn.example");
    const placeholders = body.querySelectorAll(".mx-image-blocked");
    expect(placeholders.length).toBe(3);
    expect(placeholders[0].getAttribute("role")).toBe("img");
    expect(placeholders[0].getAttribute("aria-label")).toBe("Blocked image: Spring sale");
    expect(placeholders[0].textContent).toBe("Spring sale");
    expect(placeholders[0].getAttribute("style")).toBe("width:600px;height:200px");
  });

  it("loads them once the owner opts in, without a referrer", () => {
    const result = sanitizeEmailHtml(html, { remoteImages: "allow" });
    const body = expectInert(result.html);
    expect(result.blockedImages).toBe(0);
    const images = Array.from(body.querySelectorAll("img"));
    expect(images.map((image) => image.getAttribute("src"))).toEqual([
      "https://cdn.example/banner.png",
      "http://cdn.example/b.gif",
      "https://cdn.example/c.png",
    ]);
    expect(images[0].getAttribute("alt")).toBe("Spring sale");
    expect(images[0].getAttribute("width")).toBe("600");
    expect(images[0].getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("can route allowed images through a resolver and blocks what it rejects", () => {
    const result = sanitizeEmailHtml(html, {
      remoteImages: "allow",
      resolveRemoteImage: (url) => (url.endsWith("banner.png") ? PNG_DATA_URL : url.endsWith("b.gif") ? "javascript:alert(1)" : null),
    });
    const body = expectInert(result.html);
    expect(body.querySelectorAll("img").length).toBe(1);
    expect(body.querySelector("img")?.getAttribute("src")).toBe(PNG_DATA_URL);
    expect(result.blockedImages).toBe(2);
  });

  it("drops tracking pixels in every mode", () => {
    const trackers = [
      '<img src="https://t.example/open?id=1" width="1" height="1">',
      '<img src="https://t.example/open?id=2" width="0" height="0" alt="">',
      '<img src="https://t.example/open?id=3" style="width:1px;height:1px">',
      '<img src="https://t.example/open?id=4" style="display:none" width="100" height="100">',
      '<img src="https://t.example/open?id=5" height="1" width="1px" border="0">',
      '<img src="https://t.example/open?id=6" style="visibility:hidden">',
    ].join("");
    for (const remoteImages of ["block", "allow"] as const) {
      const result = sanitizeEmailHtml(`<p>Hi</p>${trackers}<img src="https://cdn.example/spacer.gif" width="600" height="1">`, { remoteImages });
      expectInert(result.html);
      expect(result.trackersRemoved).toBe(6);
      expect(result.html).not.toContain("t.example");
      expect(result.blockedImages).toBe(remoteImages === "block" ? 1 : 0);
    }
  });

  it("removes images entirely when asked, leaving their description", () => {
    const result = sanitizeEmailHtml(html, { remoteImages: "remove" });
    const body = expectInert(result.html);
    expect(body.querySelectorAll("img, .mx-image-blocked").length).toBe(0);
    expect(body.textContent).toContain("[Spring sale]");
    expect(result.blockedImages).toBe(0);
  });

  it("strips remote backgrounds from styles but keeps the colour next to them", () => {
    const result = sanitizeEmailHtml('<p style="background:#fafafa url(https://cdn.example/bg.png) no-repeat;color:#111">x</p><div style="background-image:url(\'https://cdn.example/x.png\');padding:4px">y</div>');
    expect(result.html).toContain('style="background:#fafafa no-repeat;color:#111"');
    expect(result.html).toContain('<div style="padding:4px">y</div>');
  });
});

describe("inline images", () => {
  it("accepts small raster data images and rejects other data", () => {
    const ok = expectInert(sanitizeEmailHtml(`<img src="${PNG_DATA_URL}" alt="dot">`).html);
    expect(ok.querySelector("img")?.getAttribute("src")).toBe(PNG_DATA_URL);
    const jpeg = sanitizeEmailHtml(`<img src="data:image/jpg;base64,${PNG_BASE64}">`);
    expect(expectInert(jpeg.html).querySelector("img")?.getAttribute("src")).toBe(`data:image/jpeg;base64,${PNG_BASE64}`);
    const tolerant = sanitizeEmailHtml(`<img src=" DATA:IMAGE/PNG;BASE64,${PNG_BASE64.slice(0, 40)}\n${PNG_BASE64.slice(40)} ">`);
    expect(expectInert(tolerant.html).querySelector("img")?.getAttribute("src")).toBe(PNG_DATA_URL);
    expect(sanitizeEmailHtml('<img src="data:image/png,rawbytes">').html).not.toContain("<img");
    expect(sanitizeEmailHtml('<img src="data:image/png;base64,not base64!">').html).not.toContain("<img");
  });

  it("enforces the size cap on data images", () => {
    const big = `data:image/png;base64,${"A".repeat(4000)}`;
    expect(sanitizeEmailHtml(`<img src="${big}">`, { maxInlineImageBytes: 5000 }).html).toContain("<img");
    const capped = sanitizeEmailHtml(`<img src="${big}" alt="chart">`, { maxInlineImageBytes: 1000 });
    expect(capped.html).not.toContain("<img");
    expect(expectInert(capped.html).querySelector(".mx-image-missing")?.textContent).toBe("chart");
  });

  it("resolves cid images from attachments and reports the ones it could not", () => {
    const resolveCid = createCidResolver([
      { contentId: "<logo@mail.example>", dataUrl: PNG_DATA_URL },
      { name: "image001.png", dataUrl: PNG_DATA_URL },
    ]);
    const result = sanitizeEmailHtml(
      '<img src="cid:logo@mail.example" alt="Logo"><img src="CID:image001.png@01DB4A2C.5F0E1230"><img src="cid:missing%40x" alt="Chart"><img src="cid:logo@mail.example">',
      { resolveCid },
    );
    const body = expectInert(result.html);
    expect(body.querySelectorAll("img").length).toBe(3);
    expect(body.querySelector("img")?.getAttribute("src")).toBe(PNG_DATA_URL);
    expect(result.cidRefs).toEqual(["logo@mail.example", "image001.png@01DB4A2C.5F0E1230", "missing@x"]);
    expect(result.missingCids).toEqual(["missing@x"]);
    expect(body.querySelector(".mx-image-missing")?.getAttribute("aria-label")).toBe("Missing image: Chart");
    expect(result.blockedImages).toBe(0);
  });

  it("never trusts what a cid resolver returns", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html;base64,AAAA", "data:image/svg+xml;base64,AAAA", "https://evil.example/x.png", "blob:null/1"]) {
      const result = sanitizeEmailHtml('<img src="cid:a">', { resolveCid: () => bad });
      expectInert(result.html);
      expect(result.html).not.toContain("<img");
      expect(result.missingCids).toEqual(["a"]);
    }
    const throwing = sanitizeEmailHtml('<img src="cid:a">', { resolveCid: () => { throw new Error("boom"); } });
    expect(throwing.missingCids).toEqual(["a"]);
  });

  it("builds data URLs only from raster attachments under the cap", () => {
    expect(attachmentToDataUrl({ mimeType: "image/png", contentBase64: PNG_BASE64 })).toBe(PNG_DATA_URL);
    expect(attachmentToDataUrl({ mimeType: "IMAGE/JPEG; name=x.jpg", contentBase64: PNG_BASE64 })).toBe(`data:image/jpeg;base64,${PNG_BASE64}`);
    expect(attachmentToDataUrl({ mimeType: "image/svg+xml", contentBase64: PNG_BASE64 })).toBeNull();
    expect(attachmentToDataUrl({ mimeType: "text/html", contentBase64: PNG_BASE64 })).toBeNull();
    expect(attachmentToDataUrl({ mimeType: "image/png", contentBase64: "<svg onload=alert(1)>" })).toBeNull();
    expect(attachmentToDataUrl({ mimeType: "image/png", contentBase64: PNG_BASE64 }, 10)).toBeNull();
    const urlSafe = PNG_BASE64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(attachmentToDataUrl({ mimeType: "image/png", contentBase64: urlSafe })).toBe(PNG_DATA_URL);
  });

  it("matches cid references by content id first, then by file name", () => {
    const resolve = createCidResolver([
      { contentId: "ii_abc123", name: "photo.jpg", dataUrl: "data:image/jpeg;base64,AAAA" },
      { name: "Chart.PNG", dataUrl: PNG_DATA_URL },
    ]);
    expect(resolve("II_ABC123")).toBe("data:image/jpeg;base64,AAAA");
    expect(resolve("<ii_abc123>")).toBe("data:image/jpeg;base64,AAAA");
    expect(resolve("chart.png")).toBe(PNG_DATA_URL);
    expect(resolve("chart.png@01DB.5F0E")).toBe(PNG_DATA_URL);
    expect(resolve("other")).toBeNull();
    expect(resolve("__proto__")).toBeNull();
  });
});

describe("sanitizeForQuote", () => {
  it("returns markup that is safe to place in the app's own document", () => {
    const quoted = sanitizeForQuote(`${NEWSLETTER}<img src="https://cdn.example/a.png" alt="Banner"><div class="oui-button" style="position:absolute;color:red">x</div>`);
    const body = expectInert(quoted);
    expect(body.querySelectorAll("[class], img").length).toBe(0);
    expect(body.textContent).toContain("[Banner]");
    expect(quoted).toContain('style="color:red"');
    expect(body.querySelector("table")).not.toBeNull();
  });

  it("keeps earlier quotes, because the reply quotes the whole message", () => {
    const quoted = sanitizeForQuote('<div>Thanks</div><div class="gmail_quote">On Mon, A wrote:<blockquote>Earlier</blockquote></div>');
    expect(quoted).toContain("Earlier");
  });
});
