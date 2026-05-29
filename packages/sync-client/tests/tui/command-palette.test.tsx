import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { DEFAULT_TUI_ACTIONS, type TuiAction } from "../../src/cli/tui/actions.js";
import { searchTuiActions } from "../../src/cli/tui/palette.js";
import { CommandPalette } from "../../src/cli/tui/views/CommandPalette.js";

describe("command palette", () => {
  it("searches by title, group, alias, and intent", () => {
    expect(searchTuiActions(DEFAULT_TUI_ACTIONS, "zellij").map((action) => action.id)).toContain("shell.sessions");
    expect(searchTuiActions(DEFAULT_TUI_ACTIONS, "greptile").map((action) => action.id)).toContain("reviews.open");
    expect(searchTuiActions(DEFAULT_TUI_ACTIONS, "workspace data").map((action) => action.id)).toContain("workspace.deleteData");
    expect(searchTuiActions(DEFAULT_TUI_ACTIONS, "login").map((action) => action.id)).toContain("account.login");
  });

  it("renders filtered commands with the selected row highlighted", () => {
    const results = searchTuiActions(DEFAULT_TUI_ACTIONS, "session", 8);
    const output = renderToString(<CommandPalette results={results} query="session" selectedIndex={1} noColor />);

    expect(output).toContain("MATRIX COMMANDS");
    expect(output).toContain("> Open shell sessions");
    expect(output).toContain("Shell and Remote Run");
    expect(output).toContain("attach to a session");
  });

  it("keeps no-color palette readable without ANSI escapes", () => {
    const results = searchTuiActions(DEFAULT_TUI_ACTIONS, "doctor", 8);
    const output = renderToString(<CommandPalette results={results} query="doctor" selectedIndex={0} noColor />);

    expect(output).toContain("/doctor");
    expect(output).toContain("> Run doctor");
    expect(output).not.toContain("\u001B[");
  });

  it("caps palette width to the terminal columns", () => {
    const results = searchTuiActions(DEFAULT_TUI_ACTIONS, "session", 8);
    const output = renderToString(<CommandPalette results={results} query="session" selectedIndex={0} columns={32} noColor />);

    for (const line of output.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(32);
    }
  });

  it("uses narrower title padding in compact palettes", () => {
    const compactAction: TuiAction = {
      id: "test.open",
      title: "Open",
      group: "Utility",
      aliases: ["open"],
      intents: ["open command"],
      danger: "none",
      handler: "view",
    };

    const output = renderToString(<CommandPalette results={[compactAction]} query="open" selectedIndex={0} columns={32} noColor />);

    expect(output).toContain("> Open          Utility");
  });
});
