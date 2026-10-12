import { closeSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { MAX_PROFILE_FILES, validateDurations } from "./test-profile.mjs";

type Durations = Record<string, number>;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const filename = (spec: TestSpecification, root: string) => path.relative(root, spec.moduleId).split(path.sep).join("/");
const identity = (spec: TestSpecification, root: string) => `${filename(spec, root)}:${spec.project.name}:${spec.pool}:${spec.testLines?.join(",") ?? ""}`;

export function testWorkers(env: Record<string, string | undefined> = process.env): number {
  if (!["true", "1"].includes(env.CI ?? "") && env.MATRIX_TEST_BENCHMARK !== "1") return 2;
  const workers = env.MATRIX_TEST_WORKERS;
  if (workers === undefined) return 2;
  if (!/^(?:[1-9]|1[0-6])$/.test(workers)) throw new Error("MATRIX_TEST_WORKERS must be an integer from 1 to 16");
  return Number(workers);
}

function ranked(files: TestSpecification[], durations: Durations, root: string) {
  const values = Object.values(durations).sort((a, b) => a - b);
  const midpoint = Math.floor(values.length / 2);
  const fallback = values.length ? (values.length % 2 ? values[midpoint] : (values[midpoint - 1] + values[midpoint]) / 2) : 1000;
  return files.map((file) => ({ file, duration: durations[filename(file, root)] ?? fallback, id: identity(file, root) }))
    .sort((a, b) => b.duration - a.duration || compare(a.id, b.id));
}

/** Longest-processing-time greedy assignment. Every collected spec is retained. */
export function balanceTestFiles(files: TestSpecification[], count: number, durations: Durations, root: string): TestSpecification[][] {
  if (!Number.isInteger(count) || count < 1 || count > 64) throw new Error("shard count must be an integer from 1 to 64");
  if (files.length > MAX_PROFILE_FILES) throw new Error("collected tests exceed profile file limit");
  const buckets: TestSpecification[][] = Array.from({ length: count }, () => []);
  const loads = Array.from({ length: count }, () => 0);
  for (const { file, duration } of ranked(files, durations, root)) {
    let target = 0;
    for (let index = 1; index < count; index++) if (loads[index] < loads[target]) target = index;
    buckets[target].push(file);
    loads[target] += duration;
  }
  return buckets;
}

export class DurationSequencer extends BaseSequencer {
  private durations: Durations | undefined;

  private profile(): Durations {
    if (this.durations !== undefined) return this.durations;
    const file = path.join(this.ctx.config.root, "scripts/ci/test-durations.json");
    try {
      // Avoid buffering arbitrarily large manifests, while keeping local/shardless runs untouched.
      const descriptor = openSync(file, "r");
      try {
        const buffer = Buffer.alloc(8 * 1024 * 1024 + 1);
        let length = 0;
        while (length < buffer.length) {
          const bytesRead = readSync(descriptor, buffer, length, buffer.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length === buffer.length) throw new Error("duration manifest exceeds size limit");
        this.durations = validateDurations(JSON.parse(buffer.subarray(0, length).toString("utf8")));
      } finally { closeSync(descriptor); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("invalid CI duration manifest");
      this.durations = {};
    }
    return this.durations;
  }

  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard;
    if (!shard) return files;
    if (!Number.isInteger(shard.index) || shard.index < 1 || shard.index > shard.count) throw new Error("invalid shard index");
    return balanceTestFiles(files, shard.count, this.profile(), this.ctx.config.root)[shard.index - 1];
  }

  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const profileSort = process.env.MATRIX_TEST_PROFILE_SORT === "1"
      && (["true", "1"].includes(process.env.CI ?? "") || process.env.MATRIX_TEST_BENCHMARK === "1");
    if (!this.ctx.config.shard && !profileSort) return super.sort(files);
    return ranked(files, this.profile(), this.ctx.config.root).map(({ file }) => file);
  }
}
