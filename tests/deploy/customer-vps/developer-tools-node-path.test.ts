import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Found on a self-hosted Ubuntu install: the Codex CLI starts with
// `#!/usr/bin/env node`, and the unit had no bundled Node on PATH, so the
// post-install version check failed and the unit restarted forever.
// Managed VPSes hid this behind /usr/local/bin/node symlinks from cloud-init.
const unit = readFileSync("distro/customer-vps/systemd/matrix-developer-tools.service", "utf8");
const NODE_BIN = "/opt/matrix/runtime/node/bin";
const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function unitPath(): string {
  const line = unit.split("\n").find((entry) => entry.startsWith("Environment=PATH="));
  if (!line) throw new Error("matrix-developer-tools.service sets no PATH");
  return line.slice("Environment=PATH=".length);
}

describe("matrix-developer-tools.service PATH", () => {
  it("puts the bundled Node first and keeps the system directories", () => {
    const entries = unitPath().split(":");
    expect(entries[0]).toBe(NODE_BIN);
    for (const dir of ["/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"]) expect(entries).toContain(dir);
  });

  it("lets an npm CLI with an env-node shebang run without a system Node", () => {
    const prefix = mkdtempSync(join(tmpdir(), "matrix-developer-tools-path-"));
    temporary.push(prefix);
    mkdirSync(join(prefix, "bin"));
    writeFileSync(join(prefix, "bin/node"), "#!/bin/sh\nprintf 'codex-cli 0.162.1\\n'\n", { mode: 0o755 });
    writeFileSync(join(prefix, "bin/codex"), "#!/usr/bin/env node\n", { mode: 0o755 });
    // Only the unit's directories (bundled Node pointed at the fixture) are searched.
    const path = unitPath().split(":").map((dir) => (dir === NODE_BIN ? join(prefix, "bin") : join(prefix, "empty", dir))).join(":");
    const result = spawnSync(join(prefix, "bin/codex"), ["--version"], { encoding: "utf8", env: { PATH: path } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("codex-cli 0.162.1");
  });
});
