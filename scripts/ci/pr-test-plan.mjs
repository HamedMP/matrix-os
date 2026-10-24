// PR test planning. Main, merge-queue and manual runs stay full; ordinary PRs run the unit tests
// their change can reach and skip E2E when the change cannot affect the shell, desktop or runtime.
import { pathToFileURL } from "node:url";

const MODULE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u;

// Inputs the import graph cannot see or that change how every test runs.
const FULL_UNIT_PATHS = [
  /(?:^|\/)package\.json$/u,
  /^pnpm-lock\.yaml$/u,
  /^pnpm-workspace\.yaml$/u,
  /(?:^|\/)tsconfig[^/]*\.json$/u,
  /(?:^|\/)vitest[^/]*\.config\.[^/]+$/u,
  /(?:^|\/)vite\.config\.[^/]+$/u,
  /^tests\/setup/u,
  /^scripts\/ci\/test-sequencer\.ts$/u,
  /^scripts\/ci\/pr-test-plan\.mjs$/u,
  /^scripts\/ci\/unit-test-selection\.mjs$/u,
  /^\.github\/workflows\/ci\.yml$/u,
];

// Tests import these packages through built dist output, so Vitest maps their
// importers to dist files rather than to the changed sources.
const DIST_PACKAGES = ["packages/kernel/", "packages/observability/", "packages/terminal-runtime/"];

// Non-module files here (SQL, JSON, CSS, templates) are loaded by product code at runtime.
const SOURCE_TREES = ["packages/", "shell/", "desktop/", "home/", "apps/"];

// Changes confined to these paths cannot affect the shell, desktop or runtime under E2E.
const E2E_UNRELATED = [
  ".github/",
  "scripts/ci/",
  "scripts/spikes/",
  "scripts/ops/",
  "apps/mobile/",
  "distro/",
  ".agents/",
  ".claude/",
];

export function isDocsPath(path) {
  return path.startsWith("docs/") || path.startsWith("specs/") || path.endsWith(".md");
}

function requiresFullUnit(path) {
  if (FULL_UNIT_PATHS.some((pattern) => pattern.test(path))) return true;
  if (DIST_PACKAGES.some((prefix) => path.startsWith(prefix))) return true;
  return !MODULE_FILE.test(path) && SOURCE_TREES.some((prefix) => path.startsWith(prefix));
}

function requiresE2e(path) {
  if (path === ".github/workflows/ci.yml") return true;
  if (path.startsWith("tests/")) return path.startsWith("tests/e2e/") || path.startsWith("tests/fixtures/");
  return !E2E_UNRELATED.some((prefix) => path.startsWith(prefix));
}

export function planPrTests(paths) {
  const code = paths.filter((path) => path && !isDocsPath(path));
  return {
    unitScope: code.some(requiresFullUnit) ? "full" : "affected",
    e2eTests: code.some(requiresE2e),
  };
}

async function readStandardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = (await readStandardInput()).split(/\r?\n/u).map((path) => path.trim()).filter(Boolean);
  const plan = planPrTests(paths);
  process.stdout.write(`unit_scope=${plan.unitScope}\ne2e_tests=${plan.e2eTests}\n`);
}
