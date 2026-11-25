import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OfficeDocumentError } from "../../../packages/gateway/src/office/document-error";
import { createOfficeEngine, type OfficeEngine } from "../../../packages/gateway/src/office/engine-pool";
import { openDocx } from "../../../packages/office/src/docx/index.js";
import { FIXTURES } from "./helpers";

let engine: OfficeEngine | null = null;
afterEach(async () => { await engine?.close(); engine = null; });

const fixture = async (name: string) => new Uint8Array(await readFile(join(FIXTURES, name)));

/** Edits whose recalculation costs `cells` squared range reads: seconds of synchronous work. */
function quadraticEdits(sheet: string, cells: number) {
  const range = ["H$1:H$", String(cells)].join("");
  const formula = ["=SUMPRODUCT(", range, ",", range, ")"].join("");
  return [
    { op: "setRange" as const, sheet, start: "H1", values: Array.from({ length: cells }, (_, row) => [row + 1]) },
    { op: "setRange" as const, sheet, start: "I1", values: Array.from({ length: cells }, () => [formula]) },
  ];
}

async function heavy(target: OfficeEngine, cells = 8000) {
  const bytes = await fixture("basic.xlsx");
  const sheet = (await target.run("sheetDescribe", { path: "basic.xlsx", bytes, request: { maxChars: 2000 } })).sheet;
  return () => target.run("sheetProposeEdits", {
    path: "basic.xlsx", bytes, edits: quadraticEdits(sheet, cells), proposal: { author: "Agent", date: "2026-11-23T10:00:00.000Z", label: "heavy" },
  });
}

async function failure(work: Promise<unknown>): Promise<OfficeDocumentError> {
  try { await work; }
  catch (error: unknown) {
    if (error instanceof OfficeDocumentError) return error;
    throw error;
  }
  throw new Error("expected the operation to fail");
}

// User outcome: one document that is slow or hostile to compute costs its own
// request, never the gateway and never the requests after it.
describe("document engine threads", () => {
  it("returns an edit's answer and the saved file from another thread", async () => {
    engine = createOfficeEngine();
    const created = await engine.run("documentCreate", { paragraphs: ["First", "Second"], options: { date: "2026-11-23T10:00:00.000Z" } });
    const described = await engine.run("documentDescribe", { bytes: created.bytes, options: { maxChars: 2000 } });
    expect(described.text).toContain("Second");
    const blockId = described.blockIds[0] ?? "";
    const edited = await engine.run("documentProposeEdits", {
      bytes: created.bytes, author: "Agent", date: "2026-11-23T10:00:00.000Z",
      edits: [{ op: "replaceText", blockId, find: "First", replace: "Opening" }],
    });
    expect(edited.changed).toBe(true);
    expect(edited.result.revisionIds.length).toBeGreaterThan(0);
    const reopened = await openDocx(edited.bytes ?? new Uint8Array());
    expect(reopened.listRevisions().length).toBe(edited.result.revisionIds.length);
  });

  it("returns no file for an edit that changed nothing", async () => {
    engine = createOfficeEngine();
    const bytes = await fixture("basic.docx");
    const outcome = await engine.run("documentResolveRevisions", { bytes, ids: "all", accept: true });
    expect(outcome).toMatchObject({ changed: false, bytes: null });
  });

  it("carries an engine failure across the thread as a client-safe code", async () => {
    engine = createOfficeEngine();
    const error = await failure(engine.run("documentDescribe", { bytes: new TextEncoder().encode("not a zip"), options: { maxChars: 100 } }));
    expect(error.code).toBe("unsupported_document");
    expect(error.origin).toMatchObject({ engineCode: "not_a_zip" });
  });

  it("ends a thread that overruns its time budget and serves the next operation", async () => {
    engine = createOfficeEngine({ runBudgetMs: 300, maxWorkers: 1 });
    const run = await heavy(engine);
    const started = performance.now();
    const error = await failure(run());
    expect(error.code).toBe("too_large");
    // Seconds of synchronous work were cut off at the budget, not waited for.
    expect(performance.now() - started).toBeLessThan(3000);
    const after = await engine.run("documentCreate", { paragraphs: ["Still here"], options: { date: "2026-11-23T10:00:00.000Z" } });
    expect(after.bytes.byteLength).toBeGreaterThan(0);
  }, 30_000);

  it("refuses more waiting operations than the queue holds", async () => {
    engine = createOfficeEngine({ runBudgetMs: 400, maxWorkers: 1, maxQueued: 1 });
    const run = await heavy(engine);
    const [first, second, third] = [run(), run(), run()];
    expect((await failure(third)).code).toBe("busy");
    expect((await failure(first)).code).toBe("too_large");
    expect((await failure(second)).code).toBe("too_large");
  }, 30_000);

  it("gives up on an operation that waits too long for a free thread", async () => {
    engine = createOfficeEngine({ runBudgetMs: 1500, queueBudgetMs: 200, maxWorkers: 1 });
    const run = await heavy(engine);
    const first = run();
    const waiting = engine.run("documentCreate", { paragraphs: ["x"], options: { date: "2026-11-23T10:00:00.000Z" } });
    expect((await failure(waiting)).code).toBe("busy");
    expect((await failure(first)).code).toBe("too_large");
  }, 30_000);

  it("runs operations side by side up to its thread cap", async () => {
    engine = createOfficeEngine({ runBudgetMs: 4000, maxWorkers: 2 });
    const run = await heavy(engine);
    let settled = false;
    const blocked = failure(run()).finally(() => { settled = true; });
    const created = await engine.run("documentCreate", { paragraphs: ["x"], options: { date: "2026-11-23T10:00:00.000Z" } });
    expect(created.bytes.byteLength).toBeGreaterThan(0);
    // The light operation finished on a second thread while the heavy one was still computing.
    expect(settled).toBe(false);
    expect((await blocked).code).toBe("too_large");
  }, 30_000);

  it("fails what is running and waiting when it closes, and refuses new work", async () => {
    engine = createOfficeEngine({ runBudgetMs: 5000, maxWorkers: 1 });
    const run = await heavy(engine);
    const [running, waiting] = [run(), run()];
    const failures = Promise.all([failure(running), failure(waiting)]);
    await engine.close();
    expect((await failures).map((error) => error.code)).toEqual(["unavailable", "unavailable"]);
    expect((await failure(engine.run("documentCreate", { paragraphs: [], options: { date: "2026-11-23T10:00:00.000Z" } }))).code).toBe("unavailable");
  }, 30_000);
});
