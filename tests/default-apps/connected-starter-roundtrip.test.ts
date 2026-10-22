import { describe, expect, it, vi } from "vitest";
import { readRecords } from "../../home/app-templates/connected-starter/src/model";
import { archiveRecord, persistRecord } from "../../home/app-templates/connected-starter/src/persistence";
import type { Database } from "../../home/app-templates/connected-starter/src/types";

describe("lossless owner evidence round trips", () => {
  const original = {
    id: "c5b04d13-7fae-4b71-af90-481b13cd841c", scope: "work",
    fields: { title: "Original", opaque: "preserve" },
    accounts: [{ service: "gmail", label: "Work", email: "original@example.com", externalMetadata: "preserve" }],
    sources: Array.from({ length: 101 }, (_, index) => ({ id: String(index), service: "gmail", label: "Work", title: "Receipt", excerpt: index === 0 ? "x".repeat(4001) : "Receipt evidence", externalMetadata: index })),
    manualFields: ["opaque"], updatedAt: "2026-10-06T00:00:00Z", externalMetadata: { keep: true },
  };
  const db = () => ({ insert: vi.fn(), find: vi.fn(), compareAndSwap: vi.fn().mockResolvedValue({ ok: true }), update: vi.fn() });
  it("edits only intended fields while retaining evidence beyond display caps", async () => {
    const record = readRecords([{ id: original.id, payload: original }])[0];
    expect(record.sources).toHaveLength(100);
    const database = db();
    await persistRecord(database as Database, { ...record, fields: { ...record.fields, title: "Edited" }, manualFields: [...record.manualFields, "title"] });
    const saved = database.compareAndSwap.mock.calls[0][3].payload;
    expect(saved.sources).toEqual(original.sources);
    expect(saved.accounts).toEqual(original.accounts);
    expect(saved.externalMetadata).toEqual(original.externalMetadata);
    expect(saved.fields).toEqual({ ...original.fields, title: "Edited" });
    expect(saved.manualFields).toEqual(["opaque", "title"]);
    expect(saved).not.toHaveProperty("basePayload");
  });
  it("archives the raw stored payload without destroying source evidence", async () => {
    const record = readRecords([{ id: original.id, payload: original }])[0];
    const database = db();
    await archiveRecord(database as Database, record);
    const saved = database.compareAndSwap.mock.calls[0][3].payload;
    expect(saved.sources).toEqual(original.sources);
    expect(saved.accounts).toEqual(original.accounts);
    expect(saved.externalMetadata).toEqual(original.externalMetadata);
    expect(saved.archivedAt).toEqual(expect.any(String));
  });
});
