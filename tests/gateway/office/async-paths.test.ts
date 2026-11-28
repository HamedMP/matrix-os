import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOfficeHarness, type OfficeHarness } from "./helpers";

/** Records synchronous path checks so a test can prove a document request never blocks on them. */
const syncFsCalls = vi.hoisted(() => [] as string[]);
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const recorded = <T extends (...args: never[]) => unknown>(name: string, fn: T) => ((...args: Parameters<T>) => {
    syncFsCalls.push(`${name}:${String(args[0])}`);
    return fn(...args);
  }) as T;
  const realpathSync = Object.assign(recorded("realpathSync", actual.realpathSync), { native: actual.realpathSync.native });
  const fs = {
    ...actual,
    existsSync: recorded("existsSync", actual.existsSync),
    lstatSync: recorded("lstatSync", actual.lstatSync),
    statSync: recorded("statSync", actual.statSync),
    realpathSync,
  };
  return { ...fs, default: fs };
});

let h: OfficeHarness;
beforeEach(async () => { h = await createOfficeHarness(); });
afterEach(async () => { await h.cleanup(); });

describe("office document path resolution", () => {
  it("reads, creates and saves documents and sheets without synchronous filesystem calls", async () => {
    const doc = await h.copyFixture("basic.docx");
    const sheet = await h.copyFixture("model.xlsx");
    syncFsCalls.length = 0;
    const responses = await Promise.all([
      h.post("/documents/describe", { path: doc }),
      h.post("/documents/propose-edits", {
        path: doc, author: "Matrix Agent", edits: [{ op: "replaceText", blockId: "b3", find: "three", replace: "four" }],
      }),
      h.post("/documents/create", { path: "docs/new/fresh.docx", paragraphs: ["Hello"] }),
      h.post("/sheets/describe", { path: sheet }),
      h.post("/sheets/propose-edits", {
        path: sheet, author: "Matrix Agent", label: "Edit", edits: [{ op: "setCell", sheet: "Summary", cell: "D1", value: 1 }],
      }),
      h.post("/documents/describe", { path: "docs/missing.docx" }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 404]);
    expect(syncFsCalls.filter((call) => call.includes(h.home))).toEqual([]);
  });
});
