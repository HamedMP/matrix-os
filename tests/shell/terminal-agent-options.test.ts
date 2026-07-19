import { describe, expect, it } from "vitest";
import { CODEX_VERIFIED_NPM_PACKAGE } from "../../packages/contracts/src/index.js";
import {
  TERMINAL_AGENT_OPTIONS,
  parseTerminalAgentStatuses,
  resolveTerminalAgentMenuState,
  terminalAgentInstallCommand,
  terminalAgentVisibleInstallCommand,
} from "../../shell/src/components/terminal/terminal-agent-options.js";

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

  it("preserves agent-specific install flags in visible installer sessions", () => {
    const pi = TERMINAL_AGENT_OPTIONS.find((option) => option.id === "pi");
    expect(pi).toBeDefined();

    const command = terminalAgentVisibleInstallCommand(pi!);
    expect(command).toContain("sh -lc ");
    expect(command).toContain("--ignore-scripts --prefix");
    expect(command).toContain("@earendil-works/pi-coding-agent@latest");
    expect(command).toContain('exec "${SHELL:-sh}" -l');
  });
});
