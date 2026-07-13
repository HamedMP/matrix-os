import {
  buildTerminalControlSequence,
  formatTerminalCwd,
  initialTerminalState,
  MAX_TERMINAL_INPUT_CHARS,
  MAX_TERMINAL_OUTPUT_CHARS,
  parseShellSessions,
  stripTerminalControlSequences,
  terminalReducer,
} from "../lib/terminal-state";

describe("mobile terminal state", () => {
  it("tracks attached sessions without hiding the current working directory", () => {
    const state = terminalReducer(initialTerminalState, {
      type: "terminal.attached",
      sessionId: "c4319d6a-a24c-4820-a0f8-f6f8a6ce76b9",
      cwd: "/home/matrix/home/projects/matrix-os",
      replay: "$ pwd\n/home/matrix/home/projects/matrix-os\n",
    });

    expect(state.status).toBe("attached");
    expect(state.activeSessionId).toBe("c4319d6a-a24c-4820-a0f8-f6f8a6ce76b9");
    expect(state.cwd).toBe("~/projects/matrix-os");
    expect(state.output).toContain("$ pwd");
  });

  it("caps terminal output and command input for mobile memory safety", () => {
    const largeOutput = "x".repeat(MAX_TERMINAL_OUTPUT_CHARS + 20);
    const largeInput = "y".repeat(MAX_TERMINAL_INPUT_CHARS + 20);

    const withOutput = terminalReducer(initialTerminalState, {
      type: "terminal.output",
      data: largeOutput,
    });
    const withInput = terminalReducer(withOutput, {
      type: "terminal.input",
      input: largeInput,
    });

    expect(withInput.output).toHaveLength(MAX_TERMINAL_OUTPUT_CHARS);
    expect(withInput.input).toHaveLength(MAX_TERMINAL_INPUT_CHARS);
  });

  it("keeps control keys explicit for touch terminal use", () => {
    expect(buildTerminalControlSequence("escape")).toBe("\x1b");
    expect(buildTerminalControlSequence("tab")).toBe("\t");
    expect(buildTerminalControlSequence("enter")).toBe("\r");
    expect(buildTerminalControlSequence("arrow-up")).toBe("\x1b[A");
    expect(buildTerminalControlSequence("arrow-down")).toBe("\x1b[B");
    expect(buildTerminalControlSequence("arrow-left")).toBe("\x1b[D");
    expect(buildTerminalControlSequence("arrow-right")).toBe("\x1b[C");
    expect(buildTerminalControlSequence("ctrl-c")).toBe("\x03");
    expect(buildTerminalControlSequence("ctrl-d")).toBe("\x04");
    expect(buildTerminalControlSequence("ctrl-l")).toBe("\x0c");
    // Extended ctrl combos for the redesigned touch keyboard
    expect(buildTerminalControlSequence("ctrl-a")).toBe("\x01");
    expect(buildTerminalControlSequence("ctrl-e")).toBe("\x05");
    expect(buildTerminalControlSequence("ctrl-k")).toBe("\x0b");
    expect(buildTerminalControlSequence("ctrl-r")).toBe("\x12");
    expect(buildTerminalControlSequence("ctrl-t")).toBe("\x14");
    expect(buildTerminalControlSequence("ctrl-u")).toBe("\x15");
    expect(buildTerminalControlSequence("ctrl-w")).toBe("\x17");
    expect(buildTerminalControlSequence("ctrl-y")).toBe("\x19");
    expect(buildTerminalControlSequence("ctrl-z")).toBe("\x1a");
  });

  it("strips ANSI/OSC control sequences so they don't print before the prompt", () => {
    const ESC = String.fromCharCode(27);
    const BEL = String.fromCharCode(7);
    const BS = String.fromCharCode(8);
    const raw = `${ESC}[?2004h${ESC}]0;user@host:~/projects${BEL}${ESC}[1;32m~/projects/matrix-os${ESC}[0m $ `;
    expect(stripTerminalControlSequences(raw)).toBe("~/projects/matrix-os $ ");
    expect(stripTerminalControlSequences(`a${BS}b\tc\nd`)).toBe("ab\tc\nd");
  });

  it("strips control sequences from streamed output and replay", () => {
    const ESC = String.fromCharCode(27);
    const streamed = terminalReducer(initialTerminalState, {
      type: "terminal.output",
      data: `${ESC}[2J${ESC}[H$ ls`,
    });
    expect(streamed.output).toBe("$ ls");
    const replayed = terminalReducer(initialTerminalState, {
      type: "terminal.attached",
      sessionId: "c4319d6a-a24c-4820-a0f8-f6f8a6ce76b9",
      cwd: "/home/matrix/home/projects/matrix-os",
      replay: `${ESC}[0m$ pwd`,
    });
    expect(replayed.output).toBe("$ pwd");
  });

  it("sanitizes raw terminal errors before they reach the screen", () => {
    const state = terminalReducer(initialTerminalState, {
      type: "terminal.error",
      message: "postgres secret leaked from /home/matrix/internal",
    });

    expect(state.error).toBe("Terminal unavailable");
  });

  it("preserves terminal errors across immediate socket close callbacks", () => {
    const errored = terminalReducer(initialTerminalState, {
      type: "terminal.error",
      message: "Terminal unavailable",
    });
    const closed = terminalReducer(errored, {
      type: "connection.changed",
      status: "detached",
    });

    expect(closed.status).toBe("detached");
    expect(closed.error).toBe("Terminal unavailable");
  });

  it("clears the active terminal session when refreshed sessions no longer include it", () => {
    const attached = terminalReducer(initialTerminalState, {
      type: "terminal.attached",
      sessionId: "c4319d6a-a24c-4820-a0f8-f6f8a6ce76b9",
      cwd: "/home/matrix/home",
    });
    const refreshed = terminalReducer(attached, {
      type: "sessions.loaded",
      sessions: [],
    });

    expect(refreshed.activeSessionId).toBeNull();
  });

  it("parses gateway shell sessions by name with status, clients and tabs", () => {
    const sessions = parseShellSessions([
      {
        name: "matrix-7af3c2e",
        status: "active",
        visualStatus: "waiting",
        attachedClients: 2,
        updatedAt: "2026-06-24T10:00:00Z",
        tabs: [{ idx: 0, name: "claude", focused: true }, { idx: 1 }],
      },
      { name: "INVALID NAME" }, // rejected
      { name: "main", visualStatus: "running" },
    ]);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      sessionId: "matrix-7af3c2e",
      state: "running",
      visualStatus: "waiting",
      attachedClients: 2,
    });
    expect(sessions[0]?.tabs).toEqual([{ idx: 0, name: "claude", focused: true }, { idx: 1 }]);
    expect(sessions[1]?.sessionId).toBe("main");
  });

  it("maps finished/exited shell sessions to an exited state", () => {
    const [session] = parseShellSessions([{ name: "matrix-done01", visualStatus: "finished" }]);
    expect(session?.state).toBe("exited");
  });

  it("formats common home paths compactly for narrow phones", () => {
    expect(formatTerminalCwd("/home/matrix/home/projects")).toBe("~/projects");
    expect(formatTerminalCwd("/home/deploy/matrix-os")).toBe("~/matrix-os");
    expect(formatTerminalCwd("/")).toBe("~");
  });
});
