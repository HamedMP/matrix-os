import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DOCUMENT_APPROVAL_IPC_TOOL_NAMES,
  DOCUMENT_IPC_TOOL_NAMES,
  DOCUMENT_TOOL_NAMES,
  documentToolDefinitions,
  type DocumentKernelTools,
} from "../../packages/kernel/src/tools/documents.js";
import { createOfficeDocumentRoutes } from "../../packages/gateway/src/office/routes.js";
import { runEngineOperation } from "../../packages/gateway/src/office/engine-operations.js";

const FIXTURES = fileURLToPath(new URL("../office/fixtures/", import.meta.url));
type ToolResult = { isError?: boolean; content: Array<{ type: "text"; text: string }> };

async function byName(tools: DocumentKernelTools, options?: { deadlineMs?: number }) {
  const definitions = await documentToolDefinitions(tools, options);
  return (name: string, input: unknown) => {
    const definition = definitions.find((candidate) => candidate.name === name);
    if (!definition) throw new Error(`missing ${name}`);
    return definition.handler(input) as Promise<ToolResult>;
  };
}

/** Parses the JSON inside a wrapped (untrusted) or plain tool reply. */
function payload(result: ToolResult): Record<string, unknown> {
  const text = result.content[0]!.text;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
}

function jsonReply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const ALL_NAMES = [
  "document_describe", "document_read_text", "document_propose_edits", "document_list_revisions",
  "document_accept_revisions", "document_reject_revisions", "document_add_comment", "document_compare",
  "document_create", "sheet_describe", "sheet_read_range", "sheet_propose_edits", "sheet_list_changes",
  "sheet_accept_changes", "sheet_reject_changes",
];

