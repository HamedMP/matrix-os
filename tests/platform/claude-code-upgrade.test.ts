import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const root = process.cwd();
const toolPack = readFileSync(join(root, "distro/customer-vps/host-bin/matrix-install-tool-pack"), "utf8");
const developerTools = readFileSync(join(root, "distro/customer-vps/host-bin/matrix-install-developer-tools"), "utf8");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Claude Code host upgrade", () => {
  it("pins the CLI that can discover Opus 5.5 and checks installed versions on service restart", () => {
    expect(toolPack).toContain('CLAUDE_CODE_VERSION="2.1.280"');
    expect(toolPack).toContain('"@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"');
    expect(developerTools).toContain('CLAUDE_CODE_VERSION="2.1.280"');
    expect(developerTools).toContain('if [ "$tool" = "claude-code" ]; then\n    [ -x "$NODE_PREFIX/bin/claude" ] && claude_version_is_current');
    expect(developerTools).toContain('if [ "$tool" = "claude-code" ] && ! claude_version_is_current; then');
  });

  it.each([
    ["2.1.251 (Claude Code)", false],
    ["2.1.279 (Claude Code)", false],
    ["2.1.280 (Claude Code)", true],
    ["2.1.281 (Claude Code)", true],
    ["3.0.0 (Claude Code)", true],
    ["unexpected version", false],
  ])("treats installed %s as current: %s", (output, expected) => {
    const functionSource = developerTools.match(/claude_version_is_current\(\) \{[\s\S]*?\n\}/)?.[0];
    expect(functionSource).toBeDefined();
    const prefix = mkdtempSync(join(tmpdir(), "matrix-claude-version-"));
    tempDirs.push(prefix);
    mkdirSync(join(prefix, "bin"));
    const executable = join(prefix, "bin", "claude");
    writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, { mode: 0o755 });
    const result = spawnSync("bash", ["-c", `NODE_PREFIX="$1"\nCLAUDE_CODE_VERSION=2.1.280\n${functionSource}\nclaude_version_is_current`, "bash", prefix], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(expected ? 0 : 1);
  });

  it.each([
    ["2.1.251 (Claude Code)", false],
    ["2.1.281 (Claude Code)", true],
  ])("recognizes an unmarked managed-prefix install at %s: %s", (output, expected) => {
    const versionFunction = developerTools.match(/claude_version_is_current\(\) \{[\s\S]*?\n\}/)?.[0];
    const installedFunction = developerTools.match(/is_tool_installed\(\) \{[\s\S]*?\n\}/)?.[0];
    expect(versionFunction).toBeDefined();
    expect(installedFunction).toBeDefined();
    const prefix = mkdtempSync(join(tmpdir(), "matrix-claude-version-"));
    tempDirs.push(prefix);
    mkdirSync(join(prefix, "bin"));
    writeFileSync(join(prefix, "bin", "claude"), `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, { mode: 0o755 });
    const script = `NODE_PREFIX="$1"\nINSTALLED_FILE="$1/installed-tools"\nCLAUDE_CODE_VERSION=2.1.280\ntool_bin_name() { printf 'claude\\n'; }\n${versionFunction}\n${installedFunction}\nis_tool_installed claude-code`;
    const result = spawnSync("bash", ["-c", script, "bash", prefix], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(expected ? 0 : 1);
  });
});
