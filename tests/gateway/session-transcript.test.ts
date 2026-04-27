import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionTranscriptManager } from "../../packages/gateway/src/session-transcript.js";

describe("session-transcript", () => {
  let homePath: string;
  let ticks: string[];

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-session-transcript-"));
    ticks = [
      "2026-04-26T00:00:00.000Z",
      "2026-04-26T00:00:01.000Z",
      "2026-04-26T00:00:02.000Z",
      "2026-04-26T00:00:03.000Z",
      "2026-04-26T00:00:04.000Z",
    ];
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  function now() {
    return ticks.shift() ?? "2026-04-26T00:00:05.000Z";
  }

  it("appends durable JSONL entries and returns bounded hot replay by sequence", async () => {
    const manager = createSessionTranscriptManager({ homePath, now });

    await expect(manager.append("sess_abc123", "first\n")).resolves.toMatchObject({ ok: true, seq: 0 });
    await expect(manager.append("sess_abc123", "second\n")).resolves.toMatchObject({ ok: true, seq: 1 });

    const replay = await manager.getHotReplay("sess_abc123", { fromSeq: 1 });

    expect(replay).toMatchObject({
      ok: true,
      fromSeq: 1,
      toSeq: 2,
      truncated: false,
      entries: [
        { seq: 1, data: "second\n", timestamp: "2026-04-26T00:00:01.000Z" },
      ],
    });
    const path = join(homePath, "system", "session-output", "sess_abc123.jsonl");
    const lines = (await readFile(path, "utf-8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ seq: 0, sessionId: "sess_abc123", data: "first\n" });
  });

  it("caps hot replay by line count and byte count while preserving durable history", async () => {
    const manager = createSessionTranscriptManager({
      homePath,
      now,
      hotLineLimit: 3,
      hotByteLimit: 9,
    });

    await manager.append("sess_abc123", "1111");
    await manager.append("sess_abc123", "2222");
    await manager.append("sess_abc123", "3333");
    await manager.append("sess_abc123", "4444");

    const replay = await manager.getHotReplay("sess_abc123");

    expect(replay).toMatchObject({
      ok: true,
      truncated: true,
      entries: [
        { seq: 2, data: "3333" },
        { seq: 3, data: "4444" },
      ],
    });
    expect((await readFile(join(homePath, "system", "session-output", "sess_abc123.jsonl"), "utf-8")).trim().split("\n")).toHaveLength(4);
  });

  it("rehydrates hot replay from durable JSONL after manager restart", async () => {
    const first = createSessionTranscriptManager({ homePath, now, hotLineLimit: 2 });
    await first.append("sess_abc123", "one");
    await first.append("sess_abc123", "two");
    await first.append("sess_abc123", "three");

    const second = createSessionTranscriptManager({ homePath, now, hotLineLimit: 2 });
    const result = await second.rehydrate("sess_abc123");

    expect(result).toEqual({ ok: true, entriesLoaded: 3, hotEntries: 2, nextSeq: 3, truncated: true });
    await expect(second.append("sess_abc123", "four")).resolves.toMatchObject({ ok: true, seq: 3 });
    await expect(second.getHotReplay("sess_abc123")).resolves.toMatchObject({
      ok: true,
      entries: [
        { seq: 2, data: "three" },
        { seq: 3, data: "four" },
      ],
    });
  });

  it("exports transcript metadata without reading or copying unrelated sessions", async () => {
    const manager = createSessionTranscriptManager({ homePath, now });
    await manager.append("sess_abc123", "owned");
    await manager.append("sess_other", "other");

    const manifest = await manager.exportTranscript("sess_abc123");

    expect(manifest).toMatchObject({
      ok: true,
      sessionId: "sess_abc123",
      relativePath: "system/session-output/sess_abc123.jsonl",
      entries: 1,
    });
    expect(manifest.bytes).toBeGreaterThan(0);
  });

  it("applies retention by age first and then total byte budget with truncation markers", async () => {
    const manager = createSessionTranscriptManager({
      homePath,
      now,
      retentionDays: 30,
      retentionBytes: 240,
    });
    await manager.append("sess_old", "old-output");
    await manager.append("sess_big_a", "a".repeat(80));
    await manager.append("sess_big_a", "a".repeat(80));
    await manager.append("sess_big_a", "a".repeat(80));
    await manager.append("sess_big_b", "b".repeat(80));

    await writeFile(
      join(homePath, "system", "session-output", "sess_old.jsonl"),
      JSON.stringify({ seq: 0, sessionId: "sess_old", timestamp: "2026-03-01T00:00:00.000Z", data: "old-output", bytes: 10 }) + "\n",
    );

    const result = await manager.applyRetention({ now: "2026-04-26T00:00:00.000Z" });

    expect(result.deleted).toContain("system/session-output/sess_old.jsonl");
    expect(result.truncated.length).toBeGreaterThan(0);
    await expect(stat(join(homePath, "system", "session-output", "sess_old.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
    const remainingBytes = await manager.totalTranscriptBytes();
    expect(remainingBytes).toBeLessThanOrEqual(240);
  });

  it("rejects invalid session identifiers before touching the filesystem", async () => {
    const manager = createSessionTranscriptManager({ homePath, now });

    await expect(manager.append("../bad", "data")).resolves.toMatchObject({
      ok: false,
      status: 400,
      error: { code: "invalid_session_id" },
    });
    await expect(stat(join(homePath, "system"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
