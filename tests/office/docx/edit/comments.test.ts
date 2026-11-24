import { describe, expect, it } from "vitest";

import type { DocxDocument } from "../../../../packages/office/src/api/docx.js";
import { isOfficeError } from "../../../../packages/office/src/errors.js";
import { p, r } from "../model/build.js";
import { DATE, DIRECT, RAE, TRACKED, blockXml, bodyXml, build, openFixture, paragraphs, reopen, text } from "./helpers.js";

const LINK =
  '<w:hyperlink r:id="rIdLink"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>the terms</w:t></w:r></w:hyperlink>';

function make(body: string, extra: Record<string, string> = {}): { doc: DocxDocument; ids: string[] } {
  const doc = build({ body, links: { rIdLink: "https://example.com/terms" }, ...extra });
  return { doc, ids: paragraphs(doc).map((block) => block.id) };
}

const range = (a: string, from: number, b: string, to: number) => ({
  start: { blockId: a, offset: from },
  end: { blockId: b, offset: to },
});

function code(doc: DocxDocument, op: unknown): string {
  try {
    doc.applyOps([op as never], DIRECT);
  } catch (error) {
    return isOfficeError(error) ? error.code : "other";
  }
  return "none";
}

describe("addComment", () => {
  it("anchors a comment to a range and creates the comments part", async () => {
    const { doc, ids } = make(p(r("Payment is due within 30 days.")));
    const id = ids[0] as string;
    const result = doc.applyOps(
      [{ type: "addComment", range: range(id, 22, id, 29), text: "Should this be 45?\nCheck with finance." }],
      { ...TRACKED, initials: "RO" },
    );
    expect(blockXml(doc, id)).toBe(
      '<w:p><w:r><w:t xml:space="preserve">Payment is due within </w:t></w:r><w:commentRangeStart w:id="0"/>' +
        '<w:r><w:t xml:space="preserve">30 days</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>' +
        '<w:r><w:t xml:space="preserve">.</w:t></w:r></w:p>',
    );
    expect(result.results[0]).toEqual({ type: "addComment", revisionIds: [], createdBlockIds: [], commentId: "0", caret: null });
    expect(result.changedBlockIds).toEqual([id]);
    // A comment is never a tracked change, whatever the mode.
    expect(doc.listRevisions()).toEqual([]);
    expect(text(doc, "markup")).toBe("Payment is due within 30 days.\n");
    const expected = {
      id: "0",
      parentId: null,
      author: RAE,
      initials: "RO",
      date: DATE,
      text: "Should this be 45?\nCheck with finance.",
      range: range(id, 22, id, 29),
      anchorText: "30 days",
      resolved: false,
    };
    expect(doc.listComments()).toEqual([expected]);
    const block = doc.getBlock(id);
    expect(block?.type === "paragraph" && block.runs.map((run) => [run.text, run.commentIds])).toEqual([
      ["Payment is due within ", []],
      ["30 days", ["0"]],
      [".", []],
    ]);

    const again = await reopen(doc);
    expect(again.listComments().map((comment) => ({ ...comment, range: null }))).toEqual([{ ...expected, range: null }]);
    expect(again.package.hasPart("/word/comments.xml")).toBe(true);
    expect(again.package.getContentType("/word/comments.xml")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml",
    );
    const relationships = again.package.getRelationships("/word/document.xml").filter((entry) => entry.type.endsWith("/comments"));
    expect(relationships.map((entry) => entry.target)).toEqual(["comments.xml"]);
    const xml = await again.package.getPartText("/word/comments.xml");
    expect(xml).toMatch(
      /<w:comment w:id="0" w:author="Rae Okafor" w:date="2026-11-23T10:00:00Z" w:initials="RO"><w:p w14:paraId="[0-9A-F]{8}"><w:r><w:annotationRef\/><\/w:r><w:r><w:t>Should this be 45\?<\/w:t><\/w:r><\/w:p><w:p w14:paraId="[0-9A-F]{8}"><w:r><w:t>Check with finance\.<\/w:t><\/w:r><\/w:p><\/w:comment>/,
    );
  });

  it("derives initials from the author and uses the comment styles when the document has them", () => {
    const styles =
      '<w:style w:type="paragraph" w:styleId="CommentText"><w:name w:val="annotation text"/></w:style>' +
      '<w:style w:type="character" w:styleId="CommentReference"><w:name w:val="annotation reference"/></w:style>';
    const { doc, ids } = make(p(r("Some text")), { styles });
    const id = ids[0] as string;
    doc.applyOps([{ type: "addComment", range: range(id, 0, id, 4), text: "note" }], DIRECT);
    expect(doc.listComments()[0]?.initials).toBe("RO");
    expect(blockXml(doc, id)).toContain('<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>');
  });

  it("anchors across runs, links and paragraphs", () => {
    const { doc, ids } = make(p(r("See ") + LINK + r(" for details.")) + p(r("Second paragraph.")));
    const [first, second] = ids as [string, string];
    doc.applyOps(
      [
        { type: "addComment", range: range(first, 8, second, 6), text: "across" },
        { type: "addComment", range: range(first, 2, first, 7), text: "into the link" },
      ],
      DIRECT,
    );
    expect(doc.listComments().map((comment) => [comment.id, comment.anchorText, comment.range])).toEqual([
      ["1", "e the", range(first, 2, first, 7)],
      ["0", "terms for details.\nSecond", range(first, 8, second, 6)],
    ]);
    // Reference runs sit in the paragraph, never inside the link.
    expect(blockXml(doc, first)).not.toMatch(/<w:hyperlink[^>]*>(?:(?!<\/w:hyperlink>).)*commentReference/);
    expect(text(doc, "markup")).toBe("See the terms for details.\nSecond paragraph.\n");
  });

  it("adds to an existing comments part with ids that are free", async () => {
    const doc = await openFixture("comments.docx");
    const before = doc.listComments();
    const target = paragraphs(doc).find((block) => block.text.length > 20 && block.runs.every((run) => run.commentIds.length === 0));
    if (target === undefined) throw new Error("no free paragraph");
    const result = doc.applyOps([{ type: "addComment", range: range(target.id, 0, target.id, 10), text: "A new thread" }], DIRECT);
    const created = result.results[0]?.commentId as string;
    expect(before.map((comment) => comment.id)).not.toContain(created);
    expect(doc.listComments()).toHaveLength(before.length + 1);
    const again = await reopen(doc);
    expect(again.listComments().map((comment) => comment.text)).toContain("A new thread");
    expect(again.listComments().filter((comment) => comment.parentId !== null)).toHaveLength(1);
  });

  it("rejects an empty range, bad text and ranges that are not siblings", () => {
    const { doc, ids } = make(p(r("Some text")));
    const id = ids[0] as string;
    const before = bodyXml(doc);
    expect(code(doc, { type: "addComment", range: range(id, 2, id, 2), text: "x" })).toBe("invalid_argument");
    expect(code(doc, { type: "addComment", range: range(id, 0, id, 4), text: 7 })).toBe("invalid_argument");
    expect(code(doc, { type: "addComment", range: range(id, 0, id, 4), text: "a\u0000b" })).toBe("invalid_argument");
    expect(code(doc, { type: "addComment", range: range(id, 0, id, 99), text: "x" })).toBe("stale_reference");
    expect(bodyXml(doc)).toEqual(before);
    expect(doc.listComments()).toEqual([]);
    expect(doc.package.hasPart("/word/comments.xml")).toBe(false);
  });
});

