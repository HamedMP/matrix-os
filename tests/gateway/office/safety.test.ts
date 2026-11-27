import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DocumentDescribeReplySchema, DocumentProposeEditsReplySchema, OFFICE_DOCUMENT_MAX_BYTES, SheetProposeEditsReplySchema,
} from "../../../packages/contracts/src/office-documents";
import { createOfficeHarness, json, type OfficeHarness } from "./helpers";

let h: OfficeHarness;
beforeEach(async () => { h = await createOfficeHarness(); });
afterEach(async () => { await h.cleanup(); });

const AGENT = "Matrix Agent";

describe("request validation", () => {
  it.each([
    ["not json", "{"],
    ["unknown field", JSON.stringify({ path: "docs/basic.docx", extra: 1 })],
    ["wrong extension", JSON.stringify({ path: "docs/basic.txt" })],
    ["missing path", JSON.stringify({})],
    ["bad maxChars", JSON.stringify({ path: "docs/basic.docx", maxChars: 0 })],
  ])("answers %s with a generic 400", async (_name, body) => {
    await h.copyFixture("basic.docx");
    const response = await h.postRaw("/documents/describe", body);
    expect(response.status).toBe(400);
    const reply = await json(response);
    expect(reply).toEqual({ error: "invalid_request", message: "Invalid request" });
  });

  it("validates the agent edit envelope", async () => {
    const path = await h.copyFixture("basic.docx");
    const response = await h.post("/documents/propose-edits", {
      path, author: AGENT, edits: [{ op: "replaceText", blockId: "b3", find: "", replace: "x" }],
    });
    expect(response.status).toBe(400);
    const unknownOp = await h.post("/documents/propose-edits", { path, author: AGENT, edits: [{ op: "deleteAll", blockId: "b3" }] });
    expect(unknownOp.status).toBe(400);
  });

  it("refuses a request body over the limit", async () => {
    await h.copyFixture("basic.docx");
    const response = await h.postRaw("/documents/describe", JSON.stringify({ path: "docs/basic.docx", pad: "x".repeat(3 * 1024 * 1024) }));
    expect(response.status).toBe(413);
  });

  it("only answers POST", async () => {
    const response = await h.postRaw("/documents/unknown", "{}");
    expect(response.status).toBe(404);
  });
});

