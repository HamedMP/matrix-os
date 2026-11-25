import { describe, expect, it } from "vitest";

import type { DocxDocument, InlineRun, ParagraphBlock } from "../../../../packages/office/src/api/docx.js";
import { compareDocx, compareDocxDetailed, openDocx } from "../../../../packages/office/src/docx/index.js";
import { OPTIONS, buildDocx, describeRevisions, expectResolves, loadFixture, p, r, reopen, views } from "./helpers.js";

/*
 * Content that only the revised document has refers to things of the revised
 * package: relationships, images, styles, bookmarks. The result is built on
 * the original package, so each of them has to arrive there or be dropped.
 */

const PNG = (seed: number): Uint8Array =>
  new Uint8Array(
    Buffer.from(
      `iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk${seed === 1 ? "YPhfDwAChwGA" : "+M9QDwADhgGA"}60e6kgAAAABJRU5ErkJggg==`,
      "base64",
    ),
  );

const picture = (relationshipId: string): string =>
  `<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
  `<wp:extent cx="9525" cy="9525"/><wp:docPr id="1" name="Picture"/>` +
  `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
  `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
  `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
  `<pic:nvPicPr><pic:cNvPr id="0" name="Picture"/><pic:cNvPicPr/></pic:nvPicPr>` +
  `<pic:blipFill><a:blip r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
  `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9525" cy="9525"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
  `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;

const link = (relationshipId: string, text: string): string => `<w:hyperlink r:id="${relationshipId}">${r(text)}</w:hyperlink>`;

const runsOf = (document: DocxDocument, block: number): InlineRun[] => (document.getView().body.blocks[block] as ParagraphBlock).runs;

describe("content carried over from the revised document", () => {
  it("brings the target of a hyperlink in an inserted paragraph", async () => {
    const original = await buildDocx({ body: p(r("Opening words stay the same.")) + p(r("Closing words stay the same.")) });
    const revised = await buildDocx({
      body: p(r("Opening words stay the same.")) + p(r("Read the ") + link("rIdTerms", "published terms") + r(" first.")) + p(r("Closing words stay the same.")),
      links: { rIdTerms: "https://example.com/terms" },
    });
    const document = await reopen(await compareDocx(original, revised, OPTIONS));
    const linked = runsOf(document, 1).find((run) => run.hyperlink !== null);
    expect(linked?.text).toBe("published terms");
    expect(linked?.hyperlink?.href).toBe("https://example.com/terms");
    expect(linked?.revision?.kind).toBe("insert");
    await expectResolves(document, original, revised);
  });

  it("keeps a hyperlink whose text changed and puts the change inside it", async () => {
    const links = { rIdTerms: "https://example.com/terms" };
    const original = await buildDocx({ body: p(r("Read the ") + link("rIdTerms", "published terms") + r(" first.")), links });
    const revised = await buildDocx({ body: p(r("Read the ") + link("rIdTerms", "published standard terms") + r(" first.")), links });
    const document = await reopen(await compareDocx(original, revised, OPTIONS));
    expect(describeRevisions(document)).toEqual([["insert", "text", "standard "]]);
    const runs = runsOf(document, 0);
    expect(runs.filter((run) => run.hyperlink?.href === "https://example.com/terms").map((run) => run.text)).toEqual(["published ", "standard ", "terms"]);
    await expectResolves(document, original, revised);
  });

  it("copies an image of an inserted paragraph into the result", async () => {
    const original = await buildDocx({ body: p(r("Opening words stay the same.")) + p(r("Closing words stay the same.")) });
    const revised = await buildDocx({
      body: p(r("Opening words stay the same.")) + p(r("Our seal: ") + picture("rIdSeal")) + p(r("Closing words stay the same.")),
      images: { rIdSeal: PNG(1) },
    });
    const document = await reopen(await compareDocx(original, revised, OPTIONS));
    const image = runsOf(document, 1).find((run) => run.object?.kind === "image");
    if (image?.object?.kind !== "image" || image.object.partName === null) throw new Error("the image did not arrive");
    expect(image.revision?.kind).toBe("insert");
    expect(image.object.contentType).toBe("image/png");
    expect(Buffer.from(await document.package.getPartBytes(image.object.partName)).equals(Buffer.from(PNG(1)))).toBe(true);
    await expectResolves(document, original, revised);
  });

  it("sees the same picture as unchanged and another picture as a replacement", async () => {
    const body = p(r("Our seal: ") + picture("rIdSeal") + r(" as agreed."));
    const original = await buildDocx({ body, images: { rIdSeal: PNG(1) } });
    const same = await buildDocx({ body: body.replace(/rIdSeal/g, "rIdOther"), images: { rIdOther: PNG(1) } });
    expect((await compareDocxDetailed(original, same, OPTIONS)).summary.identical).toBe(true);
    const other = await buildDocx({ body, images: { rIdSeal: PNG(2) } });
    const document = await reopen(await compareDocx(original, other, OPTIONS));
    expect(describeRevisions(document).map(([kind]) => kind)).toEqual(["delete", "insert"]);
    const images = runsOf(document, 0).filter((run) => run.object?.kind === "image");
    expect(images.map((run) => run.revision?.kind)).toEqual(["delete", "insert"]);
    const parts = images.map((run) => (run.object?.kind === "image" ? run.object.partName : null));
    expect(new Set(parts).size).toBe(2);
    expect(Buffer.from(await document.package.getPartBytes(parts[1] as string)).equals(Buffer.from(PNG(2)))).toBe(true);
  });

  it("drops a style the original does not define and keeps one it does", async () => {
    const styles = (ids: string[]): string =>
      ids.map((id) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${id}"/><w:pPr><w:jc w:val="right"/></w:pPr></w:style>`).join("");
    const original = await buildDocx({ body: p(r("Opening words stay the same.")), styles: styles(["Known"]) });
    const revised = await buildDocx({
      body: p(r("Opening words stay the same.")) + p(r("A paragraph in a known style."), `<w:pStyle w:val="Known"/>`) + p(r("A paragraph in a foreign style."), `<w:pStyle w:val="Foreign"/>`),
      styles: styles(["Known", "Foreign"]),
    });
    const document = await reopen(await compareDocx(original, revised, OPTIONS));
    const blocks = document.getView().body.blocks as ParagraphBlock[];
    expect(blocks.map((block) => block.style.styleId)).toEqual([null, "Known", null]);
    expect(await document.package.getPartText("/word/document.xml")).not.toContain("Foreign");
    await expectResolves(document, original, revised);
  });

  it("keeps the style of the original where the revised paragraph and run use styles it does not define", async () => {
    const style = (type: string, id: string): string => `<w:style w:type="${type}" w:styleId="${id}"><w:name w:val="${id}"/></w:style>`;
    const original = await buildDocx({
      body: p(r("A clause in the house style, ") + r("emphasised", `<w:rStyle w:val="Strong"/>`) + r(" as usual."), `<w:pStyle w:val="Clause"/>`),
      styles: style("paragraph", "Clause") + style("character", "Strong"),
    });
    const revised = await buildDocx({
      body: p(r("A clause in the house style, ") + r("emphasised", `<w:rStyle w:val="Emphatic"/>`) + r(" as always."), `<w:pStyle w:val="Imported"/>`),
      styles: style("paragraph", "Imported") + style("character", "Emphatic"),
    });
    const document = await reopen(await compareDocx(original, revised, OPTIONS));
    expect(describeRevisions(document)).toEqual([
      ["delete", "text", "usual"],
      ["insert", "text", "always"],
    ]);
    expect((document.getView().body.blocks[0] as ParagraphBlock).style.styleId).toBe("Clause");
    expect(await document.package.getPartText("/word/document.xml")).toContain(`<w:rStyle w:val="Strong"/>`);
  });

  it("gives a carried bookmark a free id and drops one whose name is taken", async () => {
    const bookmark = (id: number, name: string, content: string): string => `<w:bookmarkStart w:id="${id}" w:name="${name}"/>${content}<w:bookmarkEnd w:id="${id}"/>`;
    const original = await buildDocx({ body: p(bookmark(1, "Intro", r("Opening words stay the same."))) + p(r("Closing words stay the same.")) });
    const revised = await buildDocx({
      body:
        p(bookmark(1, "Intro", r("Opening words stay the same."))) +
        p(bookmark(1, "Fresh", r("A new clause with a bookmark.")) + bookmark(2, "Intro", r(" And a clash."))) +
        p(r("Closing words stay the same.")),
    });
    const document = await reopen(await compareDocx(original, revised, OPTIONS));
    const xml = await document.package.getPartText("/word/document.xml");
    const starts = [...xml.matchAll(/<w:bookmarkStart w:id="(\d+)" w:name="([^"]+)"/g)].map((match) => [match[1], match[2]]);
    expect(starts.map(([, name]) => name).sort()).toEqual(["Fresh", "Intro"]);
    expect(new Set(starts.map(([id]) => id)).size).toBe(2);
    expect((xml.match(/<w:bookmarkEnd /g) ?? []).length).toBe(2);
    expect((document.getView().body.blocks[1] as ParagraphBlock).bookmarks).toEqual(["Fresh"]);
  });

  it("keeps the comments of the original and their anchors when the text around them changes", async () => {
    const source = await openDocx(loadFixture("comments.docx"));
    const text = await source.package.getPartText("/word/document.xml");
    const sample = /<w:t(?: [^>]*)?>([A-Za-z][^<]{10,})<\/w:t>/.exec(text)?.[1];
    if (sample === undefined) throw new Error("fixture has no text");
    source.package.setPart("/word/document.xml", text.replace(`>${sample}<`, `>Changed opening. ${sample}<`));
    const revised = await source.package.save();
    const document = await reopen(await compareDocx(loadFixture("comments.docx"), revised, OPTIONS));
    const before = (await openDocx(loadFixture("comments.docx"))).listComments();
    expect(document.listComments().map((comment) => [comment.id, comment.text, comment.anchorText])).toEqual(
      before.map((comment) => [comment.id, comment.text, comment.anchorText]),
    );
    expect(views(document).final).toBe((await openDocx(revised)).getPlainText());
    expect(describeRevisions(document)).toContainEqual(["insert", "text", "Changed opening. "]);
  });

  it("keeps a section break where it is when the paragraph that carries it changes", async () => {
    const section = `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>`;
    const original = await buildDocx({ body: p(r("First section opens here.")) + p(r("First section ends here."), section) + p(r("Second section text.")) });
    const revised = await buildDocx({ body: p(r("First section opens here.")) + p(r("Something else entirely now!"), section) + p(r("Second section text.")) });
    const document = await reopen(await compareDocx(original, revised, OPTIONS));
    expect(document.getView().sections).toHaveLength(2);
    expect(document.getView().body.blocks.filter((block) => block.type === "sectionBreak")).toHaveLength(1);
    expect(views(document).final).toBe((await openDocx(revised)).getPlainText());
    expect(views(document).original).toBe((await openDocx(original)).getPlainText());
  });
});