describe("replyComment and resolveComment", () => {
  it("threads a reply in commentsExtended and anchors it to the range of the thread", async () => {
    const doc = await openFixture("comments.docx");
    const [root] = doc.listComments();
    if (root === undefined) throw new Error("no comment");
    const existingReply = doc.listComments().find((comment) => comment.parentId === root.id);
    const result = doc.applyOps(
      [{ type: "replyComment", commentId: existingReply?.id ?? root.id, text: "Agreed." }],
      { ...DIRECT, date: "2026-12-01T09:00:00Z" },
    );
    const id = result.results[0]?.commentId as string;
    const reply = doc.listComments().find((comment) => comment.id === id);
    expect(reply).toMatchObject({ parentId: root.id, author: RAE, text: "Agreed.", range: root.range, anchorText: root.anchorText });
    const again = await reopen(doc);
    const thread = again.listComments().filter((comment) => comment.id === root.id || comment.parentId === root.id);
    expect(thread.map((comment) => comment.text)).toContain("Agreed.");
    expect(thread[thread.length - 1]?.text).toBe("Agreed.");
    const extended = await again.package.getPartText("/word/commentsExtended.xml");
    expect(extended.match(/w15:paraIdParent=/g)).toHaveLength(2);
    const body = await again.package.getPartText("/word/document.xml");
    expect(body).toContain(`<w:commentRangeStart w:id="${id}"/>`);
    expect(body).toContain(`<w:commentRangeEnd w:id="${id}"/>`);
    expect(body).toContain(`<w:commentReference w:id="${id}"/>`);
  });

  it("creates the threading part when the document has none", async () => {
    const { doc, ids } = make(p(r("Payment is due within 30 days.")));
    const id = ids[0] as string;
    doc.applyOps([{ type: "addComment", range: range(id, 0, id, 7), text: "Question" }], DIRECT);
    doc.applyOps([{ type: "replyComment", commentId: "0", text: "Answer" }], { ...DIRECT, author: "Jun Ito", date: "2026-11-24T10:00:00Z" });
    doc.applyOps([{ type: "replyComment", commentId: "1", text: "Thanks" }], { ...DIRECT, date: "2026-11-25T10:00:00Z" });
    expect(doc.listComments().map((comment) => [comment.id, comment.parentId, comment.author, comment.text, comment.anchorText])).toEqual([
      ["0", null, RAE, "Question", "Payment"],
      ["1", "0", "Jun Ito", "Answer", "Payment"],
      ["2", "0", RAE, "Thanks", "Payment"],
    ]);
    const again = await reopen(doc);
    expect(again.listComments().map((comment) => [comment.id, comment.parentId])).toEqual([["0", null], ["1", "0"], ["2", "0"]]);
    expect(again.package.getContentType("/word/commentsExtended.xml")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml",
    );
    expect(again.package.getRelationships("/word/document.xml").some((entry) => entry.type.endsWith("/commentsExtended"))).toBe(true);
  });

  it("marks a whole thread as done and reopens it", async () => {
    const doc = await openFixture("comments.docx");
    const [root] = doc.listComments();
    if (root === undefined) throw new Error("no comment");
    const reply = doc.listComments().find((comment) => comment.parentId === root.id);
    const other = doc.listComments().find((comment) => comment.parentId === null && comment.id !== root.id);
    const result = doc.applyOps([{ type: "resolveComment", commentId: reply?.id ?? root.id }], DIRECT);
    expect(result.results[0]).toMatchObject({ commentId: null, caret: null });
    const state = (document: DocxDocument): Array<[string, boolean]> => document.listComments().map((comment) => [comment.id, comment.resolved]);
    expect(state(doc).filter(([, resolved]) => resolved).map(([id]) => id).sort()).toEqual([root.id, reply?.id].filter(Boolean).sort());
    expect(state(doc).find(([id]) => id === other?.id)?.[1]).toBe(false);
    const again = await reopen(doc);
    expect(state(again)).toEqual(state(doc));
    again.applyOps([{ type: "resolveComment", commentId: root.id, resolved: false }], DIRECT);
    expect(state(again).every(([, resolved]) => !resolved)).toBe(true);
  });

  it("resolves a comment in a document without the threading part", async () => {
    const { doc, ids } = make(p(r("Some text here")));
    const id = ids[0] as string;
    doc.applyOps(
      [
        { type: "addComment", range: range(id, 0, id, 4), text: "note" },
        { type: "resolveComment", commentId: "0" },
      ],
      DIRECT,
    );
    expect(doc.listComments()[0]?.resolved).toBe(true);
    expect((await reopen(doc)).listComments()[0]?.resolved).toBe(true);
  });

  it("rejects unknown comments and leaves the document as it was", () => {
    const { doc, ids } = make(p(r("Some text here")));
    const id = ids[0] as string;
    doc.applyOps([{ type: "addComment", range: range(id, 0, id, 4), text: "note" }], DIRECT);
    expect(code(doc, { type: "replyComment", commentId: "41", text: "x" })).toBe("stale_reference");
    expect(code(doc, { type: "resolveComment", commentId: "41" })).toBe("stale_reference");
    expect(code(doc, { type: "resolveComment", commentId: "0", resolved: "yes" })).toBe("invalid_argument");
    expect(doc.listComments()).toHaveLength(1);
    expect(doc.listComments()[0]?.resolved).toBe(false);
  });
});
