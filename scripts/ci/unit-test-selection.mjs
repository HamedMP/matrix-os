// Selects the unit tests a PR can affect: Vitest's import graph from the changed files, plus test
// files that name a changed path, because contract tests read workflows, scripts and fixtures by path.
// Usage: node scripts/ci/unit-test-selection.mjs <base-ref> <output-file>
// Writes the selected files one per line and sets `list` when selection succeeds. Any failure
// leaves `list` unset, so the caller runs the full suite.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { isDocsPath } from "./pr-test-plan.mjs";

const MODULE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u;
const UNIT_TEST_FILE = /^tests\/(?!e2e\/).+\.test\.tsx?$/u;
const LIST_TIMEOUT_MS = 8 * 60 * 1000;
export const NO_TESTS_FILTER = "tests/.no-affected-unit-tests";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  return result;
}

export function mentionPatterns(changedPaths) {
  const patterns = new Set();
  for (const path of changedPaths) {
    patterns.add(path);
    // Directory scans (workflow inventories, host-bin, fixtures) name the folder, not the file.
    if (!MODULE_FILE.test(path) && dirname(path) !== ".") patterns.add(dirname(path));
  }
  return [...patterns];
}

function testsMentioning(patterns) {
  if (!patterns.length) return [];
  const args = ["grep", "-l", "-F", ...patterns.flatMap((pattern) => ["-e", pattern]), "--", "tests/"];
  const result = run("git", args);
  // git grep exits 1 when nothing matches.
  if (result.status !== 0 && result.status !== 1) throw new Error(`git grep failed: ${result.stderr}`);
  return result.stdout.split("\n").filter(Boolean);
}

function testsReachableFrom(base, root) {
  const dir = mkdtempSync(join(tmpdir(), "unit-selection-"));
  const output = join(dir, "list.json");
  try {
    const result = run("pnpm", ["exec", "vitest", "list", "--changed", base, "--filesOnly", `--json=${output}`], {
      cwd: root,
      timeout: LIST_TIMEOUT_MS,
      stdio: ["ignore", "ignore", "inherit"],
      // The full module graph exceeds Node's default heap.
      env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=8192`.trim() },
    });
    if (result.status !== 0) throw new Error(`vitest list exited ${result.status}`);
    return JSON.parse(readFileSync(output, "utf8")).map((entry) => relative(root, entry.file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function selectUnitTests({ base, root = process.cwd() }) {
  const diff = run("git", ["diff", "--name-only", "--no-renames", base, "HEAD"], { cwd: root });
  if (diff.status !== 0) throw new Error(`git diff failed: ${diff.stderr}`);
  const changed = diff.stdout.split("\n").filter((path) => path && !isDocsPath(path));
  const selected = new Set([...testsReachableFrom(base, root), ...testsMentioning(mentionPatterns(changed))]);
  return [...selected].filter((file) => UNIT_TEST_FILE.test(file)).sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, outputFile] = process.argv.slice(2);
  if (!base || !outputFile) {
    console.error("Usage: unit-test-selection.mjs <base-ref> <output-file>");
    process.exit(64);
  }
  try {
    const files = selectUnitTests({ base });
    // An empty filter list would run every test, so an empty selection gets a filter that matches nothing.
    writeFileSync(outputFile, `${(files.length ? files : [NO_TESTS_FILTER]).join("\n")}\n`);
    console.log(`Selected ${files.length} unit test files affected by this change.`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `list=${outputFile}\ncount=${files.length}\n`);
  } catch (error) {
    console.log(`::warning::Affected-test selection failed; running the full unit suite. ${error instanceof Error ? error.message : error}`);
  }
}
