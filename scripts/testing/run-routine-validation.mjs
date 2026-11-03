/** Required built-process lane. A missing backend, no assertions or skips is failure. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const [directory, mode] = process.argv.slice(2);
if (!directory || !["--disk-pglite", "--postgres"].includes(mode)) {
  throw new Error("Usage: run-routine-validation.mjs <built-artifact-directory> --disk-pglite|--postgres");
}
const root = process.cwd(), artifact = resolve(directory);
if (artifact === root || artifact.startsWith(`${root}/`)) throw new Error("Keep qualification evidence outside the checkout");
const env = Object.fromEntries(["PATH", "TMPDIR"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
Object.assign(env, { NODE_OPTIONS: "--max-old-space-size=768", CI: "1", NO_COLOR: "1", TZ: "UTC",
  OTEL_SDK_DISABLED: "true", POSTHOG_DISABLED: "true", MATRIX_ROUTINE_PROCESS_BUILD: artifact });
let secretUrl;
if (mode === "--postgres") {
  secretUrl = process.env.MATRIX_TEST_POSTGRES_URL;
  if (!secretUrl) throw new Error("Dedicated MATRIX_TEST_POSTGRES_URL required; no fallback");
  const url = new URL(secretUrl);
  if (url.hostname !== "127.0.0.1" || !url.pathname.includes("test")) throw new Error("Dedicated loopback test database required");
  env.MATRIX_TEST_POSTGRES_URL = secretUrl;
} else env.MATRIX_ROUTINE_PGLITE_TEST = "1";
const run = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const out = resolve(artifact, "runs", run);
await mkdir(out, { recursive: true });
const resultPath = resolve(out, "result.json");
const args = [resolve(root, "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.routine-process.config.ts",
  "--maxWorkers=1", "--no-file-parallelism", "--no-cache", "--reporter=default", "--reporter=json", `--outputFile.json=${resultPath}`];
const redact = value => {
  if (!secretUrl) return String(value);
  const result = String(value).replaceAll(secretUrl, "<dedicated-test-db>");
  const password = new URL(secretUrl).password;
  return password ? result.replaceAll(password, "<redacted>") : result;
};
let log = "", code = 0;
const start = performance.now();
try { log = execFileSync(process.execPath, args, { cwd: root, env, encoding: "utf8", timeout: 300000, maxBuffer: 8 * 1024 * 1024 }); }
catch (error) { code = Number.isInteger(error.status) ? error.status : 1; log = `${error.stdout ?? ""}\n${error.stderr ?? ""}`; }
await writeFile(resolve(out, "run.log"), redact(log), { flag: "wx" });
let result;
try {
  const text = redact(await readFile(resultPath, "utf8"));
  await writeFile(resultPath, text);
  result = JSON.parse(text);
}
catch (error) { if (error.code !== "ENOENT") throw error; }
const qualified = code === 0 && result?.success === true && result.numPassedTests === 4
  && result.numTotalTests === 4 && result.numFailedTests === 0 && result.numPendingTests === 0;
await writeFile(resolve(out, "receipt.json"), JSON.stringify({
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), mode,
  seconds: (performance.now() - start) / 1000, exit: code, qualified,
  tests: result ? { total: result.numTotalTests, passed: result.numPassedTests, failed: result.numFailedTests, skipped: result.numPendingTests } : null,
}, null, 2), { flag: "wx" });
console.log(JSON.stringify({ qualified, evidence: out }));
if (!qualified) process.exitCode = 1;
