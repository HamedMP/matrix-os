import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { CODEX_VERIFIED_NPM_PACKAGE } from "../../packages/contracts/src/index.js";
import { matrixTerminalShellScript } from "../../packages/gateway/src/shell/zellij-config.js";
import {
  TERMINAL_AGENT_OPTIONS,
  parseTerminalAgentStatuses,
  resolveTerminalAgentMenuState,
  terminalAgentInstallCommand,
  terminalAgentVisibleInstallCommand,
} from "../../shell/src/components/terminal/terminal-agent-options.js";

const execFileAsync = promisify(execFile);

describe("terminal agent options", () => {
  it("parses explicit install states and retains the legacy boolean during migration", () => {
    expect(parseTerminalAgentStatuses({
      agents: [
        { id: "claude", installState: "installed", installed: true },
        { id: "codex", installState: "missing", installed: false },
        { id: "opencode", installState: "unknown", installed: null },
        { id: "pi", installed: true },
        { id: "unknown", installed: true },
        null,
      ],
    })).toEqual([
      { id: "claude", installState: "installed" },
      { id: "codex", installState: "missing" },
      { id: "opencode", installState: "unknown" },
      { id: "pi", installState: "installed" },
    ]);
  });

  it("only offers installation for an explicitly missing executable", () => {
    expect(resolveTerminalAgentMenuState("installed", false, false)).toEqual({
      action: "launch",
      statusLabel: null,
    });
    expect(resolveTerminalAgentMenuState("missing", false, false)).toEqual({
      action: "install",
      statusLabel: "Install",
    });
    expect(resolveTerminalAgentMenuState("unknown", true, false)).toEqual({
      action: "launch",
      statusLabel: "Checking…",
    });
    expect(resolveTerminalAgentMenuState("unknown", false, true)).toEqual({
      action: "launch",
      statusLabel: "Status unavailable",
    });
    expect(resolveTerminalAgentMenuState("unknown", false, false)).toEqual({
      action: "launch",
      statusLabel: "Status unavailable",
    });
  });

  it("builds foreground install commands with the runtime node prefix", () => {
    const codex = TERMINAL_AGENT_OPTIONS.find((option) => option.id === "codex");
    expect(codex).toBeDefined();

    expect(terminalAgentInstallCommand(codex!)).toBe(
      `export MATRIX_NODE_PREFIX="\${MATRIX_NODE_PREFIX:-/opt/matrix/runtime/node}"; export PATH="$MATRIX_NODE_PREFIX/bin:$PATH"; npm install -g --prefix "$MATRIX_NODE_PREFIX" ${CODEX_VERIFIED_NPM_PACKAGE}`,
    );
  });

  it("launches Codex from the same Matrix runtime prefix used for verification", () => {
    const codex = TERMINAL_AGENT_OPTIONS.find((option) => option.id === "codex");

    expect(codex?.launchCommand).toBe(
      'export MATRIX_NODE_PREFIX="${MATRIX_NODE_PREFIX:-/opt/matrix/runtime/node}"; exec "$MATRIX_NODE_PREFIX/bin/codex"',
    );
    expect(codex?.launchCommand).not.toBe("codex");
  });

  it("returns visible installer sessions to the Matrix shell wrapper", () => {
    const pi = TERMINAL_AGENT_OPTIONS.find((option) => option.id === "pi");
    expect(pi).toBeDefined();

    const command = terminalAgentVisibleInstallCommand(pi!);
    expect(command).toContain("sh -lc ");
    expect(command).toContain("--ignore-scripts --prefix");
    expect(command).toContain("@earendil-works/pi-coding-agent@latest");
    expect(command).not.toContain('exec "${SHELL:-sh}" -l');
  });

  it.each([
    ["success", "0"],
    ["failure", "23"],
    ["cancellation", "130"],
  ])("hands %s install completion back to generated interactive Bash", async (_outcome, npmExitCode) => {
    const codex = TERMINAL_AGENT_OPTIONS.find((option) => option.id === "codex");
    expect(codex).toBeDefined();

    const testDir = await mkdtemp(join(tmpdir(), "matrix-agent-install-shell-"));
    const runtimeBin = join(testDir, "runtime", "bin");
    const wrapperPath = join(testDir, "matrix-terminal-shell");
    const bashrcPath = join(testDir, "bashrc");
    const promptLabelPath = join(testDir, "prompt-label.mjs");
    const tracePath = join(testDir, "shell-trace.txt");
    try {
      await writeFile(bashrcPath, "# generated test bashrc\n");
      await writeFile(promptLabelPath, "");
      await writeFile(wrapperPath, matrixTerminalShellScript(bashrcPath, promptLabelPath));
      await mkdir(runtimeBin, { recursive: true });
      await writeFile(join(runtimeBin, "npm"), `#!/bin/sh
printf 'installer-output:%s\\n' "$*"
exit "\${MATRIX_TEST_NPM_EXIT:-0}"
`);
      await writeFile(join(runtimeBin, "bash"), `#!/bin/sh
printf 'bash-args=%s\\n' "$*" >> "$MATRIX_TEST_TRACE"
printf 'bash-prompt=%s\\n' "\${MATRIX_TERMINAL_PROMPT:-}" >> "$MATRIX_TEST_TRACE"
printf 'bash-path=%s\\n' "$PATH" >> "$MATRIX_TEST_TRACE"
exit 0
`);
      await Promise.all([
        chmod(wrapperPath, 0o700),
        chmod(join(runtimeBin, "npm"), 0o700),
        chmod(join(runtimeBin, "bash"), 0o700),
      ]);

      const command = terminalAgentVisibleInstallCommand(codex!);
      const result = await execFileAsync("/bin/bash", [wrapperPath, "/bin/sh", "-c", command], {
        env: {
          ...process.env,
          MATRIX_NODE_PREFIX: join(testDir, "runtime"),
          MATRIX_TERMINAL_PROMPT: "owner-handle:\\w$ ",
          MATRIX_TEST_NPM_EXIT: npmExitCode,
          MATRIX_TEST_TRACE: tracePath,
          SHELL: join(runtimeBin, "bash"),
        },
      });
      const trace = await readFile(tracePath, "utf8");

      expect(result.stdout).toContain("installer-output:");
      expect(trace).not.toContain("bash-args=-l");
      expect(trace).toContain(`bash-args=--noprofile --rcfile ${bashrcPath} -i`);
      expect(trace).toContain("bash-prompt=owner-handle:\\w$ ");
      expect(trace).toContain(`bash-path=${runtimeBin}:`);
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });
});
