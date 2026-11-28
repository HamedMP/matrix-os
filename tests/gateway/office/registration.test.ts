import { afterEach, describe, expect, it } from "vitest";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { DocumentDescribeReplySchema } from "../../../packages/contracts/src/office-documents";
import { createOfficeDocumentRoutes, registerOfficeDocumentRoutes } from "../../../packages/gateway/src/office/routes";
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

  it("mounts a given service instance, so agent tools and HTTP callers share one per-path lock", async () => {
    home = await mkdtemp(join(tmpdir(), "office-register-shared-"));
    await mkdir(join(home, "docs"));
    await copyFile(join(FIXTURES, "basic.docx"), join(home, "docs", "basic.docx"));
    const shared = createOfficeDocumentRoutes({ homePath: home });
    const app = new Hono();
    registerOfficeDocumentRoutes(app, shared);
    const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "docs/basic.docx" }) };
    const viaHttp = await app.request("/api/office/documents/describe", init);
    const viaTools = await shared.request("/documents/describe", init);
    expect(viaHttp.status).toBe(200);
    expect(viaTools.status).toBe(200);
    const sharedHandlers = new Set(shared.routes.map((route) => route.handler));
    expect(app.routes.length).toBeGreaterThan(0);
    expect(app.routes.every((route) => sharedHandlers.has(route.handler))).toBe(true);
  });

  it("does not answer GET", async () => {
    const app = new Hono();
    registerOfficeDocumentRoutes(app, { homePath: "/nonexistent" });
    expect((await app.request("/api/office/documents/describe")).status).toBe(404);
  });
});
