import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

// Spec 2707: an owned computer whose owner turned off automatic security updates
// keeps polling and preparing updates but never auto-applies them; an explicit
// update still applies.
const library = resolve("distro/customer-vps/host-bin/matrix-update-manifest");
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "matrix-auto-update-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function poll(optedOut: boolean) {
  if (optedOut) writeFileSync(join(dir, "auto-updates-disabled"), "off\n");
  return spawnSync("bash", ["-c", `set -euo pipefail
UPDATE_TRIGGER="$1/trigger"
UPDATE_MARKER="$1/marker"
UPDATE_ERROR_MARKER="$1/error"
AUTO_APPLY_FAILED_MARKER="$1/failed"
source "$2"
log() { printf '%s\\n' "$*"; }
manifest_url() { printf 'https://platform.example/stable.json'; }
curl() { printf '{"version":"2026.12.01","severity":"security","updateType":"auto"}'; }
json_field() { case "$2" in version) printf '2026.12.01' ;; severity) printf 'security' ;; updateType) printf 'auto' ;; esac; }
current_version() { printf '2026.11.22'; }
compare_host_bundle_versions() { printf 'newer'; }
write_prepared_update_marker() { : > "$UPDATE_MARKER"; }
TEST_DIR="$1"
run_apply_update() { : > "$TEST_DIR/applied"; }
check_for_update`, "test", dir, library], {
    encoding: "utf8", timeout: 10_000,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", MATRIX_AUTO_UPDATES_DISABLED_MARKER: join(dir, "auto-updates-disabled") },
  });
}

it("auto-applies a security release when automatic updates are on", () => {
  const result = poll(false);
  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(join(dir, "applied"))).toBe(true);
});

it("prepares but does not auto-apply a security release when the owner turned automatic updates off", () => {
  const result = poll(true);
  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(join(dir, "marker"))).toBe(true);
  expect(existsSync(join(dir, "applied"))).toBe(false);
  expect(result.stdout).toContain("Automatic updates are off");
});

it("reads the opt-out from the same file matrix-connect writes, outside root-only /etc/matrix", async () => {
  const { readFileSync } = await import("node:fs");
  const updater = readFileSync(library, "utf8");
  const connector = readFileSync(resolve("distro/customer-vps/host-bin/matrix-connect.mjs"), "utf8");
  expect(updater).toContain("${MATRIX_AUTO_UPDATES_DISABLED_MARKER:-/opt/matrix/env/auto-updates-disabled}");
  expect(connector).toContain("autoUpdatesDisabled: join(envDir, 'auto-updates-disabled')");
  expect(connector).toContain("envDir = env.MATRIX_CONNECT_ENV_DIR ?? '/opt/matrix/env'");
});
