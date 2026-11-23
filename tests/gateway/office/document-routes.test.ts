import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  DocumentAddCommentReplySchema, DocumentCompareReplySchema, DocumentCreateReplySchema, DocumentDescribeReplySchema,
  DocumentProposeEditsReplySchema, DocumentReadTextReplySchema, DocumentResolveRevisionsReplySchema,
  DocumentRevisionsListReplySchema,
} from "../../../packages/contracts/src/office-documents";
import { createOfficeHarness, FIXED_NOW, json, type OfficeHarness } from "./helpers";

let h: OfficeHarness;
beforeEach(async () => { h = await createOfficeHarness(); });
afterEach(async () => { await h.cleanup(); });

const AGENT = "Matrix Agent";

async function proposeReplace(path: string, extra: Record<string, unknown> = {}) {
  return h.post("/documents/propose-edits", {
    path, author: AGENT,
    edits: [{ op: "replaceText", blockId: "b3", find: "three priorities", replace: "four priorities" }],
    ...extra,
  });
}

describe("POST /api/office/documents/describe", () => {
  it("returns the outline and id-tagged text marked untrusted, with the file version", async () => {
    const path = await h.copyFixture("basic.docx");
    const response = await h.post("/documents/describe", { path, maxChars: 4000 });
    expect(response.status).toBe(200);
    const body = DocumentDescribeReplySchema.parse(await json(response));
    expect(body.trust).toBe("untrusted");
    expect(body.text).toContain("# Outline");
    expect(body.text).toContain("[b3] This review covers the third quarter");
    expect(body.outline.map((item) => item.text)).toEqual(["Summary", "Details", "Revenue", "Costs"]);
    expect(body.blockIds).toContain("b3");
    expect(body.truncated).toBe(false);
    expect(body.version).toMatch(/^v1\./);
  });

  it("truncates to maxChars and names the next block", async () => {
    const path = await h.copyFixture("basic.docx");
    const body = DocumentDescribeReplySchema.parse(await json(await h.post("/documents/describe", { path, maxChars: 300 })));
    expect(body.truncated).toBe(true);
    expect(body.nextBlockId).not.toBeNull();
    expect(body.text.length).toBeLessThanOrEqual(300);
  });
});

describe("POST /api/office/documents/read-text", () => {
  it("reads blocks by id and reports unknown ids", async () => {
    const path = await h.copyFixture("basic.docx");
    const response = await h.post("/documents/read-text", { path, blockIds: ["b3", "b7", "b999"] });
    expect(response.status).toBe(200);
    const body = DocumentReadTextReplySchema.parse(await json(response));
    expect(body.blocks.map((block) => block.blockId)).toEqual(["b3", "b7"]);
    expect(body.blocks[0]!.text).toBe("This review covers the third quarter and highlights three priorities that need owner approval.");
    expect(body.missingBlockIds).toEqual(["b999"]);
    expect(body.trust).toBe("untrusted");
  });

  it("reads a text range", async () => {
    const path = await h.copyFixture("basic.docx");
    const body = DocumentReadTextReplySchema.parse(await json(await h.post("/documents/read-text", {
      path, range: { start: { blockId: "b3", offset: 5 }, end: { blockId: "b3", offset: 11 } },
    })));
    expect(body.text).toBe("review");
  });
});

