import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

describe("first-boot registration scheduling", () => {
  it("starts selected tool installers while registration waits for their readiness", () => {
    const temp = mkdtempSync(join(tmpdir(), "matrix-registration-order-"));
    try {
      const document = parse(readFileSync("distro/customer-vps/cloud-init.yaml", "utf8")) as { runcmd: string[] };
      const bootstrap = document.runcmd.find((entry) => entry.includes("log_bootstrap_phase core_services_started"));
      expect(bootstrap).toBeDefined();
      const marker = "/etc/systemd/system/matrix-vps-registration.service";
      const registrationUnit = join(temp, "registration.service");
      writeFileSync(registrationUnit, "fixture");
      const start = bootstrap!.indexOf(`if [ -f ${marker} ]; then`);
      expect(start).toBeGreaterThan(0);
      const tail = bootstrap!.slice(start).replace(marker, registrationUnit);
      const fakeSystemctl = join(temp, "systemctl");
      writeFileSync(fakeSystemctl, `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$MATRIX_BOOT_TEST_CALLS"
case "$*" in
  *matrix-vps-registration.service*)
    # The real oneshot defers until selected installers have settled.
    case "$*" in
      *--no-block*) exit 0 ;;
      *--now*|start*) [ -f "$MATRIX_BOOT_TEST_TOOLS" ] || exit 75 ;;
    esac ;;
  start*matrix-developer-tools.service*) touch "$MATRIX_BOOT_TEST_TOOLS" ;;
esac
`);
      chmodSync(fakeSystemctl, 0o755);
      const env = {
        ...process.env,
        PATH: `${temp}:${process.env.PATH}`,
        MATRIX_BOOT_TEST_CALLS: join(temp, "calls"),
        MATRIX_BOOT_TEST_TOOLS: join(temp, "tools-settled"),
      };
      const boot = spawnSync("bash", ["-eu", "-c", `log_bootstrap_phase() { :; }\n${tail}`], { env, encoding: "utf8", timeout: 5_000 });
      expect(boot.status, boot.stderr).toBe(0);
      const calls = readFileSync(env.MATRIX_BOOT_TEST_CALLS, "utf8");
      expect(calls).toContain("start --no-block matrix-developer-tools.service");
      const retry = spawnSync("bash", [fakeSystemctl, "start", "matrix-vps-registration.service"], { env, encoding: "utf8", timeout: 5_000 });
      expect(retry.status, retry.stderr).toBe(0);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
