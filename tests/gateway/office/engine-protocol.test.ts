import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OfficeDocumentError } from "../../../packages/gateway/src/office/document-error";
import {
  engineFailureReply, handleEngineRequest, type EngineWorkerReply,
} from "../../../packages/gateway/src/office/engine-protocol";
import { openDocx } from "../../../packages/office/src/docx/index.js";
import { openXlsx } from "../../../packages/office/src/xlsx/index.js";
import { FIXTURES } from "./helpers";

const DATE = "2026-11-23T10:00:00.000Z";
const fixture = async (name: string) => new Uint8Array(await readFile(join(FIXTURES, name)));

/** One request through the engine thread's handler, on this thread. The reply must survive the thread boundary. */
async function ask<T>(operation: string, input: unknown): Promise<T> {
  const reply = structuredClone(await handleEngineRequest({ id: 7, operation, input })) as EngineWorkerReply;
  if ("ready" in reply) throw new Error("unexpected ready reply");
  expect(reply.id).toBe(7);
  if (!reply.ok) throw new OfficeDocumentError(reply.code, reply.message, { origin: { name: reply.name, engineCode: reply.engineCode } });
  return reply.output as T;
}

async function refusal(operation: string, input: unknown): Promise<OfficeDocumentError> {
  try { await ask(operation, input); }
  catch (error: unknown) {
    if (error instanceof OfficeDocumentError) return error;
    throw error;
  }
  throw new Error("expected a failure reply");
}

interface Edit<R> { changed: boolean; result: R; bytes: Uint8Array | null }

