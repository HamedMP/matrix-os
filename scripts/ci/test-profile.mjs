import { open, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

export const MAX_PROFILE_FILES = 10_000;
export const MAX_DURATION_MS = 3_600_000;
const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const MAX_REPORTS = 64;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export function normalizeTestPath(name, root = process.cwd()) {
  if (typeof name !== "string" || name.length > 1024 || /[\\\x00-\x1f\x7f]/.test(name)) {
    throw new Error("invalid test path");
  }
  const relative = path.isAbsolute(name) ? path.relative(root, name).split(path.sep).join("/") : name;
  if (!/^tests\/(?:[^/]+\/)*[^/]+\.test\.tsx?$/.test(relative)
    || relative.split("/").some((part) => part === "." || part === "..")
    || relative.includes(":")) {
    throw new Error("invalid test path");
  }
  return relative;
}

function durationMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_DURATION_MS) {
    throw new Error("invalid test duration");
  }
  // Clock granularity must not make a suite free in the scheduler.
  return Math.max(1, Math.round(value));
}

export function validateDurations(manifest) {
  if (!manifest || manifest.version !== 1 || !manifest.durationsMs
    || typeof manifest.durationsMs !== "object" || Array.isArray(manifest.durationsMs)) {
    throw new Error("invalid duration manifest");
  }
  const entries = Object.entries(manifest.durationsMs);
  if (entries.length > MAX_PROFILE_FILES) throw new Error("duration manifest exceeds file limit");
  return Object.fromEntries(entries.sort(([a], [b]) => compare(a, b)).map(([name, value]) => {
    if (path.isAbsolute(name)) throw new Error("invalid test path");
    return [normalizeTestPath(name), durationMs(value)];
  }));
}

export function profileReports(reports, root = process.cwd()) {
  if (!Array.isArray(reports) || reports.length > MAX_REPORTS) throw new Error("invalid report count");
  const samples = new Map(); // Bounded by MAX_PROFILE_FILES; released after this invocation.
  let sampleCount = 0;
  for (const report of reports) {
    if (!report || !Array.isArray(report.testResults) || report.testResults.length > MAX_PROFILE_FILES) {
      throw new Error("invalid Vitest report");
    }
    for (const suite of report.testResults) {
      const name = normalizeTestPath(suite.name, root);
      if (suite.startTime == null && suite.endTime == null && ["pending", "skipped"].includes(suite.status)) continue;
      if (!Number.isFinite(suite.startTime) || !Number.isFinite(suite.endTime)) throw new Error("invalid test duration");
      const value = durationMs(suite.endTime - suite.startTime);
      const values = samples.get(name) ?? [];
      if (values.length >= MAX_REPORTS) throw new Error("test sample limit exceeded");
      values.push(value);
      samples.set(name, values);
      if (samples.size > MAX_PROFILE_FILES) throw new Error("test file limit exceeded");
      sampleCount++;
    }
  }
  const durationsMs = Object.fromEntries([...samples].sort(([a], [b]) => compare(a, b)).map(([name, values]) => [name, Math.round(median(values))]));
  const entries = Object.entries(durationsMs);
  const values = entries.map(([, value]) => value);
  return {
    manifest: { version: 1, durationsMs },
    summary: {
      files: entries.length,
      samples: sampleCount,
      totalMs: values.reduce((sum, value) => sum + value, 0),
      medianMs: values.length ? median(values) : 0,
      slowest: entries.sort(([a, av], [b, bv]) => bv - av || compare(a, b)).slice(0, 20).map(([file, durationMs]) => ({ file, durationMs })),
    },
  };
}

export async function writeProfile(output, manifest) {
  const checked = { version: 1, durationsMs: validateDurations(manifest) };
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(checked, null, 2)}\n`, { flag: "wx", mode: 0o644 });
    await rename(temporary, output);
  } finally {
    try { await unlink(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

async function main(args) {
  let root = process.cwd();
  let output = path.resolve("scripts/ci/test-durations.json");
  const inputs = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--root" || arg === "--output") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error("missing option value");
      if (arg === "--root") root = path.resolve(value);
      else output = path.resolve(value);
    } else if (arg.startsWith("-")) throw new Error("unknown option");
    else inputs.push(arg);
  }
  if (!inputs.length || inputs.length > MAX_REPORTS) throw new Error("invalid report count");
  const reports = [];
  let totalBytes = 0;
  for (const input of inputs) {
    // Read at most the bounded size; reading a sparse or growing file cannot allocate without a limit.
    const handle = await open(input, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_REPORT_BYTES) throw new Error("invalid report file or size");
      const buffer = Buffer.alloc(MAX_REPORT_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_REPORT_BYTES) throw new Error("report exceeds size limit");
      totalBytes += length;
      if (totalBytes > 128 * 1024 * 1024) throw new Error("reports exceed total size limit");
      reports.push(JSON.parse(buffer.subarray(0, length).toString("utf8")));
    } finally { await handle.close(); }
  }
  const profile = profileReports(reports, root);
  await writeProfile(output, profile.manifest);
  process.stdout.write(`${JSON.stringify(profile.summary)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {
    // Inputs can contain private runner paths or diagnostics; never echo them.
    process.stderr.write("test-profile: invalid arguments, unreadable report, invalid profile data, or output write failure\n");
    process.exitCode = 1;
  });
}
