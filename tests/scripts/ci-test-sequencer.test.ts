import path from "node:path";
import { BaseSequencer, type TestSpecification, type Vitest } from "vitest/node";
import { describe, expect, it, vi } from "vitest";
import { balanceTestFiles, DurationSequencer, testWorkers } from "../../scripts/ci/test-sequencer";

const root = "/repo";
const spec = (name: string) => ({ moduleId: path.join(root, name), project: { name: "unit" }, pool: "forks" }) as TestSpecification;
const names = (files: TestSpecification[]) => files.map((file) => path.relative(root, file.moduleId));
const files = ["a", "b", "c", "d", "e", "new"].map((n) => spec(`tests/${n}.test.ts`));
const durations = { "tests/a.test.ts": 100, "tests/b.test.ts": 90, "tests/c.test.ts": 80, "tests/d.test.ts": 10, "tests/e.test.ts": 10 };

describe("duration-balanced CI shards", () => {
  it("assigns every collected file once, including files absent from the profile", () => {
    const shards = balanceTestFiles(files, 3, durations, root);
    expect(shards.flat()).toHaveLength(files.length);
    expect(new Set(shards.flat())).toEqual(new Set(files));
    expect(shards.flat()).toContain(files[5]);
  });
  it("uses median estimated cost for unknown tests and balances heavy suites", () => {
    const shards = balanceTestFiles(files, 3, durations, root);
    const loads = shards.map((shard) => names(shard).reduce((sum, name) => sum + (durations[name as keyof typeof durations] ?? 80), 0));
    expect(loads).toEqual([110, 100, 160]);
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThan(80);
  });
  it("is deterministic across collection order, including equal durations", () => {
    const expected = balanceTestFiles(files, 4, durations, root).map(names);
    expect(balanceTestFiles([...files].reverse(), 4, durations, root).map(names)).toEqual(expected);
  });
  it("includes small collections when shards outnumber files", () => {
    expect(balanceTestFiles(files.slice(0, 2), 4, {}, root).map(names)).toEqual([["tests/a.test.ts"], ["tests/b.test.ts"], [], []]);
  });
  it.each([0, -1, 1.5, 65, NaN])("rejects invalid shard counts %s", (count) => {
    expect(() => balanceTestFiles(files, count, {}, root)).toThrow(/shard count/);
  });
  it("wires shard selection through the real sequencer with a missing profile fallback", async () => {
    const seq = new DurationSequencer({ config: { root, shard: { index: 2, count: 3 } } } as Vitest);
    expect(await seq.shard(files)).toEqual(balanceTestFiles(files, 3, {}, root)[1]);
    expect(await seq.sort([...files].reverse())).toEqual(files);
  });
  it("rejects an invalid shard index", async () => {
    const seq = new DurationSequencer({ config: { root, shard: { index: 0, count: 3 } } } as Vitest);
    await expect(seq.shard(files)).rejects.toThrow(/shard index/);
  });
  it("preserves Vitest local sorting when no shard is requested", async () => {
    const localSort = vi.spyOn(BaseSequencer.prototype, "sort").mockResolvedValue(files);
    const seq = new DurationSequencer({ config: { root } } as Vitest);
    expect(await seq.sort(files)).toEqual(files);
    expect(localSort).toHaveBeenCalledWith(files);
    localSort.mockRestore();
  });
});

describe("bounded CI/benchmark workers", () => {
  it("retains local defaults even if a CI worker variable is present", () => {
    expect(testWorkers({ MATRIX_TEST_WORKERS: "16" })).toBe(2);
  });
  it.each(["1", "2", "8", "16"])("accepts %s workers for CI and explicit benchmarks", (workers) => {
    expect(testWorkers({ CI: "true", MATRIX_TEST_WORKERS: workers })).toBe(Number(workers));
    expect(testWorkers({ MATRIX_TEST_BENCHMARK: "1", MATRIX_TEST_WORKERS: workers })).toBe(Number(workers));
  });
  it("keeps the current CI default", () => expect(testWorkers({ CI: "true" })).toBe(2));
  it.each(["0", "17", "1.5", "-1", "NaN", "", "2x", " 2"])("fails on invalid worker override %j", (workers) => {
    expect(() => testWorkers({ CI: "true", MATRIX_TEST_WORKERS: workers })).toThrow(/MATRIX_TEST_WORKERS/);
  });
});
