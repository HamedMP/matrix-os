import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createCronStore, type CronStore } from "../../../packages/gateway/src/cron/store.js";
import type { CronJob } from "../../../packages/gateway/src/cron/types.js";

function tmpHome(): string {
  const dir = resolve(mkdtempSync(join(tmpdir(), "cron-store-")));
  mkdirSync(join(dir, "system"), { recursive: true });
  return dir;
}

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: `cron_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: "test-job",
    message: "Hello from cron",
    schedule: { type: "interval", intervalMs: 60000 },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("T120b: Cron store", () => {
  let homePath: string;
  let store: CronStore;

  beforeEach(() => {
    homePath = tmpHome();
    store = createCronStore(join(homePath, "system", "cron.json"));
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("returns empty array when file missing", () => {
    expect(store.load()).toEqual([]);
  });

  it("reads jobs from cron.json", () => {
    const jobs = [makeJob({ id: "j1", name: "water" })];
    writeFileSync(
      join(homePath, "system", "cron.json"),
      JSON.stringify(jobs),
    );
    expect(store.load()).toHaveLength(1);
    expect(store.load()[0].name).toBe("water");
  });

  it("returns empty on corrupt file", () => {
    writeFileSync(join(homePath, "system", "cron.json"), "not json {{");
    expect(store.load()).toEqual([]);
  });

  it("saves jobs to cron.json", () => {
    const jobs = [makeJob({ id: "j1" }), makeJob({ id: "j2" })];
    store.save(jobs);
    const raw = JSON.parse(readFileSync(join(homePath, "system", "cron.json"), "utf-8"));
    expect(raw).toHaveLength(2);
  });

  it("adds a job and persists", () => {
    const job = makeJob({ id: "j1", name: "stretch" });
    store.add(job);
    const loaded = store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe("stretch");
  });

  it("removes a job by id and persists", () => {
    store.add(makeJob({ id: "j1" }));
    store.add(makeJob({ id: "j2" }));
    expect(store.remove("j1")).toBe(true);
    expect(store.load()).toHaveLength(1);
    expect(store.load()[0].id).toBe("j2");
  });

  it("returns false when removing nonexistent job", () => {
    expect(store.remove("nonexistent")).toBe(false);
  });

  it("list() returns current jobs", () => {
    store.add(makeJob({ id: "j1" }));
    store.add(makeJob({ id: "j2" }));
    expect(store.list()).toHaveLength(2);
  });

  it("deduplicates by id on add", () => {
    const job = makeJob({ id: "j1", name: "v1" });
    store.add(job);
    store.add({ ...job, name: "v2" });
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].name).toBe("v2");
  });
});
