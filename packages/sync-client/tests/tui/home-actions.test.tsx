import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { HomeView } from "../../src/cli/tui/views/HomeView.js";
import { healthyTuiSnapshot } from "./test-utils.js";

describe("home quick actions", () => {
  it.each([60, 80, 100])("renders selectable quick actions at %i columns", (columns) => {
    const output = renderToString(<HomeView snapshot={healthyTuiSnapshot} columns={columns} selectedQuickActionIndex={1} noColor />);

    expect(output).toContain("Quick actions");
    expect(output).toContain("[n] New shell session");
    expect(output).toContain("> [s] Open shell sessions");
    expect(output).toContain("[a] Setup coding agents");
    expect(output).toContain("[d] Run doctor");
    expect(output).toContain("[l] Log in");
  });
});
