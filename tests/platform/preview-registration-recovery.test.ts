import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("stops retrying registration when the operator verifies the running machine", () => {
  const source = readFileSync("distro/customer-vps/host-bin/matrix-register-vps", "utf8");
  const retryLoop = source.slice(
    source.indexOf('for attempt in $(seq 1 "$MAX_ATTEMPTS")'),
    source.indexOf('echo "matrix-register-vps: transient registration retry budget exhausted"'),
  );

  expect(retryLoop).toContain('[ ! -f "$REGISTER_FLAG" ] || exit 0');
});

it.each(["valid", "wrong-machine", "wrong-version", "wrong-server", "symlink"])("repairs only a verified Preview registration: %s", scenario => {
  const root = mkdtempSync(join(tmpdir(), "preview-registration-test-"));
  try {
    mkdirSync(join(root, "env")); mkdirSync(join(root, "app"));
    writeFileSync(join(root, "env/host.env"), 'MATRIX_HANDLE=pr-1479\nMATRIX_MACHINE_ID=machine_expected\n');
    writeFileSync(join(root, "app/BUNDLE_VERSION"), "v2026.09.06-test\n");
    if (scenario === "symlink") symlinkSync(join(root, "app/BUNDLE_VERSION"), join(root, "register-complete"));
    const args = [root, "pr-1479", scenario === "wrong-machine" ? "machine_other" : "machine_expected", scenario === "wrong-version" ? "v2026.09.05-test" : "v2026.09.06-test", "203.0.113.1", scenario === "wrong-server" ? "203.0.113.2" : "203.0.113.1"];
    const result = spawnSync("python3", ["-c", `import runpy,sys,pathlib\nm=runpy.run_path(sys.argv[1],run_name="fixture")\nm["recover"](pathlib.Path(sys.argv[2]),*sys.argv[3:])`, resolve("scripts/preview-registration-recovery.py"), ...args], { encoding: "utf8" });
    if (scenario === "valid") {
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(root, "register-complete"), "utf8")).toContain("machine_expected");
    } else {
      expect(result.status).not.toBe(0);
      if (scenario !== "symlink") expect(existsSync(join(root, "register-complete"))).toBe(false);
      expect(readFileSync(join(root, "app/BUNDLE_VERSION"), "utf8")).toBe("v2026.09.06-test\n");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
