import {
  buildTerminalControlSequence,
  formatTerminalCwd,
  initialTerminalState,
  MAX_TERMINAL_INPUT_CHARS,
  MAX_TERMINAL_OUTPUT_CHARS,
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
    expect(state.lastSeq).toBeNull();
  });

  it("accumulates replay output and tracks the next replay cursor", () => {
    const attached = terminalReducer(initialTerminalState, {
      type: "terminal.attached",
      sessionId: "c4319d6a-a24c-4820-a0f8-f6f8a6ce76b9",
      cwd: "/home/matrix/home/projects",
    });
    const withFirstReplayFrame = terminalReducer(attached, {
      type: "terminal.output",
      data: "first\n",
      seq: 4,
    });
    const withSecondReplayFrame = terminalReducer(withFirstReplayFrame, {
      type: "terminal.output",
      data: "second\n",
      seq: 5,
    });
    const replayComplete = terminalReducer(withSecondReplayFrame, {
      type: "terminal.replayFinished",
      toSeq: 6,
    });

    expect(replayComplete.output).toBe("first\nsecond\n");
    expect(replayComplete.lastSeq).toBe(5);
    expect(replayComplete.nextSeq).toBe(6);
  });

  it("records terminal exit codes from normalized gateway exit frames", () => {
    const state = terminalReducer(initialTerminalState, {
      type: "terminal.ended",
      exitCode: 7,
    });

    expect(state.status).toBe("ended");
    expect(state.exitCode).toBe(7);
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

  it("formats common home paths compactly for narrow phones", () => {
    expect(formatTerminalCwd("/home/matrix/home/projects")).toBe("~/projects");
    expect(formatTerminalCwd("/home/deploy/matrix-os")).toBe("~/matrix-os");
    expect(formatTerminalCwd("/")).toBe("~");
  });
});