describe("POST /api/office/documents/propose-edits", () => {
  it("saves the edits as tracked revisions by the agent and returns the new version", async () => {
    const path = await h.copyFixture("basic.docx");
    const before = DocumentDescribeReplySchema.parse(await json(await h.post("/documents/describe", { path }))).version;
    const response = await h.post("/documents/propose-edits", {
      path, author: AGENT,
      edits: [
        { op: "replaceText", blockId: "b3", find: "three priorities", replace: "four priorities" },
        { op: "insertParagraph", blockId: "b8", text: "A new closing note from the agent." },
        { op: "replaceText", blockId: "b7", find: "not in the paragraph", replace: "x" },
      ],
    });
    expect(response.status).toBe(200);
    const body = DocumentProposeEditsReplySchema.parse(await json(response));
    expect(body.saved).toBe(true);
    expect(body.version).not.toBe(before);
    expect(body.appliedEdits.sort()).toEqual([0, 1]);
    expect(body.rejected).toEqual([{ index: 2, code: "stale_reference" }]);
    expect(body.revisionIds.length).toBeGreaterThan(0);

    const saved = await h.docx(path);
    const revisions = saved.listRevisions();
    expect(revisions.length).toBeGreaterThan(0);
    expect(revisions.every((revision) => revision.author === AGENT && revision.date === FIXED_NOW.toISOString())).toBe(true);
    expect(saved.getPlainText({ view: "final" })).toContain("four priorities");
    expect(saved.getPlainText({ view: "final" })).toContain("A new closing note from the agent.");
    expect(saved.getPlainText({ view: "original" })).toContain("three priorities");
    expect(saved.getPlainText({ view: "original" })).not.toContain("A new closing note");
  });

  // Fault detected: the reply named the engine's in-memory revision ids, which the saved file numbers
  // differently, so accepting or rejecting exactly what was just proposed answered stale_reference.
  it("returns the revision ids the saved file lists, so a later proposal can be resolved on its own", async () => {
    const path = await h.copyFixture("basic.docx");
    const propose = async (blockId: string, find: string, replace: string) => DocumentProposeEditsReplySchema.parse(await json(
      await h.post("/documents/propose-edits", { path, author: AGENT, edits: [{ op: "replaceText", blockId, find, replace }] }),
    ));
    const first = await propose("b3", "three priorities", "four priorities");
    const listIds = async () => (await h.docx(path)).listRevisions().map((revision) => revision.id);
    expect([...first.revisionIds].sort()).toEqual((await listIds()).sort());

    const second = await propose("b1", "Quarterly", "Annual");
    const all = await listIds();
    expect(second.revisionIds.length).toBeGreaterThan(0);
    expect(second.revisionIds.every((id) => all.includes(id))).toBe(true);
    expect(all.length).toBe(first.revisionIds.length + second.revisionIds.length);

    const rejected = await h.post("/documents/revisions/reject", { path, ids: second.revisionIds });
    expect(rejected.status).toBe(200);
    const after = await h.docx(path);
    expect(after.listRevisions()).toHaveLength(first.revisionIds.length);
    expect(after.getPlainText({ view: "final" })).toContain("four priorities");
    expect(after.getPlainText({ view: "final" })).not.toContain("Annual");
  });

  it("does not write the file when no edit resolves", async () => {
    const path = await h.copyFixture("basic.docx");
    const { mtimeMs } = await stat(join(h.home, path));
    const body = DocumentProposeEditsReplySchema.parse(await json(await h.post("/documents/propose-edits", {
      path, author: AGENT, edits: [{ op: "replaceText", blockId: "b404", find: "x", replace: "y" }],
    })));
    expect(body.saved).toBe(false);
    expect(body.rejected).toEqual([{ index: 0, code: "not_found" }]);
    expect((await stat(join(h.home, path))).mtimeMs).toBe(mtimeMs);
  });

  it("adds comments through a comment edit", async () => {
    const path = await h.copyFixture("basic.docx");
    const body = DocumentProposeEditsReplySchema.parse(await json(await h.post("/documents/propose-edits", {
      path, author: AGENT, edits: [{ op: "comment", blockId: "b8", find: "unaudited", text: "Check with finance." }],
    })));
    expect(body.commentIds).toHaveLength(1);
    const comments = (await h.docx(path)).listComments();
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ author: AGENT, text: "Check with finance.", anchorText: "unaudited" });
  });
});

describe("revisions list, accept and reject", () => {
  it("lists the pending revisions of a document", async () => {
    const path = await h.copyFixture("tracked.docx");
    const body = DocumentRevisionsListReplySchema.parse(await json(await h.post("/documents/revisions/list", { path })));
    const engine = (await h.docx(path)).listRevisions();
    expect(body.total).toBe(engine.length);
    expect(body.revisions.map((revision) => revision.id)).toEqual(engine.map((revision) => revision.id));
    expect(new Set(body.revisions.map((revision) => revision.author))).toEqual(new Set(["Alex Morgan", "Priya Shah"]));
    expect(body.trust).toBe("untrusted");
  });

  it("accepts one revision and keeps the others pending", async () => {
    const path = await h.copyFixture("basic.docx");
    await proposeReplace(path);
    const listed = DocumentRevisionsListReplySchema.parse(await json(await h.post("/documents/revisions/list", { path })));
    const target = listed.revisions.find((revision) => revision.kind === "insert")!;
    const response = await h.post("/documents/revisions/accept", { path, ids: [target.id], ifVersion: listed.version });
    expect(response.status).toBe(200);
    const body = DocumentResolveRevisionsReplySchema.parse(await json(response));
    expect(body.resolvedIds).toContain(target.id);
    const saved = await h.docx(path);
    expect(saved.listRevisions().length).toBe(listed.total - body.resolvedIds.length);
    expect(saved.getPlainText({ view: "original" })).toContain("four");
  });

  it("rejects all revisions and restores the original text", async () => {
    const path = await h.copyFixture("basic.docx");
    await proposeReplace(path);
    const body = DocumentResolveRevisionsReplySchema.parse(await json(await h.post("/documents/revisions/reject", { path, ids: "all" })));
    expect(body.resolvedIds.length).toBeGreaterThan(0);
    const saved = await h.docx(path);
    expect(saved.listRevisions()).toEqual([]);
    expect(saved.getPlainText()).toContain("three priorities");
    expect(saved.getPlainText()).not.toContain("four priorities");
  });

  it("answers an unknown revision id with stale_reference and leaves the file alone", async () => {
    const path = await h.copyFixture("tracked.docx");
    const before = await h.bytes(path);
    const response = await h.post("/documents/revisions/accept", { path, ids: ["r-unknown"] });
    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({ error: "stale_reference" });
    expect(await h.bytes(path)).toEqual(before);
  });
});

