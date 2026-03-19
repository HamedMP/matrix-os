import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CallStore } from "../../../packages/gateway/src/voice/call-store.js";
import type { CallRecord } from "../../../packages/gateway/src/voice/types.js";
import { writeFileSync } from "node:fs";

function makeRecord(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    callId: `call-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    provider: "mock",
    direction: "outbound",
    state: "initiated",
    from: "+1234567890",
    to: "+0987654321",
    startedAt: Date.now(),
    transcript: [],
    processedEventIds: [],
    mode: "conversation",
    ...overrides,
  };
}

describe("CallStore", () => {
  let tempDir: string;
  let storePath: string;
  let store: CallStore;

  beforeEach(() => {
    tempDir = resolve(mkdtempSync(join(tmpdir(), "callstore-")));
    mkdirSync(join(tempDir, "voice"), { recursive: true });
    storePath = join(tempDir, "voice", "calls.jsonl");
    store = new CallStore(storePath);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("append()", () => {
    it("writes a JSONL line to the file", () => {
      const record = makeRecord();
      store.append(record);

      const content = readFileSync(storePath, "utf-8");
      const lines = content.trim().split("\n");
      expect(lines.length).toBe(1);
      expect(JSON.parse(lines[0]!).callId).toBe(record.callId);
    });

    it("creates the file on first write", () => {
      const newPath = join(tempDir, "voice", "new-calls.jsonl");
      const newStore = new CallStore(newPath);
      const record = makeRecord();

      newStore.append(record);

      const content = readFileSync(newPath, "utf-8");
      expect(content.trim().length).toBeGreaterThan(0);
    });
  });

  describe("getAll()", () => {
    it("returns all records", () => {
      const r1 = makeRecord({ callId: "call-1" });
      const r2 = makeRecord({ callId: "call-2" });
      store.append(r1);
      store.append(r2);

      const all = store.getAll();
      expect(all.length).toBe(2);
      expect(all[0]!.callId).toBe("call-1");
      expect(all[1]!.callId).toBe("call-2");
    });

    it("returns empty array when file does not exist", () => {
      const freshStore = new CallStore(join(tempDir, "nonexistent.jsonl"));
      expect(freshStore.getAll()).toEqual([]);
    });
  });

  describe("getActive()", () => {
    it("filters to non-terminal states", () => {
      store.append(makeRecord({ callId: "active-1", state: "initiated" }));
      store.append(makeRecord({ callId: "active-2", state: "ringing" }));
      store.append(makeRecord({ callId: "done-1", state: "completed" }));
      store.append(makeRecord({ callId: "done-2", state: "hangup-user" }));

      const active = store.getActive();
      expect(active.length).toBe(2);
      expect(active.map((r) => r.callId).sort()).toEqual(["active-1", "active-2"]);
    });
  });

  describe("getById()", () => {
    it("finds a specific record", () => {
      store.append(makeRecord({ callId: "target" }));
      store.append(makeRecord({ callId: "other" }));

      const found = store.getById("target");
      expect(found).toBeDefined();
      expect(found!.callId).toBe("target");
    });

    it("returns undefined for unknown callId", () => {
      store.append(makeRecord({ callId: "existing" }));
      expect(store.getById("unknown")).toBeUndefined();
    });
  });

  describe("update()", () => {
    it("merges partial data and rewrites file", () => {
      store.append(makeRecord({ callId: "to-update", state: "initiated" }));
      store.append(makeRecord({ callId: "other", state: "ringing" }));

      store.update("to-update", { state: "completed", endedAt: Date.now() });

      const updated = store.getById("to-update");
      expect(updated!.state).toBe("completed");
      expect(updated!.endedAt).toBeDefined();

      // Other records unchanged
      const other = store.getById("other");
      expect(other!.state).toBe("ringing");
    });
  });

  describe("corrupted lines", () => {
    it("skips gracefully", () => {
      store.append(makeRecord({ callId: "valid-1" }));

      // Manually append a corrupted line
      writeFileSync(storePath, readFileSync(storePath, "utf-8") + "not-json\n");
      store.append(makeRecord({ callId: "valid-2" }));

      const all = store.getAll();
      expect(all.length).toBe(2);
      expect(all[0]!.callId).toBe("valid-1");
      expect(all[1]!.callId).toBe("valid-2");
    });
  });

  describe("getRecent()", () => {
    it("returns last N records", () => {
      for (let i = 0; i < 10; i++) {
        store.append(makeRecord({ callId: `call-${i}` }));
      }

      const recent = store.getRecent(3);
      expect(recent.length).toBe(3);
      expect(recent[0]!.callId).toBe("call-7");
      expect(recent[1]!.callId).toBe("call-8");
      expect(recent[2]!.callId).toBe("call-9");
    });

    it("returns all if fewer than limit", () => {
      store.append(makeRecord({ callId: "only-one" }));
      const recent = store.getRecent(10);
      expect(recent.length).toBe(1);
    });
  });
});