describe("document tool definitions", () => {
  // Fault detected: a tool is missing, misnamed, or an owner-only resolution is advertised as harmless.
  it("defines every document and sheet tool with honest annotations", async () => {
    const definitions = await documentToolDefinitions({ request: vi.fn() });
    expect(definitions.map((definition) => definition.name)).toEqual(ALL_NAMES);
    expect(DOCUMENT_TOOL_NAMES).toEqual(ALL_NAMES);
    expect(DOCUMENT_IPC_TOOL_NAMES).toEqual(ALL_NAMES.map((name) => `mcp__matrix-os-ipc__${name}`));
    expect(DOCUMENT_APPROVAL_IPC_TOOL_NAMES).toEqual([
      "mcp__matrix-os-ipc__document_accept_revisions", "mcp__matrix-os-ipc__document_reject_revisions",
      "mcp__matrix-os-ipc__sheet_accept_changes", "mcp__matrix-os-ipc__sheet_reject_changes",
    ]);
    const get = (name: string) => definitions.find((definition) => definition.name === name)!;
    for (const name of ["document_accept_revisions", "document_reject_revisions", "sheet_accept_changes", "sheet_reject_changes"]) {
      expect(get(name)).toMatchObject({ requiresApproval: true, annotations: { readOnlyHint: false, destructiveHint: true } });
    }
    for (const name of ["document_propose_edits", "sheet_propose_edits", "document_add_comment", "document_create", "document_compare"]) {
      expect(get(name)).toMatchObject({ requiresApproval: false, annotations: { readOnlyHint: false, destructiveHint: false } });
    }
    for (const name of ["document_describe", "document_read_text", "document_list_revisions", "sheet_describe", "sheet_read_range", "sheet_list_changes"]) {
      expect(get(name)).toMatchObject({ requiresApproval: false, annotations: { readOnlyHint: true, destructiveHint: false } });
    }
  });

  // Fault detected: malformed, oversized or out-of-home input reaches the document service.
  it("rejects unknown keys, traversal, wrong file types and oversized edit lists before the service", async () => {
    const request = vi.fn();
    const call = await byName({ request });
    const bad: Array<[string, unknown]> = [
      ["document_describe", { path: "docs/a.docx", extra: true }],
      ["document_describe", { path: "../outside.docx" }],
      ["document_describe", { path: "docs/a.xlsx" }],
      ["document_read_text", { path: "docs/a.docx" }],
      ["document_propose_edits", { path: "docs/a.docx", edits: Array.from({ length: 501 }, () => ({ op: "replaceText", blockId: "b1", find: "a", replace: "b" })) }],
      ["document_propose_edits", { path: "docs/a.docx", edits: [{ op: "dropTable", blockId: "b1" }] }],
      ["sheet_propose_edits", { path: "docs/a.csv", label: "x", edits: [{ op: "setCell", sheet: "Sheet1", cell: "A1", value: 1 }] }],
      ["sheet_accept_changes", { path: "docs/a.xlsx", ids: [] }],
      // Revision ids are renumbered when the file changes: without the listed version they could name another revision.
      ["document_accept_revisions", { path: "docs/a.docx", ids: ["rev2"] }],
      ["document_reject_revisions", { path: "docs/a.docx", ids: ["rev2"] }],
    ];
    for (const [name, input] of bad) {
      const result = await call(name, input);
      expect(result.isError, `${name} ${JSON.stringify(input).slice(0, 60)}`).toBe(true);
      expect(result.content[0]!.text).toContain("invalid_request");
    }
    expect(request).not.toHaveBeenCalled();
  });

  // Fault detected: the tool posts to the wrong route, drops defaults, or forgets the agent author.
  it("posts the validated body, with defaults and the agent author, to the matching route", async () => {
    const request = vi.fn(async () => jsonReply(200, {
      path: "docs/a.docx", version: "v1", saved: true, revisionIds: ["r1"], commentIds: [], appliedEdits: [0], rejected: [],
    }));
    const call = await byName({ request });
    const result = await call("document_propose_edits", {
      path: "docs/a.docx", edits: [{ op: "replaceText", blockId: "p1", find: "100", replace: "200" }],
    });
    expect(result.isError).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
    const [route, init] = request.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(route).toBe("/documents/propose-edits");
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    // The service gets less time than the tool waits, so it gives up (and never saves) before the tool reports busy.
    expect(init.headers["x-matrix-office-budget-ms"]).toBe("30000");
    expect(JSON.parse(init.body)).toEqual({
      path: "docs/a.docx", author: "Matrix OS", edits: [{ op: "replaceText", blockId: "p1", find: "100", replace: "200" }],
    });
    expect(payload(result)).toMatchObject({ revisionIds: ["r1"], saved: true });
  });

  // Fault detected: provider/file-system detail or a raw body reaches the model; failures look like success.
  it("maps service failures to generic coded errors", async () => {
    const cases: Array<[() => unknown, string]> = [
      [() => jsonReply(409, { error: "version_conflict", message: "File changed since it was read" }), "version_conflict"],
      [() => jsonReply(500, { error: "internal", message: "Document service error" }), "internal"],
      [() => jsonReply(500, { error: "internal", message: "Document service error", stack: "/home/matrix/secret" }), "unavailable"],
      [() => new Response("<html>proxy error /etc/passwd</html>", { status: 502 }), "unavailable"],
      [() => jsonReply(200, { unexpected: "shape" }), "internal"],
      [() => { throw new Error("ECONNREFUSED 127.0.0.1:4000"); }, "unavailable"],
      [() => new Response("x".repeat(64), { status: 200, headers: { "content-length": String(64 * 1024 * 1024) } }), "too_large"],
    ];
    for (const [reply, code] of cases) {
      const result = await (await byName({ request: vi.fn(async () => reply() as Response) }))("document_list_revisions", { path: "docs/a.docx" });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain(`(${code})`);
      expect(result.content[0]!.text).not.toMatch(/passwd|secret|ECONNREFUSED|127\.0\.0\.1/);
    }
  });

  // Fault detected: a hung document service blocks the agent turn forever.
  it("gives up on a service that never answers", async () => {
    const call = await byName({ request: () => new Promise<Response>(() => undefined) }, { deadlineMs: 20 });
    const result = await call("document_describe", { path: "docs/a.docx" });
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0]!.text).toContain("(busy)");
  });
});