// User outcome: every document and sheet tool gives the same answer when the
// engine runs on another thread, with only plain data crossing over.
describe("engine thread protocol", () => {
  it("creates, describes, reads, edits, comments on and resolves a document", async () => {
    const created = await ask<{ bytes: Uint8Array }>("documentCreate", { markdown: "# Plan\n\nShip the first draft.", options: { date: DATE, author: "Owner" } });
    const described = await ask<{ text: string; blockIds: string[]; revisionCount: number }>("documentDescribe", { bytes: created.bytes, options: { maxChars: 2000 } });
    expect(described.text).toContain("Ship the first draft.");
    expect(described.revisionCount).toBe(0);
    const blockId = described.blockIds.at(-1) ?? "";
    const read = await ask<{ text: string; missingBlockIds: string[] }>("documentReadText", {
      bytes: created.bytes, request: { blockIds: [blockId, "b404"], view: "final", maxChars: 500 },
    });
    expect(read).toMatchObject({ text: "Ship the first draft.", missingBlockIds: ["b404"] });

    const proposed = await ask<Edit<{ revisionIds: string[]; rejected: unknown[] }>>("documentProposeEdits", {
      bytes: created.bytes, author: "Agent", date: DATE,
      edits: [{ op: "replaceText", blockId, find: "first", replace: "second" }, { op: "replaceText", blockId: "b404", find: "x", replace: "y" }],
    });
    expect(proposed.changed).toBe(true);
    expect(proposed.result.rejected).toHaveLength(1);
    const tracked = proposed.bytes ?? new Uint8Array();
    const listed = await ask<{ revisions: Array<{ id: string; author: string }>; total: number }>("documentListRevisions", { bytes: tracked });
    expect(listed.total).toBe(proposed.result.revisionIds.length);
    expect(listed.revisions.every((revision) => revision.author === "Agent")).toBe(true);

    const commented = await ask<Edit<{ commentId: string }>>("documentAddComment", {
      bytes: tracked, comment: { blockId, find: "Ship", text: "Confirm the date." }, author: "Agent", date: DATE,
    });
    expect((await openDocx(commented.bytes ?? new Uint8Array())).listComments().map((comment) => comment.id)).toContain(commented.result.commentId);

    const accepted = await ask<Edit<{ resolvedIds: string[] }>>("documentResolveRevisions", { bytes: tracked, ids: "all", accept: true });
    expect(accepted.result.resolvedIds.sort()).toEqual(listed.revisions.map((revision) => revision.id).sort());
    const final = await openDocx(accepted.bytes ?? new Uint8Array());
    expect(final.listRevisions()).toEqual([]);
    expect(final.getPlainText()).toContain("Ship the second draft.");
    const again = await ask<Edit<{ resolvedIds: string[] }>>("documentResolveRevisions", { bytes: accepted.bytes, ids: "all", accept: false });
    expect(again).toMatchObject({ changed: false, bytes: null });
  });

  it("compares two documents into one with tracked revisions", async () => {
    const compared = await ask<{ summary: { identical: boolean; total: number }; bytes: Uint8Array }>("documentCompare", {
      original: await fixture("contract.docx"), revised: await fixture("contract-v2.docx"), author: "Agent", date: DATE,
    });
    expect(compared.summary.identical).toBe(false);
    expect((await openDocx(compared.bytes)).listRevisions()).toHaveLength(compared.summary.total);
  });

  it("describes, reads, edits and resolves a workbook, and reads csv by its path", async () => {
    const bytes = await fixture("model.xlsx");
    const described = await ask<{ sheet: string; text: string }>("sheetDescribe", { path: "model.xlsx", bytes, request: { maxChars: 2000 } });
    expect(described).toMatchObject({ sheet: "Assumptions" });
    const range = await ask<{ cells: Array<Array<{ formula: string | null; display: string }>> }>("sheetReadRange", {
      path: "model.xlsx", bytes, request: { sheet: "Summary", range: "B3" },
    });
    expect(range.cells[0]?.[0]).toMatchObject({ formula: "Projection!N10", display: "157,321" });

    const proposed = await ask<Edit<{ proposalId: string | null; changeIds: string[] }>>("sheetProposeEdits", {
      path: "model.xlsx", bytes, proposal: { author: "Agent", date: DATE, label: "Raise revenue" },
      edits: [{ op: "setCell", sheet: "Assumptions", cell: "B2", value: 60000 }],
    });
    expect(proposed.changed).toBe(true);
    const pending = proposed.bytes ?? new Uint8Array();
    const listed = await ask<{ changes: Array<{ id: string; cell: string; sheet: string }>; total: number }>("sheetListChanges", { path: "model.xlsx", bytes: pending });
    expect(listed.changes.map((change) => change.id)).toEqual(proposed.result.changeIds);
    expect(listed.changes[0]).toMatchObject({ sheet: "Assumptions", cell: "B2" });

    const rejected = await ask<Edit<{ resolvedIds: string[]; staleIds: string[] }>>("sheetResolveChanges", { path: "model.xlsx", bytes: pending, ids: "all", accept: false });
    expect(rejected.result.resolvedIds).toEqual(proposed.result.changeIds);
    const restored = await openXlsx(rejected.bytes ?? new Uint8Array());
    expect(restored.listChanges()).toEqual([]);

    const csv = await ask<{ text: string }>("sheetDescribe", { path: "data.csv", bytes: await fixture("data.csv"), request: { maxChars: 2000 } });
    expect(csv.text.length).toBeGreaterThan(0);
  });

  it("answers a damaged file, a bad reference and an unknown operation with client-safe codes", async () => {
    const damaged = await refusal("documentDescribe", { bytes: new TextEncoder().encode("not a zip"), options: { maxChars: 100 } });
    expect(damaged.code).toBe("unsupported_document");
    expect(damaged.origin).toMatchObject({ engineCode: "not_a_zip" });
    const missing = await refusal("sheetReadRange", { path: "model.xlsx", bytes: await fixture("model.xlsx"), request: { sheet: "Nope", range: "A1" } });
    expect(missing).toMatchObject({ code: "not_found", origin: { name: "OfficeDocumentError", engineCode: null } });
    expect((await refusal("eval", { code: "process.exit()" })).code).toBe("internal");
    expect((await refusal("constructor", {})).code).toBe("internal");
  });

  it("bounds the log text of a failure and never sends more than a code to the client", () => {
    const reply = engineFailureReply(3, new Error("x".repeat(5000)));
    expect(reply).toMatchObject({ id: 3, ok: false, code: "internal", name: "Error", engineCode: null });
    expect("message" in reply && reply.message.length).toBe(500);
    expect(engineFailureReply(4, "boom")).toMatchObject({ code: "internal", name: "string", message: "" });
  });
});
