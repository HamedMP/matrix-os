import { chmod, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OFFICE_TEMP_PREFIX } from "../../../packages/gateway/src/office/file-store";
import { createOfficeHarness, json, type OfficeHarness } from "./helpers";

/**
 * Runs while a save's temp file syncs to disk, after the version check: the
 * window in which a writer outside the gateway (the sync daemon) can replace
 * the target.
 */
const race = vi.hoisted(() => ({
  duringTempSync: null as null | (() => Promise<void>),
  /** Permission bits of each temp file right after its bytes were written. */
  tempModesAfterWrite: [] as number[],
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open = (async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    if (!basename(String(args[0])).startsWith(OFFICE_TEMP_PREFIX)) return handle;
    const writeFile = handle.writeFile.bind(handle);
    handle.writeFile = (async (...writeArgs: Parameters<typeof handle.writeFile>) => {
      await writeFile(...writeArgs);
      race.tempModesAfterWrite.push(Number((await handle.stat()).mode) & 0o777);
    }) as typeof handle.writeFile;
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      const step = race.duringTempSync;
      race.duringTempSync = null;
      if (step) await step();
      return sync();
    };
    return handle;
  }) as typeof actual.open;
  const fs = { ...actual, open };
  return { ...fs, default: fs };
});

let h: OfficeHarness;
beforeEach(async () => { h = await createOfficeHarness(); });
afterEach(async () => {
  race.duringTempSync = null;
  race.tempModesAfterWrite = [];
  await h.cleanup();
});

const AGENT = "Matrix Agent";

async function replaceDuringSave(path: string, fixture: string): Promise<Uint8Array> {
  await h.copyFixture(fixture, "docs/newer-copy");
  const newer = await h.bytes("docs/newer-copy");
  race.duringTempSync = async () => { await h.copyFixture(fixture, path); };
  return newer;
}

describe("office saves racing a writer outside the gateway", () => {
  it("answers version_conflict and keeps the document another process saved while the edit was being written", async () => {
    const path = await h.copyFixture("basic.docx");
    const newer = await replaceDuringSave(path, "tracked.docx");
    const response = await h.post("/documents/propose-edits", {
      path, author: AGENT, edits: [{ op: "replaceText", blockId: "b3", find: "three", replace: "four" }],
    });
    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({ error: "version_conflict" });
    expect(await h.bytes(path)).toEqual(newer);
  });

  it("answers version_conflict and keeps the workbook another process saved while the edit was being written", async () => {
    const path = await h.copyFixture("model.xlsx");
    const newer = await replaceDuringSave(path, "formulas.xlsx");
    const response = await h.post("/sheets/propose-edits", {
      path, author: AGENT, label: "Edit", edits: [{ op: "setCell", sheet: "Summary", cell: "D1", value: 1 }],
    });
    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({ error: "version_conflict" });
    expect(await h.bytes(path)).toEqual(newer);
  });

  it("still publishes when nothing touched the target during the write", async () => {
    const path = await h.copyFixture("basic.docx");
    race.duringTempSync = async () => {};
    const response = await h.post("/documents/propose-edits", {
      path, author: AGENT, edits: [{ op: "replaceText", blockId: "b3", find: "three", replace: "four" }],
    });
    expect(response.status).toBe(200);
  });
});

describe("office saves of a private file", () => {
  it("never leaves the edited bytes readable by other users while the temp file is written", async () => {
    const path = await h.copyFixture("basic.docx");
    await chmod(join(h.home, path), 0o600);
    const response = await h.post("/documents/propose-edits", {
      path, author: AGENT, edits: [{ op: "replaceText", blockId: "b3", find: "three", replace: "four" }],
    });
    expect(response.status).toBe(200);
    expect(race.tempModesAfterWrite).toEqual([0o600]);
    expect(Number((await stat(join(h.home, path))).mode) & 0o777).toBe(0o600);
  });

  it("keeps the permissions of a shared file after the save", async () => {
    const path = await h.copyFixture("model.xlsx");
    await chmod(join(h.home, path), 0o640);
    const response = await h.post("/sheets/propose-edits", {
      path, author: AGENT, label: "Edit", edits: [{ op: "setCell", sheet: "Summary", cell: "D1", value: 1 }],
    });
    expect(response.status).toBe(200);
    expect(race.tempModesAfterWrite).toEqual([0o600]);
    expect(Number((await stat(join(h.home, path))).mode) & 0o777).toBe(0o640);
  });
});