describe("document tools against the real document service", () => {
  let home: string;
  let call: Awaited<ReturnType<typeof byName>>;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "document-tools-"));
    await Promise.all([mkdir(join(home, "system")), mkdir(join(home, "docs"))]);
    call = await byName(createOfficeDocumentRoutes({ homePath: home, clock: () => new Date("2026-11-23T10:00:00.000Z") }));
  });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  // Fault detected: agent edits land as silent overwrites instead of reviewable tracked revisions,
  // or document text reaches the model without the untrusted-content wrapper.
  it("creates, describes, proposes tracked edits, lists and accepts them", async () => {
    const created = await call("document_create", { path: "docs/terms.docx", markdown: "# Terms\n\nThe fee is 100 dollars per month." });
    expect(created.isError).toBeUndefined();

    const described = await call("document_describe", { path: "docs/terms.docx" });
    expect(described.content[0]!.text).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT>>>");
    const description = payload(described) as { blockIds: string[]; text: string; version: string };
    expect(description.text).toContain("100 dollars");
    expect(description.blockIds.length).toBeGreaterThanOrEqual(2);

    const read = payload(await call("document_read_text", { path: "docs/terms.docx", blockIds: description.blockIds })) as {
      blocks: Array<{ blockId: string; text: string }>;
    };
    const fee = read.blocks.find((block) => block.text.includes("100 dollars"))!;

    const proposed = payload(await call("document_propose_edits", {
      path: "docs/terms.docx", ifVersion: description.version,
      edits: [{ op: "replaceText", blockId: fee.blockId, find: "100", replace: "120" }],
    })) as { revisionIds: string[]; saved: boolean };
    expect(proposed.saved).toBe(true);
    expect(proposed.revisionIds.length).toBeGreaterThan(0);

    const listed = await call("document_list_revisions", { path: "docs/terms.docx" });
    expect(listed.content[0]!.text).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT>>>");
    const revisions = payload(listed) as { revisions: Array<{ author: string }>; total: number };
    expect(revisions.total).toBeGreaterThan(0);
    expect(revisions.revisions.every((revision) => revision.author === "Matrix OS")).toBe(true);

    const accepted = payload(await call("document_accept_revisions", { path: "docs/terms.docx", ids: "all" })) as { resolvedIds: string[] };
    expect(accepted.resolvedIds.length).toBe(revisions.total);
    const after = payload(await call("document_describe", { path: "docs/terms.docx" })) as { text: string; revisionCount: number };
    expect(after.revisionCount).toBe(0);
    expect(after.text).toContain("120 dollars");
  });

  // Fault detected: cell edits overwrite the workbook instead of waiting for the owner.
  it("proposes sheet changes that stay pending until rejected", async () => {
    await copyFile(join(FIXTURES, "basic.xlsx"), join(home, "docs/basic.xlsx"));
    const described = await call("sheet_describe", { path: "docs/basic.xlsx" });
    expect(described.content[0]!.text).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT>>>");
    const sheet = (payload(described) as { sheet: string }).sheet;

    const proposed = payload(await call("sheet_propose_edits", {
      path: "docs/basic.xlsx", label: "Raise A1", edits: [{ op: "setCell", sheet, cell: "A1", value: 4242 }],
    })) as { changeIds: string[] };
    expect(proposed.changeIds.length).toBe(1);

    const changes = payload(await call("sheet_list_changes", { path: "docs/basic.xlsx" })) as {
      changes: Array<{ cell: string; newValue: unknown; author: string }>;
    };
    expect(changes.changes).toEqual([expect.objectContaining({ cell: "A1", newValue: 4242, author: "Matrix OS" })]);

    const range = payload(await call("sheet_read_range", { path: "docs/basic.xlsx", sheet, range: "A1" })) as {
      cells: Array<Array<{ pendingChangeId: string | null }>>;
    };
    expect(range.cells[0]![0]!.pendingChangeId).toBe(proposed.changeIds[0]);

    const rejected = payload(await call("sheet_reject_changes", { path: "docs/basic.xlsx", ids: "all" })) as { resolvedIds: string[] };
    expect(rejected.resolvedIds).toEqual(proposed.changeIds);
    const remaining = payload(await call("sheet_list_changes", { path: "docs/basic.xlsx" })) as { total: number };
    expect(remaining.total).toBe(0);
  });

  // Fault detected: a call the tool reported as busy still saves later, so the model's retry adds the proposal twice.
  it("never saves a call it reported as busy, so a retry adds the proposal once", async () => {
    await copyFile(join(FIXTURES, "basic.xlsx"), join(home, "docs/basic.xlsx"));
    let stall = 800;
    let settled!: () => void;
    const firstSettled = new Promise<void>((done) => { settled = done; });
    const routes = createOfficeDocumentRoutes({
      homePath: home,
      engine: { run: runEngineOperation, close: async () => undefined },
      beforeCommit: async () => {
        if (stall === 0) return;
        await new Promise((done) => setTimeout(done, stall));
        settled();
      },
    });
    const slow = await byName(routes, { deadlineMs: 500 });
    const sheet = (payload(await call("sheet_describe", { path: "docs/basic.xlsx" })) as { sheet: string }).sheet;
    const edit = { path: "docs/basic.xlsx", label: "Raise A1", edits: [{ op: "setCell", sheet, cell: "A1", value: 4242 }] };

    const first = await slow("sheet_propose_edits", edit);
    expect(first.isError).toBe(true);
    expect(first.content[0]!.text).toContain("(busy)");
    // Let the service finish what it was doing for the abandoned call.
    await firstSettled;
    await new Promise((done) => setTimeout(done, 100));
    expect((payload(await call("sheet_list_changes", { path: "docs/basic.xlsx" })) as { total: number }).total).toBe(0);

    stall = 0;
    const retried = await slow("sheet_propose_edits", edit);
    expect(retried.isError).toBeUndefined();
    const listed = payload(await call("sheet_list_changes", { path: "docs/basic.xlsx" })) as { total: number; proposals: unknown[] };
    expect(listed.total).toBe(1);
    expect(listed.proposals).toHaveLength(1);
  });

  // Fault detected: the agent can read protected owner paths through the document tools.
  it("refuses paths the document service protects", async () => {
    const result = await call("document_describe", { path: "system/secrets.docx" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/\((forbidden|not_found)\)/);
  });
});
