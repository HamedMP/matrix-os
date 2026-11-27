import { describe, expect, it } from "vitest";

import type { DocxDocument, DocxTextView } from "../../../../packages/office/src/api/docx.js";
import { toHtml } from "../../../../packages/office/src/docx/index.js";
import { buildDocument, p, r } from "../model/build.js";
import { DOCX_FIXTURES, openFixture } from "../model/helpers.js";

const MODES: readonly DocxTextView[] = ["markup", "final", "original"];

const ALLOWED_TAGS = new Set(
  "html head meta title style body article section aside ol li p h1 h2 h3 h4 h5 h6 span strong em u s sup sub code a ins del table tbody tr td th br hr blockquote time".split(
    " ",
  ),
);

/** Every start tag of the output, with quoted attribute values removed. */
function startTags(html: string): Array<{ name: string; bare: string; tag: string }> {
  const out: Array<{ name: string; bare: string; tag: string }> = [];
  for (const match of html.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g)) {
    out.push({ name: (match[1] as string).toLowerCase(), bare: match[0].replace(/"[^"]*"/g, '""'), tag: match[0] });
  }
  return out;
}

/** Checks the structural safety of an export: known tags, no event handlers, safe links. */
function expectSafe(html: string): void {
  for (const { name, bare, tag } of startTags(html)) {
    expect(ALLOWED_TAGS.has(name), `unexpected tag ${tag}`).toBe(true);
    expect(bare, `event handler in ${tag}`).not.toMatch(/\son[a-z]*\s*=/i);
    expect(bare, `unquoted attribute in ${tag}`).not.toMatch(/=[^"]/);
    for (const href of tag.matchAll(/\shref="([^"]*)"/g)) {
      expect(href[1]).toMatch(/^(?:https?:|mailto:|#)/i);
    }
    expect(bare).not.toMatch(/\s(?:src|srcset|action|formaction)=/i);
  }
}

function decode(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** The words of the body text: notes, comments, labels and note marks removed. */
function bodyWords(html: string): string {
  const body = html
    .replace(/<style>.*?<\/style>/s, "")
    .replace(/<title>.*?<\/title>/s, "")
    .replace(/<section class="docx-notes.*?<\/section>/gs, "")
    .replace(/<aside class="docx-comments.*?<\/aside>/gs, "")
    .replace(/<span class="list-label"[^>]*>.*?<\/span>/g, "")
    .replace(/<sup class="note-ref.*?<\/sup>/g, "")
    .replace(/<(?:\/p|\/h\d|\/td|\/th|\/tr|br|span class="tab")[^>]*>/g, " ")
    .replace(/<[^>]+>/g, "");
  return decode(body).replace(/\s+/g, " ").trim();
}

const words = (text: string): string => text.replace(/￼/g, "").replace(/\s+/g, " ").trim();

async function exportAll(name: string): Promise<{ doc: DocxDocument; html: Record<DocxTextView, string> }> {
  const doc = await openFixture(name);
  return {
    doc,
    html: { markup: toHtml(doc, { mode: "markup" }), final: toHtml(doc, { mode: "final" }), original: toHtml(doc, { mode: "original" }) },
  };
}

describe("toHtml on every fixture", () => {
  for (const name of DOCX_FIXTURES) {
    it(`${name}: is a safe page whose text matches the engine in all three modes`, async () => {
      const { doc, html } = await exportAll(name);
      for (const mode of MODES) {
        const page = html[mode];
        expect(page.startsWith("<!DOCTYPE html>\n<html lang=\"en\">")).toBe(true);
        expect(page).toContain(`<article class="docx-document" data-mode="${mode}">`);
        expect(page).toContain("Content-Security-Policy");
        expectSafe(page);
        expect(bodyWords(page)).toBe(words(doc.getPlainText({ view: mode })));
      }
      expect(toHtml(doc).includes('data-mode="final"')).toBe(true);
      expect(toHtml(doc, { fragment: true }).startsWith("<article")).toBe(true);
    });
  }
});

describe("toHtml key facts", () => {
  it("tracked.docx: ins and del carry revision ids and authors only in markup", async () => {
    const { doc, html } = await exportAll("tracked.docx");
    const markup = html.markup;
    const ins = [...markup.matchAll(/<ins class="rev[^"]*" data-revision-id="([^"]+)"[^>]*data-revision-author="([^"]+)"/g)];
    const del = [...markup.matchAll(/<del class="rev[^"]*" data-revision-id="([^"]+)"[^>]*data-revision-author="([^"]+)"/g)];
    expect(ins.length).toBeGreaterThanOrEqual(5);
    expect(del.length).toBeGreaterThanOrEqual(3);
    const authors = new Set([...ins, ...del].map((match) => match[2]));
    expect(authors).toEqual(new Set(["Alex Morgan", "Priya Shah"]));
    const ids = new Set(doc.listRevisions().map((revision) => revision.id));
    for (const match of [...ins, ...del]) expect(ids.has(match[1] as string)).toBe(true);
    expect(markup).toContain('data-revision-kind="moveFrom"');
    expect(markup).toContain('data-revision-kind="moveTo"');
    expect(markup).toContain('class="rev rev-format"');
    expect(markup).toContain('data-mark-revision-kind="delete"');
    expect(markup).toMatch(/<tr class="rev-row rev-insert" data-revision-id=/);
    for (const mode of ["final", "original"] as const) {
      expect(html[mode]).not.toMatch(/<(?:ins|del)\b/);
      expect(html[mode]).not.toContain("data-revision-id");
    }
    expect(bodyWords(html.final)).toContain("within fifteen business days");
    expect(bodyWords(html.original)).toContain("within ten business days");
    expect(html.original).not.toContain("Widgets");
  });

  it("numbering.docx: labels are text", async () => {
    const { html } = await exportAll("numbering.docx");
    const labels = [...html.final.matchAll(/<span class="list-label"[^>]*>([^<]*)<\/span>/g)].map((match) => match[1]);
    expect(labels).toHaveLength(15);
    expect(labels.slice(0, 3)).toEqual(["1.", "1.1.", "(a)"]);
    expect(labels).toContain("•");
  });

  it("table.docx: merged cells keep their spans", async () => {
    const { html } = await exportAll("table.docx");
    expect(html.final).toMatch(/<td colspan="4"|<th colspan="4"/);
    expect(html.final).toMatch(/rowspan="2"/);
    expect(html.final).toContain('<table class="docx-table"');
  });

  it("comments.docx: anchors and the comment list", async () => {
    const { doc, html } = await exportAll("comments.docx");
    const anchors = [...html.final.matchAll(/<span class="comment-anchor" data-comment-ids="([^"]+)">/g)].map((m) => m[1]);
    const anchored = new Set(
      doc
        .getView()
        .body.blocks.flatMap((block) => (block.type === "paragraph" ? block.runs.flatMap((run) => run.commentIds) : [])),
    );
    expect(anchored.size).toBeGreaterThanOrEqual(2);
    expect(new Set(anchors.flatMap((ids) => (ids as string).split(" ")))).toEqual(anchored);
    const items = [...html.final.matchAll(/<li id="comment-[^"]+" data-comment-id="([^"]+)" data-author="([^"]+)"/g)];
    expect(items.map((match) => match[1])).toEqual(doc.listComments().map((comment) => comment.id));
    expect(html.final).toContain('data-parent-id="0" class="reply"');
  });

  it("footnotes-headers.docx: references link to the notes and back", async () => {
    const { html } = await exportAll("footnotes-headers.docx");
    const refs = [...html.final.matchAll(/<a href="#(note-[^"]+)" id="(noteref-\d+)" role="doc-noteref">/g)];
    expect(refs).toHaveLength(3);
    for (const [, target, refId] of refs) {
      expect(html.final).toContain(`<li id="${target}"`);
      expect(html.final).toContain(`href="#${refId}"`);
    }
    expect(html.final).toContain("Internal productivity study, 2025.");
  });

  it("links-fields.docx: external and internal links, bookmark targets", async () => {
    const { html } = await exportAll("links-fields.docx");
    expect(html.final).toContain('<a href="https://example.com/terms" rel="noopener noreferrer nofollow">');
    const internal = [...html.final.matchAll(/<a href="#(bm-[^"]+)">/g)].map((match) => match[1]);
    expect(internal.length).toBeGreaterThan(0);
    for (const anchor of internal) expect(html.final).toContain(`id="${anchor}"`);
  });

  it("unicode.docx: special characters are escaped and right-to-left text survives", async () => {
    const { html } = await exportAll("unicode.docx");
    expect(html.final).toContain("&lt;&amp;&gt;");
    expect(html.final).toContain("שלום עולם");
    expect(html.final).toContain('<span class="tab">\t</span>');
  });
});

describe("toHtml with hostile content", () => {
  const hostile = buildDocument({
    styles:
      '<w:style w:type="paragraph" w:styleId="Evil"><w:name w:val="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"/></w:style>',
    body:
      p(r("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &lt;img src=x onerror=alert(1)&gt; ' \" &amp;"), '<w:pStyle w:val="Evil"/>') +
      p(
        '<w:ins w:id="1" w:author="&quot;&gt;&lt;img src=x onerror=alert(2)&gt;" w:date="2026-01-01T00:00:00Z">' +
          r("inserted") +
          "</w:ins>" +
          '<w:hyperlink r:id="rIdBad">' +
          r("bad link") +
          "</w:hyperlink>" +
          '<w:hyperlink r:id="rIdGood">' +
          r("good link") +
          "</w:hyperlink>" +
          '<w:bookmarkStart w:id="5" w:name="x&quot; onfocus=&quot;y"/><w:bookmarkEnd w:id="5"/>' +
          '<w:commentRangeStart w:id="9"/>' +
          r("commented") +
          '<w:commentRangeEnd w:id="9"/><w:r><w:commentReference w:id="9"/></w:r>',
      ),
    comments:
      '<w:comment w:id="9" w:author="&lt;b onclick=x&gt;Mallory" w:date="2026-01-01T00:00:00Z">' +
      '<w:p><w:r><w:t>&lt;iframe src="https://evil.example"&gt;&lt;/iframe&gt;</w:t></w:r></w:p></w:comment>',
    links: { rIdBad: "javascript:alert(3)", rIdGood: "https://ok.example/a?b=1&c=2" },
  });

  for (const mode of MODES) {
    it(`escapes every document value in ${mode} mode`, () => {
      const html = toHtml(hostile, { mode, title: "</title><script>x</script>" });
      expectSafe(html);
      expect(html).not.toMatch(/<script|<img|<iframe|<b /i);
      expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
      expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; &#39; &quot; &amp;");
      expect(html).toContain('data-style="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
      expect(html).not.toContain("javascript:");
      expect(html).toContain("bad link");
      expect(html).toContain('href="https://ok.example/a?b=1&amp;c=2"');
      expect(html).toContain('data-author="&lt;b onclick=x&gt;Mallory"');
      expect(html).toContain("&lt;iframe src=&quot;https://evil.example&quot;&gt;&lt;/iframe&gt;");
      expect(html).toContain("<title>&lt;/title&gt;&lt;script&gt;x&lt;/script&gt;</title>");
      expect(html).toMatch(/<a class="bookmark" id="bm-x_0022_0020onfocus_003d_0022y"><\/a>/);
      if (mode === "markup") {
        expect(html).toContain('data-revision-author="&quot;&gt;&lt;img src=x onerror=alert(2)&gt;"');
      }
    });
  }
});