describe("path safety", () => {
  it.each(["../outside.docx", "/etc/passwd.docx", "docs/../../x.docx", "docs//x.docx"])("rejects %s at the boundary", async (path) => {
    const response = await h.post("/documents/describe", { path });
    expect(response.status).toBe(400);
  });

  it.each(["system/secret.docx", ".hidden/notes.docx", "agents/plan.docx"])("refuses the protected path %s", async (path) => {
    await h.copyFixture("basic.docx", path);
    const read = await h.post("/documents/describe", { path });
    expect(read.status).toBe(403);
    const create = await h.post("/documents/create", { path: path.replace(".docx", "-new.docx"), paragraphs: ["x"] });
    expect(create.status).toBe(403);
  });

  it("answers a denied subtree like a missing file", async () => {
    const path = await h.copyFixture("basic.docx", "data/browser-profiles/a.docx");
    const response = await h.post("/documents/describe", { path });
    expect(response.status).toBe(404);
  });

  it("refuses a symlink, even one that points inside home", async () => {
    const outside = await mkdtemp(join(tmpdir(), "office-outside-"));
    try {
      await writeFile(join(outside, "x.docx"), "outside");
      await symlink(join(outside, "x.docx"), join(h.home, "docs", "link.docx"));
      expect((await h.post("/documents/describe", { path: "docs/link.docx" })).status).toBe(403);
      await h.copyFixture("basic.docx");
      await symlink(join(h.home, "docs", "basic.docx"), join(h.home, "docs", "inner.docx"));
      expect((await h.post("/documents/describe", { path: "docs/inner.docx" })).status).toBe(403);
      await symlink(join(h.home, "system"), join(h.home, "docs", "sys"));
      expect((await h.post("/documents/create", { path: "docs/sys/new.docx", paragraphs: ["x"] })).status).toBe(403);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("answers a missing file with not_found without echoing the path", async () => {
    const response = await h.post("/documents/describe", { path: "docs/missing-file.docx" });
    expect(response.status).toBe(404);
    const text = await response.text();
    expect(text).not.toContain("missing-file");
  });
});

describe("file limits and damaged files", () => {
  it("refuses a file over 10 MiB", async () => {
    await writeFile(join(h.home, "docs", "big.docx"), new Uint8Array(OFFICE_DOCUMENT_MAX_BYTES + 1));
    const response = await h.post("/documents/describe", { path: "docs/big.docx" });
    expect(response.status).toBe(413);
  });

  it("answers a damaged document with unsupported_document and never overwrites it", async () => {
    await writeFile(join(h.home, "docs", "broken.docx"), "not a zip at all");
    const response = await h.post("/documents/propose-edits", {
      path: "docs/broken.docx", author: AGENT, edits: [{ op: "replaceText", blockId: "b1", find: "a", replace: "b" }],
    });
    expect(response.status).toBe(422);
    expect(await json(response)).toEqual({ error: "unsupported_document", message: "Unsupported or damaged document" });
    expect(new TextDecoder().decode(await h.bytes("docs/broken.docx"))).toBe("not a zip at all");
  });

  it("answers a workbook given as a document with unsupported_document", async () => {
    await h.copyFixture("model.xlsx", "docs/wrong.docx");
    expect((await h.post("/documents/describe", { path: "docs/wrong.docx" })).status).toBe(422);
  });
});

describe("versions and concurrency", () => {
  it("refuses an edit made against an older version", async () => {
    const path = await h.copyFixture("basic.docx");
    const { version } = DocumentDescribeReplySchema.parse(await json(await h.post("/documents/describe", { path })));
    await h.post("/documents/propose-edits", {
      path, author: AGENT, edits: [{ op: "replaceText", blockId: "b10", find: "flat", replace: "level" }],
    });
    const before = await h.bytes(path);
    const response = await h.post("/documents/propose-edits", {
      path, author: AGENT, ifVersion: version,
      edits: [{ op: "replaceText", blockId: "b3", find: "three", replace: "four" }],
    });
    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({ error: "version_conflict" });
    expect(await h.bytes(path)).toEqual(before);
  });

  it("refuses to clobber a save that lands while an edit is being computed", async () => {
    const racer = await createOfficeHarness({
      beforeCommit: async (absolutePath) => { await writeFile(absolutePath, await h.bytes("docs/basic.docx")); },
    });
    try {
      const path = await racer.copyFixture("basic.docx");
      await h.copyFixture("tracked.docx", "docs/basic.docx");
      const response = await racer.post("/documents/propose-edits", {
        path, author: AGENT, edits: [{ op: "replaceText", blockId: "b3", find: "three", replace: "four" }],
      });
      expect(response.status).toBe(409);
      expect((await racer.docx(path)).listRevisions().length).toBe((await h.docx("docs/basic.docx")).listRevisions().length);
    } finally {
      await racer.cleanup();
    }
  });

  it("serialises concurrent edits to one document so both land", async () => {
    const path = await h.copyFixture("basic.docx");
    const [first, second] = await Promise.all([
      h.post("/documents/propose-edits", { path, author: "Agent One", edits: [{ op: "replaceText", blockId: "b3", find: "three", replace: "four" }] }),
      h.post("/documents/propose-edits", { path, author: "Agent Two", edits: [{ op: "replaceText", blockId: "b10", find: "flat", replace: "level" }] }),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    DocumentProposeEditsReplySchema.parse(await json(first));
    const saved = await h.docx(path);
    const text = saved.getPlainText({ view: "final" });
    expect(text).toContain("four priorities");
    expect(text).toContain("stayed level");
    expect(new Set(saved.listRevisions().map((revision) => revision.author))).toEqual(new Set(["Agent One", "Agent Two"]));
  });

  it("serialises concurrent sheet proposals so both land", async () => {
    const path = await h.copyFixture("model.xlsx");
    const results = await Promise.all([1, 2, 3].map((n) => h.post("/sheets/propose-edits", {
      path, author: AGENT, label: `Edit ${n}`, edits: [{ op: "setCell", sheet: "Summary", cell: `D${n}`, value: n }],
    })));
    for (const result of results) SheetProposeEditsReplySchema.parse(await json(result));
    const saved = await h.xlsx(path);
    expect(saved.listChanges()).toHaveLength(3);
    expect(saved.listProposals().map((proposal) => proposal.label).sort()).toEqual(["Edit 1", "Edit 2", "Edit 3"]);
  });
});

describe("misconfiguration", () => {
  it.each([null, ""])("answers 503 when the home path is %j", async (homePath) => {
    const broken = await createOfficeHarness({ homePath });
    try {
      const response = await broken.post("/documents/describe", { path: "docs/basic.docx" });
      expect(response.status).toBe(503);
      expect(await json(response)).toEqual({ error: "unavailable", message: "Document service unavailable" });
    } finally {
      await broken.cleanup();
    }
  });

  it("serves documents when the configured home is a link to the real home", async () => {
    const path = await h.copyFixture("basic.docx");
    const linkedHome = join(tmpdir(), `office-linked-home-${Date.now()}`);
    await symlink(h.home, linkedHome);
    const linked = await createOfficeHarness({ homePath: linkedHome });
    try {
      const response = await linked.post("/documents/describe", { path });
      expect(response.status).toBe(200);
      DocumentDescribeReplySchema.parse(await json(response));
    } finally {
      await linked.cleanup();
      await rm(linkedHome, { force: true });
    }
  });

  it("answers 503 when the home directory is missing", async () => {
    const missing = join(tmpdir(), `office-missing-${Date.now()}`);
    const broken = await createOfficeHarness({ homePath: missing });
    try {
      expect((await broken.post("/documents/describe", { path: "docs/basic.docx" })).status).toBe(503);
    } finally {
      await broken.cleanup();
    }
  });
});

