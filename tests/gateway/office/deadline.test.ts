import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  OFFICE_DOCUMENT_BUDGET_HEADER, SheetChangesListReplySchema, SheetProposeEditsReplySchema,
} from "../../../packages/contracts/src/office-documents";
import type { OfficeEngine } from "../../../packages/gateway/src/office/engine-pool";
import { runEngineOperation, type EngineOperation } from "../../../packages/gateway/src/office/engine-operations";
import { createOfficeHarness, json, type OfficeHarness } from "./helpers";

/**
 * The agent document tools give up after a deadline and tell the model the
 * call failed. These tests pin that a call past its deadline never writes,
 * whichever step it is waiting in, so a retry cannot add the proposal twice.
 */

let h: OfficeHarness | null = null;
afterEach(async () => { await h?.cleanup(); h = null; });

const sleep = (ms: number) => new Promise<void>((done) => { setTimeout(done, ms); });

/** Runs the engine on the test thread, counting the runs of each operation. */
function countingEngine(): OfficeEngine & { runs: Map<EngineOperation, number> } {
  const runs = new Map<EngineOperation, number>();
  return {
    runs,
    run: (operation, input) => {
      runs.set(operation, (runs.get(operation) ?? 0) + 1);
      return runEngineOperation(operation, input);
    },
    close: async () => undefined,
  };
}

const EDITS = {
  author: "Matrix Agent", label: "Fix typed-in revenue",
  edits: [{ op: "setCell", sheet: "Assumptions", cell: "B2", value: 60000 }],
};

function propose(harness: OfficeHarness, path: string, budgetMs?: number) {
  const headers: Record<string, string> = budgetMs === undefined ? {} : { [OFFICE_DOCUMENT_BUDGET_HEADER]: String(budgetMs) };
  return harness.postRaw("/sheets/propose-edits", JSON.stringify({ path, ...EDITS }), headers);
}

async function pendingChanges(harness: OfficeHarness, path: string) {
  return SheetChangesListReplySchema.parse(await json(await harness.post("/sheets/changes/list", { path })));
}

describe("office edits past their deadline", () => {
  // Fault detected: an edit whose caller already gave up is saved anyway once its engine run finishes.
  it("answers busy and leaves the file untouched when the deadline passes before the save, and a retry adds the proposal once", async () => {
    let delay = 400;
    h = await createOfficeHarness({ engine: countingEngine(), beforeCommit: () => sleep(delay) });
    const path = await h.copyFixture("model.xlsx");
    const before = await h.bytes(path);

    const late = await propose(h, path, 200);
    expect(late.status).toBe(503);
    expect(await json(late)).toMatchObject({ error: "busy" });
    expect(await h.bytes(path)).toEqual(before);
    expect((await readdir(join(h.home, "docs"))).filter((name) => name.startsWith(".matrix-office-"))).toEqual([]);

    delay = 0;
    const retried = SheetProposeEditsReplySchema.parse(await json(await propose(h, path)));
    expect(retried.saved).toBe(true);
    const listed = await pendingChanges(h, path);
    expect(listed.proposals).toHaveLength(1);
    expect(listed.total).toBe(1);
  });

  // Fault detected: an edit queued behind a slow save on the same path runs the engine and saves after its deadline.
  it("does not run the engine for an edit whose deadline passed while it waited for the path", async () => {
    const engine = countingEngine();
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    let first = true;
    h = await createOfficeHarness({
      engine,
      beforeCommit: async () => { if (first) { first = false; await gate; } },
    });
    const path = await h.copyFixture("model.xlsx");

    const holder = propose(h, path);
    await sleep(50);
    const queued = await propose(h, path, 100);
    expect(queued.status).toBe(503);
    expect(await json(queued)).toMatchObject({ error: "busy" });
    release();
    expect((await holder).status).toBe(200);
    expect(engine.runs.get("sheetProposeEdits")).toBe(1);
    expect((await pendingChanges(h, path)).proposals).toHaveLength(1);
  });

  // Fault detected: a malformed budget is trusted, or a large one lets a call outlive the service's own limit.
  it("refuses a malformed budget and accepts a large one capped to the service limit", async () => {
    h = await createOfficeHarness({ engine: countingEngine() });
    const path = await h.copyFixture("model.xlsx");
    for (const bad of ["", "0", "-5", "1.5", "abc", "1e3"]) {
      const response = await h.postRaw("/sheets/describe", JSON.stringify({ path }), { [OFFICE_DOCUMENT_BUDGET_HEADER]: bad });
      expect(response.status, bad).toBe(400);
    }
    const large = await h.postRaw("/sheets/describe", JSON.stringify({ path }), { [OFFICE_DOCUMENT_BUDGET_HEADER]: "99999999" });
    expect(large.status).toBe(200);
  });
});
