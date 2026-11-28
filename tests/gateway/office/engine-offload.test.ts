import { afterEach, describe, expect, it } from "vitest";
import { createOfficeEngine, type OfficeEngine } from "../../../packages/gateway/src/office/engine-pool";
import { createOfficeHarness, json, type OfficeHarness } from "./helpers";

let harness: OfficeHarness | null = null;
let engine: OfficeEngine | null = null;
afterEach(async () => {
  await harness?.cleanup();
  await engine?.close();
  harness = null;
  engine = null;
});

/** A request inside every contract limit whose recalculation costs `cells` squared range reads. */
function quadraticEdits(sheet: string, cells: number) {
  const range = ["H$1:H$", String(cells)].join("");
  const formula = ["=SUMPRODUCT(", range, ",", range, ")"].join("");
  return [
    { op: "setRange", sheet, start: "H1", values: Array.from({ length: cells }, (_, row) => [row + 1]) },
    { op: "setRange", sheet, start: "I1", values: Array.from({ length: cells }, () => [formula]) },
  ];
}

/** Longest stretch, in ms, during which the event loop ran no timer while `work` was pending. */
async function longestStall<T>(work: () => Promise<T>): Promise<{ value: T; stallMs: number; tookMs: number }> {
  let last = performance.now();
  let stallMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    stallMs = Math.max(stallMs, now - last);
    last = now;
  }, 10);
  const started = performance.now();
  try {
    const value = await work();
    stallMs = Math.max(stallMs, performance.now() - last);
    return { value, stallMs, tookMs: performance.now() - started };
  } finally {
    clearInterval(timer);
  }
}

// User outcome: while an agent edits a heavy workbook, every other request,
// terminal and socket on the gateway keeps being served.
describe("document engine work and the gateway event loop", () => {
  it("keeps the event loop free while a quadratic recalculation runs", async () => {
    harness = await createOfficeHarness();
    const h = harness;
    const path = await h.copyFixture("basic.xlsx");
    const sheet = (await json<{ sheet: string }>(await h.post("/sheets/describe", { path }))).sheet;
    const run = await longestStall(() => h.post("/sheets/propose-edits", {
      path, author: "Agent", label: "heavy", edits: quadraticEdits(sheet, 3000),
    }));
    expect(run.value.status).toBe(200);
    // The recalculation itself takes far longer than this; it must not run on this thread.
    expect(run.tookMs).toBeGreaterThan(300);
    expect(run.stallMs).toBeLessThan(500);
  }, 60_000);

  it("cuts off an edit that computes past its time budget, saves nothing and keeps serving", async () => {
    engine = createOfficeEngine({ runBudgetMs: 400 });
    harness = await createOfficeHarness({ engine });
    const h = harness;
    const path = await h.copyFixture("basic.xlsx");
    const before = await h.bytes(path);
    const sheet = (await json<{ sheet: string }>(await h.post("/sheets/describe", { path }))).sheet;
    const run = await longestStall(() => h.post("/sheets/propose-edits", {
      path, author: "Agent", label: "heavy", edits: quadraticEdits(sheet, 9000),
    }));
    expect(run.value.status).toBe(413);
    expect(await json(run.value)).toMatchObject({ error: "too_large" });
    // Unbounded, this request computes for well over ten seconds.
    expect(run.tookMs).toBeLessThan(4000);
    expect(run.stallMs).toBeLessThan(500);
    expect(await h.bytes(path)).toEqual(before);
    const light = await h.post("/sheets/propose-edits", {
      path, author: "Agent", label: "light", edits: [{ op: "setCell", sheet, cell: "H1", value: 5 }],
    });
    expect(light.status).toBe(200);
    expect(await json(light)).toMatchObject({ saved: true });
  }, 60_000);
});
