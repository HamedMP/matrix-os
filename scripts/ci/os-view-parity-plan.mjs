import { pathToFileURL } from "node:url";

const SHARED_SURFACE_PREFIXES = [
  "shell/src/",
  "desktop/src/renderer/src/",
  "packages/brand/",
  "packages/ui/",
  "packages/contracts/",
];

const GATEWAY_SURFACE_PREFIXES = [
  "packages/gateway/src/chat/",
  "packages/gateway/src/os-view-state/",
  "packages/gateway/src/routes/settings",
  "packages/gateway/src/terminal/",
];

const PARITY_TEST_PREFIXES = [
  "tests/fixtures/os-view-parity.ts",
  "tests/shell/desktop-mode-parity.test.ts",
  "tests/shell/desktop-launcher-mode.test.tsx",
  "tests/shell/web-desktop-surface.test.tsx",
  "tests/desktop/app-launcher.test.tsx",
  "tests/desktop/native-desktop-shell.test.tsx",
];

const PARITY_GATE_PATHS = [
  ".github/workflows/ci.yml",
  "scripts/ci/os-view-parity-plan.mjs",
  "tests/scripts/os-view-parity-plan.test.ts",
];

export function requiresOsViewParityChecks(paths) {
  return paths.some((path) => [...SHARED_SURFACE_PREFIXES, ...GATEWAY_SURFACE_PREFIXES, ...PARITY_TEST_PREFIXES, ...PARITY_GATE_PATHS]
    .some((prefix) => path.startsWith(prefix)));
}

async function readStandardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = (await readStandardInput())
    .split(/\r?\n/u)
    .map((path) => path.trim())
    .filter(Boolean);
  process.stdout.write(requiresOsViewParityChecks(paths) ? "true\n" : "false\n");
}
