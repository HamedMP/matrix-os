import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// This diagnostic uses only disposable CI units, never the real Matrix services.
// macOS/local runs and container workers without a manager explicitly skip it.
const realCiManager = process.env.GITHUB_ACTIONS === "true"
  && process.platform === "linux" && existsSync("/run/systemd/system");

describe("Browser lifecycle systemd ordering", () => {
  it.skipIf(!realCiManager)("allows the active oneshot to synchronously restart its ordered Gateway", () => {
    const prefix = `matrix-ci-browser-ordering-${randomBytes(6).toString("hex")}`;
    const gateway = `${prefix}-gateway.service`;
    const shell = `${prefix}-shell.service`;
    const lifecycle = `${prefix}-lifecycle.service`;
    const units = [lifecycle, gateway, shell];
    const run = (args: string[], timeout = 5_000) => spawnSync("sudo", ["-n", ...args], {
      encoding: "utf8", timeout, maxBuffer: 16_384,
    });
    const checked = (args: string[], timeout?: number) => {
      const result = run(args, timeout);
      expect(result.status, result.error?.message ?? result.stderr).toBe(0);
      return result.stdout.trim();
    };
    const unit = readFileSync("distro/customer-vps/systemd/matrix-browser-runtime.service", "utf8");
    const after = [...unit.matchAll(/^After=(.+)$/gm)].flatMap(match => match[1].split(/\s+/));
    expect(unit).toMatch(/^Type=oneshot$/m);
    // Keep the diagnostic tied to the production ordering, not a guessed graph.
    expect(after).toContain("matrix-gateway.service");
    expect(after).toContain("matrix-shell.service");
    const mapped = after.filter(name => name !== "network-online.target").map(name => {
      if (name === "matrix-gateway.service") return gateway;
      if (name === "matrix-shell.service") return shell;
      throw new Error("Unreviewed Browser ordering dependency");
    });
    try {
      const version = checked(["/usr/bin/systemctl", "show", "--property=Version", "--value"]);
      console.info("[browser-ordering] CI systemd version", version);
      for (const name of [gateway, shell]) checked([
        "/usr/bin/systemd-run", "--quiet", "--collect", `--unit=${name}`,
        "--property=Type=exec", "--", "/usr/bin/sleep", "30",
      ]);
      checked([
        "/usr/bin/systemd-run", "--quiet", "--wait", "--collect", `--unit=${lifecycle}`,
        "--property=Type=oneshot", `--property=After=${mapped.join(" ")}`,
        "--property=TimeoutStartSec=10s", "--", "/usr/bin/timeout", "8s",
        "/usr/bin/systemctl", "restart", gateway,
      ], 15_000);
      expect(checked(["/usr/bin/systemctl", "is-active", gateway])).toBe("active");
    } finally {
      // --collect may have already removed the completed oneshot; systemctl
      // still stops the remaining named units when another name is absent.
      const cleanup = run(["/usr/bin/systemctl", "stop", ...units], 5_000);
      expect([0, 5], cleanup.error?.message ?? cleanup.stderr).toContain(cleanup.status);
    }
  }, 30_000);
});
