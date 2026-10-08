import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      writeFileSync(registrationUnit, readFileSync("distro/customer-vps/systemd/matrix-vps-registration.service", "utf8"));
      const registerPath = join(temp, "register-vps");
      // Relocate only the host filesystem paths; execute the real readiness and HTTP logic.
      writeFileSync(registerPath, readFileSync("distro/customer-vps/host-bin/matrix-register-vps", "utf8")
        .replaceAll("/var/lib/matrix-developer-tools", temp)
        .replaceAll("/opt/matrix/runtime/node/bin", temp));
      writeFileSync(join(temp, "curl"), `#!/usr/bin/env bash
set -eu
case "$*" in
  *vps/register*) printf 'POST\\n' >> "$MATRIX_BOOT_TEST_POSTS"; printf '200' ;;
  *instance-id*) printf '123456' ;;
  *public-ipv4*) printf '203.0.113.10' ;;
  *health*) exit 0 ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
      writeFileSync(join(temp, "date"), `#!/usr/bin/env bash
if [ "\${1:-}" = '--date' ]; then printf '4102444800\\n'; else /bin/date "$@"; fi
`, { mode: 0o755 });
      const start = bootstrap!.indexOf(`if [ -f ${marker} ]; then`);
      expect(start).toBeGreaterThan(0);
      const tail = bootstrap!.slice(start).replace(marker, registrationUnit);
      const fakeSystemctl = join(temp, "systemctl");
      writeFileSync(fakeSystemctl, `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$MATRIX_BOOT_TEST_CALLS"
run_registration() {
  status=0
  bash "$MATRIX_BOOT_TEST_REGISTER" || status=$?
  printf '%s\\n' "$status" >> "$MATRIX_BOOT_TEST_ATTEMPTS"
  return "$status"
}
case "$*" in
  *matrix-vps-registration.service*)
    case "$*" in
      *--no-block*)
        if run_registration; then exit 0; else status=$?; fi
        # Model the actual unit policy, advancing its retry timer at installer settlement.
        restart=$(sed -n 's/^Restart=//p' "$MATRIX_BOOT_TEST_UNIT")
        success=$(sed -n 's/^SuccessExitStatus=//p' "$MATRIX_BOOT_TEST_UNIT")
        case " $success " in *" $status "*) exit 0 ;; esac
        if [ "$restart" = on-failure ]; then touch "$MATRIX_BOOT_TEST_PENDING"; fi
        exit 0 ;;
      *--now*|start*) run_registration ;;
    esac ;;
  start*matrix-developer-tools.service*)
    printf 'pi\\n' > "$MATRIX_BOOT_TEST_ROOT/installed-tools"
    printf '#!/usr/bin/env bash\\nexit 0\\n' > "$MATRIX_BOOT_TEST_ROOT/pi"
    chmod 755 "$MATRIX_BOOT_TEST_ROOT/pi"
    if [ -f "$MATRIX_BOOT_TEST_PENDING" ]; then
      rm "$MATRIX_BOOT_TEST_PENDING"
      run_registration
    fi ;;
esac
`);
      chmodSync(fakeSystemctl, 0o755);
      const env = {
        ...process.env,
        PATH: `${temp}:${process.env.PATH}`,
        MATRIX_BOOT_TEST_CALLS: join(temp, "calls"),
        MATRIX_BOOT_TEST_ROOT: temp,
        MATRIX_BOOT_TEST_REGISTER: registerPath,
        MATRIX_BOOT_TEST_UNIT: registrationUnit,
        MATRIX_BOOT_TEST_PENDING: join(temp, "retry-pending"),
        MATRIX_BOOT_TEST_ATTEMPTS: join(temp, "registration-attempts"),
        MATRIX_BOOT_TEST_POSTS: join(temp, "registration-posts"),
        MATRIX_MACHINE_ID: "1d4848b6-b0f8-449c-8bf2-267ee9ae3ed1",
        MATRIX_IMAGE_VERSION: "test-version",
        MATRIX_AUTH_TOKEN: "test-runtime-token",
        MATRIX_DEVELOPER_TOOLS: "pi",
        MATRIX_PLATFORM_REGISTER_URL: "https://platform.example.test/vps/register",
        MATRIX_REGISTRATION_TOKEN: "test-registration-token",
        MATRIX_REGISTRATION_TOKEN_EXPIRES_AT: "2099-01-01T00:00:00.000Z",
        MATRIX_REGISTRATION_MAX_ATTEMPTS: "1",
        MATRIX_REGISTER_FLAG: join(temp, "registered"),
        MATRIX_REGISTER_LOCK: join(temp, "registration.lock"),
      };
      const boot = spawnSync("bash", ["-eu", "-c", `log_bootstrap_phase() { :; }\n${tail}`], { env, encoding: "utf8", timeout: 10_000 });
      expect(boot.status, boot.stderr).toBe(0);
      const calls = readFileSync(env.MATRIX_BOOT_TEST_CALLS, "utf8");
      expect(calls).toContain("start --no-block matrix-developer-tools.service");
      expect(readFileSync(env.MATRIX_BOOT_TEST_ATTEMPTS, "utf8")).toBe("75\n0\n");
      expect(readFileSync(env.MATRIX_BOOT_TEST_POSTS, "utf8")).toBe("POST\n");
      expect(existsSync(env.MATRIX_REGISTER_FLAG)).toBe(true);
      expect(existsSync(env.MATRIX_BOOT_TEST_PENDING)).toBe(false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
