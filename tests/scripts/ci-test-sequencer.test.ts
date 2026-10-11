import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { BaseSequencer, type TestSpecification, type Vitest } from "vitest/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { balanceTestFiles, DurationSequencer, testWorkers } from "../../scripts/ci/test-sequencer";

const root = "/repo";
const spec = (name: string) => ({ moduleId: path.join(root, name), project: { name: "unit" }, pool: "forks" }) as TestSpecification;
const names = (files: TestSpecification[]) => files.map((file) => path.relative(root, file.moduleId));
const files = ["a", "b", "c", "d", "e", "new"].map((n) => spec(`tests/${n}.test.ts`));
const durations = { "tests/a.test.ts": 100, "tests/b.test.ts": 90, "tests/c.test.ts": 80, "tests/d.test.ts": 10, "tests/e.test.ts": 10 };
const profileRoots: string[] = [];
beforeEach(() => {
  for (const key of ["CI", "MATRIX_TEST_BENCHMARK", "MATRIX_TEST_PROFILE_SORT"]) vi.stubEnv(key, undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(profileRoots.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function profiledSequencer() {
  const directory = await mkdtemp(path.join(tmpdir(), "matrix-test-sequencer-"));
  profileRoots.push(directory);
  await mkdir(path.join(directory, "scripts/ci"), { recursive: true });
  await writeFile(path.join(directory, "scripts/ci/test-durations.json"), JSON.stringify({ version: 1, durationsMs: durations }));
  const collected = files.map(file => ({ ...file, moduleId: path.join(directory, path.relative(root, file.moduleId)) })) as TestSpecification[];
  const seq = new DurationSequencer({ config: { root: directory } } as Vitest);
  return { directory, collected, seq };
}

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

describe("opt-in unsharded profile scheduling", () => {
  it.each([
    [undefined, undefined, undefined],
    ["1", undefined, undefined],
    ["1", "false", undefined],
    ["true", "true", undefined],
    [undefined, "true", undefined],
    [undefined, undefined, "1"],
  ])("keeps Vitest sorting with profile flag=%s, CI=%s, benchmark=%s", async (flag, ci, benchmark) => {
    vi.stubEnv("MATRIX_TEST_PROFILE_SORT", flag);
    vi.stubEnv("CI", ci);
    vi.stubEnv("MATRIX_TEST_BENCHMARK", benchmark);
    const { collected, seq } = await profiledSequencer();
    const baseSort = vi.spyOn(BaseSequencer.prototype, "sort").mockResolvedValue(collected);
    expect(await seq.sort(collected)).toEqual(collected);
    expect(baseSort).toHaveBeenCalledWith(collected);
  });

  it.each([
    ["true", undefined], ["1", undefined], [undefined, "1"],
  ])("loads the real profile and schedules longest first for CI=%s, benchmark=%s", async (ci, benchmark) => {
    vi.stubEnv("MATRIX_TEST_PROFILE_SORT", "1");
    vi.stubEnv("CI", ci);
    vi.stubEnv("MATRIX_TEST_BENCHMARK", benchmark);
    const { directory, collected, seq } = await profiledSequencer();
    const baseSort = vi.spyOn(BaseSequencer.prototype, "sort").mockResolvedValue(collected);
    expect(await seq.shard(collected)).toBe(collected);
    const ordered = await seq.sort([...collected].reverse());
    expect(ordered.map(file => path.relative(directory, file.moduleId))).toEqual([
      "tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts", "tests/new.test.ts", "tests/d.test.ts", "tests/e.test.ts",
    ]);
    expect(new Set(ordered)).toEqual(new Set(collected));
    expect(baseSort).not.toHaveBeenCalled();
  });

  it("retains each project/pool/declaration identity and breaks duration ties deterministically", async () => {
    vi.stubEnv("MATRIX_TEST_PROFILE_SORT", "1");
    vi.stubEnv("MATRIX_TEST_BENCHMARK", "1");
    const { collected, seq } = await profiledSequencer();
    const original = collected[2];
    const alpha = { ...original, project: { name: "alpha" } } as TestSpecification;
    const threads = { ...original, pool: "threads" } as TestSpecification;
    const line1 = { ...original, testLines: [1] } as TestSpecification;
    const line2 = { ...original, testLines: [2] } as TestSpecification;
    const declarations = [threads, line2, alpha, original, line1];
    const expected = [alpha, original, line1, line2, threads];
    expect(await seq.sort(declarations)).toEqual(expected);
    expect(await seq.sort([...declarations].reverse())).toEqual(expected);
  });

  it("leaves shard assignment and complete coverage unchanged when the opt-in is enabled", async () => {
    vi.stubEnv("MATRIX_TEST_PROFILE_SORT", "1");
    vi.stubEnv("CI", "true");
    const { directory, collected } = await profiledSequencer();
    const expected = balanceTestFiles(collected, 3, durations, directory);
    const selected = await Promise.all(expected.map(async (bucket, index) => {
      const seq = new DurationSequencer({ config: { root: directory, shard: { index: index + 1, count: 3 } } } as Vitest);
      const shard = await seq.shard([...collected].reverse());
      expect(shard).toEqual(bucket);
      expect(await seq.sort(shard)).toEqual(bucket);
      return shard;
    }));
    expect(selected.flat()).toHaveLength(collected.length);
    expect(new Set(selected.flat())).toEqual(new Set(collected));
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
