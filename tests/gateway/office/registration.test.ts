import { afterEach, describe, expect, it } from "vitest";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { DocumentDescribeReplySchema } from "../../../packages/contracts/src/office-documents";
import { registerOfficeDocumentRoutes } from "../../../packages/gateway/src/office/routes";
import { FIXTURES } from "./helpers";

let home: string | null = null;
afterEach(async () => { if (home) await rm(home, { recursive: true, force: true }); home = null; });

describe("registerOfficeDocumentRoutes", () => {
  it("mounts the document service under /api/office", async () => {
    home = await mkdtemp(join(tmpdir(), "office-register-"));
    await mkdir(join(home, "docs"));
    await copyFile(join(FIXTURES, "basic.docx"), join(home, "docs", "basic.docx"));
    const app = new Hono();
    registerOfficeDocumentRoutes(app, { homePath: home });
    const response = await app.request("/api/office/documents/describe", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "docs/basic.docx" }),
    });
    expect(response.status).toBe(200);
    expect(DocumentDescribeReplySchema.parse(await response.json()).blockIds).toContain("b1");
  });

  it("does not answer GET", async () => {
    const app = new Hono();
    registerOfficeDocumentRoutes(app, { homePath: "/nonexistent" });
    expect((await app.request("/api/office/documents/describe")).status).toBe(404);
  });
});