describe("POST /api/office/documents/comments/add", () => {
  it("anchors a comment and saves it", async () => {
    const path = await h.copyFixture("basic.docx");
    const response = await h.post("/documents/comments/add", { path, blockId: "b10", find: "Hiring was paused", text: "Why?", author: AGENT });
    expect(response.status).toBe(200);
    const body = DocumentAddCommentReplySchema.parse(await json(response));
    const comments = (await h.docx(path)).listComments();
    expect(comments.map((comment) => comment.id)).toContain(body.commentId);
    expect(comments.find((comment) => comment.id === body.commentId)).toMatchObject({ text: "Why?", anchorText: "Hiring was paused" });
  });

  it("answers quoted text that is not there with stale_reference", async () => {
    const path = await h.copyFixture("basic.docx");
    const response = await h.post("/documents/comments/add", { path, blockId: "b10", find: "nowhere", text: "?", author: AGENT });
    expect(response.status).toBe(409);
  });
});

describe("POST /api/office/documents/compare", () => {
  it("writes a new document whose differences are tracked revisions", async () => {
    const originalPath = await h.copyFixture("contract.docx");
    const revisedPath = await h.copyFixture("contract-v2.docx");
    const outputPath = "docs/out/contract-compare.docx";
    const response = await h.post("/documents/compare", { originalPath, revisedPath, outputPath, author: AGENT });
    expect(response.status).toBe(200);
    const body = DocumentCompareReplySchema.parse(await json(response));
    expect(body.identical).toBe(false);
    const result = await h.docx(outputPath);
    expect(result.listRevisions().length).toBe(body.revisionCount);
    expect(body.revisionCount).toBeGreaterThan(0);
    const revised = await h.docx(revisedPath);
    expect(result.getPlainText({ view: "final" })).toBe(revised.getPlainText({ view: "final" }));
  });

  it("refuses to overwrite an existing output", async () => {
    const originalPath = await h.copyFixture("contract.docx");
    const revisedPath = await h.copyFixture("contract-v2.docx");
    const response = await h.post("/documents/compare", { originalPath, revisedPath, outputPath: revisedPath });
    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({ error: "file_exists" });
  });
});

describe("POST /api/office/documents/create", () => {
  it("creates a document from markdown", async () => {
    const response = await h.post("/documents/create", { path: "docs/new/plan.docx", markdown: "# Plan\n\nShip the **office** suite." });
    expect(response.status).toBe(200);
    const body = DocumentCreateReplySchema.parse(await json(response));
    expect(body.size).toBeGreaterThan(0);
    const created = await h.docx("docs/new/plan.docx");
    expect(created.getOutline().map((item) => item.text)).toEqual(["Plan"]);
    expect(created.getPlainText()).toContain("Ship the office suite.");
  });

  it("creates a document from paragraphs", async () => {
    await h.post("/documents/create", { path: "docs/notes.docx", paragraphs: ["One", "Two"] });
    expect((await h.docx("docs/notes.docx")).getPlainText()).toBe("One\nTwo\n");
  });

  it("refuses to replace an existing file", async () => {
    const path = await h.copyFixture("basic.docx");
    const response = await h.post("/documents/create", { path, paragraphs: ["x"] });
    expect(response.status).toBe(409);
    expect((await h.docx(path)).getPlainText()).toContain("Quarterly Operations Review");
  });
});
