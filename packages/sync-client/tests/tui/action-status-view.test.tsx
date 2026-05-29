import React from "react";
import { describe, expect, it } from "vitest";
import { ActionStatusView } from "../../src/cli/tui/views/ActionStatusView.js";
import { renderTui } from "./test-utils.js";

describe("ActionStatusView", () => {
  it("renders failed actions with safe message and recovery hint", () => {
    const output = renderTui(
      <ActionStatusView
        noColor
        state={{
          actionId: "status.doctor",
          status: "failed",
          message: "Request failed",
          recoveryHint: "Run doctor and try again.",
        }}
      />,
    );

    expect(output).toContain("Action: failed");
    expect(output).toContain("Request failed");
    expect(output).toContain("Run doctor and try again.");
  });
});
