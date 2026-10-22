import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { CODEX_VERIFIED_VERSION } from "../../../packages/contracts/src/index.js";

const source = readFileSync("distro/customer-vps/host-bin/matrix-install-developer-tools", "utf8");
const minimum = source.match(/^CODEX_VERSION="([0-9]+\.[0-9]+\.[0-9]+)"$/m)?.[1];
if (!minimum) throw new Error("Missing Codex minimum version");
const temporary: string[] = [];
const functionSource = (name: string) => {
  const definition = source.match(new RegExp(`${name}\\(\\) \\{[\\s\\S]*?\\n\\}`))?.[0];
  if (!definition) throw new Error(`Missing installer function ${name}`);
  return definition;
};
const definitions = ["tool_bin_name", "codex_version_is_current", "claude_version_is_current", "is_tool_installed"]
  .map(functionSource).join("\n");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function fixture(output: string, options: { marked?: boolean; exitCode?: number; executable?: boolean } = {}) {
  const prefix = mkdtempSync(join(tmpdir(), "matrix-developer-tools-minimum-"));
  temporary.push(prefix);
  mkdirSync(join(prefix, "bin"));
  writeFileSync(join(prefix, "bin/codex"), `#!/bin/sh\n[ "\${1:-}" = --version ] || exit 64\nprintf '%s\\n' ${quote(output)}\nexit ${options.exitCode ?? 0}\n`, { mode: options.executable === false ? 0o644 : 0o755 });
  if (options.marked) writeFileSync(join(prefix, "installed-tools"), "codex\n");
  const run = (body = "is_tool_installed codex") => spawnSync("bash", ["-c", [
    "NODE_PREFIX=\"$1\"", "INSTALLED_FILE=\"$1/installed-tools\"", `CODEX_VERSION=${quote(minimum)}`,
    "CLAUDE_CODE_VERSION=2.1.280", definitions, body,
  ].join("\n"), "bash", prefix], { encoding: "utf8", timeout: 5_000 });
  return { prefix, run };
}

function installFixture(output: string, exitCode = 0) {
  const { prefix, run } = fixture(output, { exitCode });
  renameSync(join(prefix, "bin/codex"), join(prefix, "prepared-codex"));
  writeFileSync(join(prefix, "installed-tools"), "");
  const loop = source.match(/failed=0\nfor tool in \$TOOLS; do[\s\S]*?\ndone/)?.[0];
  const exitCheck = source.match(/if \[ "\$failed" -ne 0 \]; then\n  exit 1\nfi/)?.[0];
  if (!loop || !exitCheck) throw new Error("Missing installer loop or retry exit");
  const result = run([
    "set -euo pipefail", "STATE_DIR=\"$NODE_PREFIX\"", "FAILED_FILE=\"$STATE_DIR/failed-tools\"", "TOOLS=codex",
    ": > \"$FAILED_FILE\"", "log() { :; }", "link_tool() { touch \"$STATE_DIR/linked\"; }",
    "successful_tool_pack() { cp \"$NODE_PREFIX/prepared-codex\" \"$NODE_PREFIX/bin/codex\"; touch \"$STATE_DIR/pack-ran\"; }",
    loop.replace("/opt/matrix/bin/matrix-install-tool-pack", "successful_tool_pack"), exitCheck,
  ].join("\n"));
  return { prefix, result };
}
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("managed Codex minimum version during optional tool provisioning", () => {
  it("uses the qualified contract version for fresh installations and the minimum check", () => {
    expect(CODEX_VERIFIED_VERSION).toBe("0.162.1");
    expect(minimum).toBe(CODEX_VERIFIED_VERSION);
    const toolPack = readFileSync("distro/customer-vps/host-bin/matrix-install-tool-pack", "utf8");
    const pin = toolPack.match(/^CODEX_VERSION="([0-9]+\.[0-9]+\.[0-9]+)"$/m)?.[1];
    expect(pin).toBe(CODEX_VERIFIED_VERSION);
    const install = toolPack.match(/install_codex_package\(\) \{[\s\S]*?\n\}/)?.[0];
    expect(install).toBeDefined();
    const result = spawnSync("bash", ["-c", [
      `CODEX_VERSION=${quote(pin!)}`, "NODE_PREFIX=/synthetic/node",
      "run_npm_install() { printf '%s\\n' \"$@\"; }", install!, "install_codex_package",
    ].join("\n")], { encoding: "utf8", timeout: 5_000 });
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(["install", "-g", "--prefix", "/synthetic/node", "@openai/codex@0.162.1"]);
  });
  it.each(["0.162.1", "0.162.2", "0.163.0", "1.0.0"])("preserves healthy %s without an installed-tools marker", version => {
    expect(fixture(`codex-cli ${version}`).run().status).toBe(0);
  });
  it("preserves a healthy newer version with an existing marker", () => {
    expect(fixture("codex-cli 0.162.2", { marked: true }).run().status).toBe(0);
  });
  it.each(["0.156.1", "0.156.2", "0.161.99", "0.162.0", "0.99.99"])("still repairs older %s even with a marker", version => {
    expect(fixture(`codex-cli ${version}`, { marked: true }).run().status).toBe(1);
    expect(fixture(`codex-cli ${version}`).run().status).toBe(1);
  });
  it.each(["codex-cli 0.162.1-beta.1", "error: codex-cli 0.162.1", "codex-cli broken", "codex-cli 0.162.1.4"])("refuses unverified version output %s", output => {
    expect(fixture(output, { marked: true }).run().status).toBe(1);
  });
  it("does not trust a failed version command or a nonexecutable CLI", () => {
    expect(fixture("codex-cli 0.162.1", { marked: true, exitCode: 1 }).run().status).toBe(1);
    expect(fixture("codex-cli 0.162.1", { marked: true, executable: false }).run().status).toBe(1);
  });
  it("records the healthy manually installed Codex when skipping installation", () => {
    const { prefix, run } = fixture("codex-cli 0.162.1");
    writeFileSync(join(prefix, "installed-tools"), "");
    const skip = source.match(/  if is_tool_installed "\$tool"; then[\s\S]*?\n  fi/)?.[0];
    if (!skip) throw new Error("Missing skip path");
    const result = run(`log() { :; }\nfor tool in codex; do\n${skip}\ndone`);
    expect(result.status).toBe(0);
    expect(readFileSync(join(prefix, "installed-tools"), "utf8")).toBe("codex\n");
  });
  it.each([
    ["codex-cli 0.156.1", 0], ["codex-cli broken", 0], ["codex-cli 0.162.1", 1],
  ] as const)("retries successful package installation with unusable CLI %s (exit %s)", (output, exitCode) => {
    const { prefix, result } = installFixture(output, exitCode);
    expect(existsSync(join(prefix, "pack-ran"))).toBe(true);
    expect(result.status).toBe(1);
    expect(readFileSync(join(prefix, "failed-tools"), "utf8")).toBe("codex\n");
    expect(readFileSync(join(prefix, "installed-tools"), "utf8")).toBe("");
    expect(existsSync(join(prefix, "linked"))).toBe(false);
  });
  it.each(["0.162.1", "0.162.2"])("records verified successful %s installation", version => {
    const { prefix, result } = installFixture(`codex-cli ${version}`);
    expect(existsSync(join(prefix, "pack-ran"))).toBe(true);
    expect(result.status).toBe(0);
    expect(readFileSync(join(prefix, "failed-tools"), "utf8")).toBe("");
    expect(readFileSync(join(prefix, "installed-tools"), "utf8")).toBe("codex\n");
    expect(existsSync(join(prefix, "linked"))).toBe(true);
  });
});
