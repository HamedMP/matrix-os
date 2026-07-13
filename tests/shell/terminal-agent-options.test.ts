import { describe, expect, it } from "vitest";
import {
  TERMINAL_AGENT_OPTIONS,
  parseTerminalAgentStatuses,
  terminalAgentInstallCommand,
  terminalAgentVisibleInstallCommand,
} from "../../shell/src/components/terminal/terminal-agent-options.js";

describe("terminal agent options", () => {
  it("parses only allowlisted agent install statuses", () => {
    expect(parseTerminalAgentStatuses({
      agents: [
        { id: "claude", installed: true },
        { id: "codex", installed: false },
        { id: "unknown", installed: true },
        { id: "pi", installed: "yes" },
        null,
      ],
    })).toEqual([
      { id: "claude", installed: true },
      { id: "codex", installed: false },
    ]);
  });

  it("builds foreground install commands with the runtime node prefix", () => {
    const codex = TERMINAL_AGENT_OPTIONS.find((option) => option.id === "codex");
    expect(codex).toBeDefined();

    expect(terminalAgentInstallCommand(codex!)).toBe(
      'export MATRIX_NODE_PREFIX="${MATRIX_NODE_PREFIX:-/opt/matrix/runtime/node}"; npm install -g --prefix "$MATRIX_NODE_PREFIX" @openai/codex@latest',
    );
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
